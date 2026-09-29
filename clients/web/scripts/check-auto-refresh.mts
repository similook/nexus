/**
 * Checks the subscription auto-refresh policy (src/core/useAutoRefresh.ts): one attempt per
 * launch, and exactly one retry - through the tunnel - for a subscription that got no answer.
 *
 * Plus the classification that policy depends on (fetchSubscription's `network` flag), against
 * a real local HTTP server: an error status is an answer and must not count as "no network".
 *
 *   npx tsx scripts/check-auto-refresh.mts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRefreshPolicy } from '../src/core/useAutoRefresh';
import { fetchSubscription, SubscriptionError } from '../src/core/subscription';
import type { RefreshOptions } from '../src/core/useSubscriptions';

type Outcome = 'ok' | 'network' | 'http' | 'missing';

/** A fake useSubscriptions.refresh that records every call. */
function fakeRefresh(outcomes: Record<string, Outcome>) {
  const calls: Array<{ id: string; options: RefreshOptions }> = [];
  const refresh = (id: string, options: RefreshOptions): Promise<unknown> => {
    calls.push({ id, options });
    switch (outcomes[id]) {
      case 'ok':
        return Promise.resolve({ imported: 1, failed: 0 });
      case 'network':
        return Promise.reject(new SubscriptionError('Could not reach the server: timeout', true));
      case 'http':
        return Promise.reject(new SubscriptionError('Server returned HTTP 403'));
      default:
        // The real refresh throws synchronously for an id it no longer has.
        throw new SubscriptionError('Subscription not found');
    }
  };
  return { refresh, calls };
}

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
    if (detail !== undefined) console.error(`         ${JSON.stringify(detail)}`);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// --- policy ---------------------------------------------------------------------------------

{
  const p = createRefreshPolicy();
  const launch = fakeRefresh({ a: 'ok', b: 'network', c: 'http', d: 'missing' });
  await p.launch(['a', 'b', 'c', 'd'], launch.refresh);
  check(
    'launch: every subscription once, directly, not marked busy',
    same(launch.calls, [
      { id: 'a', options: { automatic: true } },
      { id: 'b', options: { automatic: true } },
      { id: 'c', options: { automatic: true } },
      { id: 'd', options: { automatic: true } },
    ]),
    launch.calls,
  );
  check('launch: a network failure leaves a retry pending', p.phase === 'awaiting-tunnel', p.phase);

  const again = fakeRefresh({ a: 'ok', b: 'ok', c: 'ok', d: 'ok' });
  await p.launch(['a', 'b', 'c', 'd'], again.refresh);
  check('launch: a second launch pass does nothing', again.calls.length === 0, again.calls);

  const retry = fakeRefresh({ b: 'network' });
  await p.retry(retry.refresh);
  check(
    'retry: only the unreachable one, through the tunnel',
    same(retry.calls, [{ id: 'b', options: { viaTunnel: true, automatic: true } }]),
    retry.calls,
  );
  check('retry: a failed retry is final', p.phase === 'done', p.phase);

  const second = fakeRefresh({ b: 'ok' });
  await p.retry(second.refresh);
  await p.retry(second.refresh);
  check('retry: never a second retry', second.calls.length === 0, second.calls);
}

{
  const p = createRefreshPolicy();
  const launch = fakeRefresh({ a: 'ok', b: 'http' });
  await p.launch(['a', 'b'], launch.refresh);
  const retry = fakeRefresh({ a: 'ok', b: 'ok' });
  await p.retry(retry.refresh);
  check('no network failure: no retry at all', p.phase === 'done' && retry.calls.length === 0, retry.calls);
}

{
  const p = createRefreshPolicy();
  const early = fakeRefresh({ a: 'ok' });
  await p.retry(early.refresh);
  check('retry before the launch pass: nothing, and nothing spent', early.calls.length === 0 && p.phase === 'idle');

  const launch = fakeRefresh({ a: 'network' });
  await p.launch(['a'], launch.refresh);
  const retry = fakeRefresh({ a: 'ok' });
  await p.retry(retry.refresh);
  check('...the real retry still happens once afterwards', retry.calls.length === 1, retry.calls);
}

{
  // The hook calls retry() on every render while connected; two may overlap.
  const p = createRefreshPolicy();
  await p.launch(['a', 'b'], fakeRefresh({ a: 'network', b: 'network' }).refresh);
  const retry = fakeRefresh({ a: 'ok', b: 'ok' });
  await Promise.all([p.retry(retry.refresh), p.retry(retry.refresh)]);
  check('overlapping retries: one retry per subscription', same(retry.calls.map((c) => c.id), ['a', 'b']), retry.calls);
}

{
  // Connected while the launch pass is still in flight: the retry must wait for it.
  const p = createRefreshPolicy();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pending = p.launch(['a'], async () => {
    await gate;
    throw new SubscriptionError('offline', true);
  });
  const during = fakeRefresh({ a: 'ok' });
  await p.retry(during.refresh);
  check('retry while the launch pass runs: waits', during.calls.length === 0 && p.phase === 'running');
  release();
  await pending;
  const after = fakeRefresh({ a: 'ok' });
  await p.retry(after.refresh);
  check('...and runs once the pass has settled', after.calls.length === 1, after.calls);
}

{
  const p = createRefreshPolicy();
  const none = fakeRefresh({});
  await p.launch([], none.refresh);
  check('no subscriptions: no requests', none.calls.length === 0 && p.phase === 'done');
}

// --- classification, against a real server --------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === '/forbidden') {
    res.writeHead(403).end('no');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('vless://example');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function classify(url: string, viaTunnel = false): Promise<string> {
  try {
    const { body } = await fetchSubscription(url, viaTunnel);
    return `ok:${body}`;
  } catch (e) {
    if (!(e instanceof SubscriptionError)) return `other:${String(e)}`;
    return e.network ? 'network' : 'answer';
  }
}

// Capacitor's web HTTP runs on fetch; say so rather than fail if this Node lacks it.
const direct = await classify(`${base}/ok`);
if (direct === 'ok:vless://example') {
  check('fetch: a 200 is a success', true);
  check('fetch: an error status is an answer, not "no network"', (await classify(`${base}/forbidden`)) === 'answer');

  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  check('fetch: no answer at all is "no network"', (await classify(`http://127.0.0.1:${deadPort}/`)) === 'network');

  // The browser stub has no tunnel. The same URL that just answered directly must still fail:
  // a tunnel fetch never quietly goes direct.
  check('fetch: viaTunnel never falls back to direct', (await classify(`${base}/ok`, true)) === 'network');
} else {
  console.log(`  skip classification checks: Capacitor HTTP unavailable under this Node (${direct})`);
}

server.close();

if (failures > 0) {
  console.error(`\n${failures} of ${checks} auto-refresh checks failed.`);
  process.exit(1);
}
console.log(`\nall ${checks} auto-refresh checks passed`);
