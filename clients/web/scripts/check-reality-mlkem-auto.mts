/**
 * Automatic REALITY ML-KEM detection, against fakes:
 *   - the switch state it writes (src/core/realityMlkem.ts, AUTOMATIC DETECTION);
 *   - Test All's retry with the key share (src/core/serverTests.ts);
 *   - Connect's first-look check (src/core/realityMlkemCheck.ts).
 *
 *   npx --yes tsx scripts/check-reality-mlkem-auto.mts
 *
 * What must hold: the switch stays OFF until a server shows it needs the share (handshake
 * fails without it, passes with it); a verdict never overrides the user's own choice; "Handshake
 * failed" is held back while the retry runs and shown only if the retry fails too; any other
 * failure gets no retry; Connect's check decides from the pair and never hangs.
 */

// localStorage before anything that reads it.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { parseSingleConfig } = await import('../src/core/subscription');
const rm = await import('../src/core/realityMlkem');
const { ServerTestsController, configFingerprint } = await import('../src/core/serverTests');
const { checkRealityMlkem } = await import('../src/core/realityMlkemCheck');
type ServerNode = import('../src/data/servers').ServerNode;
type ServerProbeEvent = import('../src/core/plugin').ServerProbeEvent;
type ServerProbeStatus = import('../src/core/plugin').ServerProbeStatus;
type Origin = import('../src/core/realityMlkem').RealityMlkemOrigin;

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  }
}

const UUID = '11111111-2222-3333-4444-555555555555';
const PBK = 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0';
const REALITY = `security=reality&sni=www.microsoft.com&pbk=${PBK}&sid=ab&fp=chrome&flow=xtls-rprx-vision&type=tcp`;
const legacy = parseSingleConfig(`vless://${UUID}@a.example.com:443?${REALITY}#legacy`);
const second = parseSingleConfig(`vless://${UUID}@b.example.com:443?${REALITY}#second`);
const optedIn = parseSingleConfig(`vless://${UUID}@a.example.com:443?${REALITY}&support-x25519mlkem768=true#opted`);
const plain = parseSingleConfig(`vless://${UUID}@c.example.com:443?security=tls&sni=c.example.com&type=ws&path=%2Fws#tls`);
const keyOf = (node: ServerNode) => rm.realityMlkemKey(node.uri ?? '') ?? '';
const hasShare = (node: ServerNode) => node.config.includes('support_x25519mlkem768');
const NONE: ReadonlySet<string> = new Set();
const NO_ORIGINS: ReadonlyMap<string, Origin> = new Map();

// --- 1. The verdict of a pair of probes ------------------------------------------------------
{
  check('passes without the share: not needed', rm.realityMlkemVerdict('ok', null) === false);
  check('passes without it, whatever the other said', rm.realityMlkemVerdict('ok', 'handshake_failed') === false);
  check('handshake fails without, passes with: needed', rm.realityMlkemVerdict('handshake_failed', 'ok') === true);
  check('handshake fails both ways: no verdict', rm.realityMlkemVerdict('handshake_failed', 'handshake_failed') === null);
  check('handshake fails, the other not probed: no verdict', rm.realityMlkemVerdict('handshake_failed', null) === null);
  for (const status of ['timeout', 'refused', 'unreachable', 'dns_failed', 'rejected', 'config_invalid', 'failed'] as const) {
    check(`${status} without the share is no evidence, even if it passes with it`, rm.realityMlkemVerdict(status, 'ok') === null);
  }
}

// --- 2. Which nodes a check may touch ---------------------------------------------------------
{
  check('a REALITY node, never checked: checkable and unchecked', rm.realityMlkemCheckable(legacy, NONE, NO_ORIGINS) && rm.realityMlkemUnchecked(legacy, NONE, NO_ORIGINS));
  check('not REALITY: never', !rm.realityMlkemCheckable(plain, NONE, NO_ORIGINS));
  check('opted in by its link: never', !rm.realityMlkemCheckable(optedIn, NONE, NO_ORIGINS));
  check('already ON (user): never', !rm.realityMlkemCheckable(legacy, new Set([keyOf(legacy)]), NO_ORIGINS));
  const userOff = new Map<string, Origin>([[keyOf(legacy), 'user']]);
  check('turned OFF by the user: never', !rm.realityMlkemCheckable(legacy, NONE, userOff));
  const autoOff = new Map<string, Origin>([[keyOf(legacy), 'auto-off']]);
  check('auto-off: still checkable (the server may be upgraded) but not unchecked', rm.realityMlkemCheckable(legacy, NONE, autoOff) && !rm.realityMlkemUnchecked(legacy, NONE, autoOff));
  check('the variant offers the share, the node does not', hasShare(rm.realityMlkemVariant(legacy)) && !hasShare(legacy));
  check('the variant is exactly the link that opts in by itself', rm.realityMlkemVariant(legacy).config === optedIn.config);
}

// --- 3. Applying a verdict --------------------------------------------------------------------
{
  const on = rm.withRealityMlkemVerdict(NONE, NO_ORIGINS, legacy, true);
  check('needed: the key joins the switch set', on !== null && on.keys.has(keyOf(legacy)));
  check('needed: origin auto-on', on?.origins.get(keyOf(legacy)) === 'auto-on');
  check('needed: state reads "auto"', on !== null && rm.realityMlkemState(legacy, on.keys, on.origins) === 'auto');
  check('needed: without origins the same set reads plain "on" (old callers)', on !== null && rm.realityMlkemState(legacy, on.keys) === 'on');
  check('needed: the rebuilt node offers the share', on !== null && hasShare(rm.rebuildWithRealityMlkem(legacy, on.keys)));
  check('needed: other servers untouched', on !== null && !hasShare(rm.rebuildWithRealityMlkem(second, on.keys)));
  check('needed twice: no change the second time', on !== null && rm.withRealityMlkemVerdict(on.keys, on.origins, legacy, true) === null);

  const off = rm.withRealityMlkemVerdict(NONE, NO_ORIGINS, legacy, false);
  check('not needed: switch set unchanged', off !== null && off.keys.size === 0);
  check('not needed: origin auto-off, state "off"', off?.origins.get(keyOf(legacy)) === 'auto-off' && rm.realityMlkemState(legacy, off.keys, off.origins) === 'off');
  check('not needed twice: no change', off !== null && rm.withRealityMlkemVerdict(off.keys, off.origins, legacy, false) === null);
  const upgraded = off === null ? null : rm.withRealityMlkemVerdict(off.keys, off.origins, legacy, true);
  check('auto-off, then needed (server upgraded): turns on', upgraded !== null && upgraded.keys.has(keyOf(legacy)) && upgraded.origins.get(keyOf(legacy)) === 'auto-on');

  const userOff = new Map<string, Origin>([[keyOf(legacy), 'user']]);
  check('the user turned it off: a verdict changes nothing', rm.withRealityMlkemVerdict(NONE, userOff, legacy, true) === null);
  check('not REALITY: a verdict changes nothing', rm.withRealityMlkemVerdict(NONE, NO_ORIGINS, plain, true) === null);
  check('opted in by link: a verdict changes nothing', rm.withRealityMlkemVerdict(NONE, NO_ORIGINS, optedIn, false) === null);

  // The user turning an automatic ON off: off, and checks keep away from then on.
  if (on !== null) {
    const keys = rm.withRealityMlkem(on.keys, legacy, false);
    const origins = rm.withRealityMlkemUserChoice(on.origins, legacy);
    check('user turns auto-on off: allowed', keys !== null && !keys.has(keyOf(legacy)));
    check('user turns auto-on off: origin user, state off', keys !== null && origins.get(keyOf(legacy)) === 'user' && rm.realityMlkemState(legacy, keys, origins) === 'off');
    check('...and no check turns it back on', keys !== null && rm.withRealityMlkemVerdict(keys, origins, legacy, true) === null);
  }
}

// --- 4. Origins storage and edits -------------------------------------------------------------
{
  store.clear();
  check('nothing stored: empty', rm.loadRealityMlkemOrigins().size === 0);
  rm.saveRealityMlkemOrigins(new Map<string, Origin>([['a.b', 'auto-on'], ['c.d', 'user'], ['e.f', 'auto-off']]));
  const back = rm.loadRealityMlkemOrigins();
  check('round trip', back.get('a.b') === 'auto-on' && back.get('c.d') === 'user' && back.get('e.f') === 'auto-off' && back.size === 3);
  store.set('nexus.realityMlkem.origin.v1', '{"a.b":"auto-on","x":"maybe","y":3}');
  check('unknown values dropped', rm.loadRealityMlkemOrigins().size === 1);
  store.set('nexus.realityMlkem.origin.v1', 'not json');
  check('unreadable: empty, no throw', rm.loadRealityMlkemOrigins().size === 0);
  store.set('nexus.realityMlkem.origin.v1', '["a.b"]');
  check('an array is not a map: empty', rm.loadRealityMlkemOrigins().size === 0);
  store.clear();
  check('the switch set itself is not touched by origins', rm.loadRealityMlkem().size === 0);

  const moved = parseSingleConfig(`vless://${UUID}@moved.example.com:443?${REALITY}#legacy`);
  const origins = new Map<string, Origin>([[keyOf(legacy), 'auto-on']]);
  const carried = rm.carryRealityMlkemOrigin(origins, legacy, moved);
  check('an edit that moves the server carries the origin', carried.get(keyOf(moved)) === 'auto-on');
  check('a rename keeps the same key: same map back', rm.carryRealityMlkemOrigin(origins, legacy, parseSingleConfig(`vless://${UUID}@a.example.com:443?${REALITY}#renamed`)) === origins);
  check('nothing recorded: same map back', rm.carryRealityMlkemOrigin(NO_ORIGINS, legacy, moved) === NO_ORIGINS);
}

// --- 5. Test All: the retry --------------------------------------------------------------------
class FakeBridge {
  probeCalls: Array<{ runId: number; targets: Array<{ id: string; fingerprint: string; config: string }> }> = [];
  cancelled: number[] = [];
  private probeHandlers = new Set<(event: ServerProbeEvent) => void>();
  private doneHandlers = new Set<(event: { runId: number; cancelled: boolean }) => void>();
  rejectProbe = false;
  probeServers = (options: { runId: number; targets: Array<{ id: string; fingerprint: string; config: string }> }) => {
    this.probeCalls.push(options);
    return this.rejectProbe ? Promise.reject(new Error('no core')) : Promise.resolve({ runId: options.runId });
  };
  cancelProbe = (options: { runId: number }) => {
    this.cancelled.push(options.runId);
    return Promise.resolve();
  };
  // TCP answers at once: this script is about the Delay column.
  tcpPing = (options: { targets: Array<{ id: string; server: string; port: number }> }) =>
    Promise.resolve({ results: options.targets.map((t) => ({ id: t.id, ms: 10 })) });
  onProbe = (handler: (event: ServerProbeEvent) => void) => {
    this.probeHandlers.add(handler);
    return () => this.probeHandlers.delete(handler);
  };
  onProbeDone = (handler: (event: { runId: number; cancelled: boolean }) => void) => {
    this.doneHandlers.add(handler);
    return () => this.doneHandlers.delete(handler);
  };
  call(index = this.probeCalls.length - 1) {
    return this.probeCalls[index];
  }
  result(id: string, status: ServerProbeStatus, delayMs = 0, index = this.probeCalls.length - 1) {
    const call = this.probeCalls[index];
    const fingerprint = call.targets.find((t) => t.id === id)?.fingerprint ?? '';
    for (const handler of this.probeHandlers) handler({ runId: call.runId, serverId: id, fingerprint, status, delayMs });
  }
  done(cancelled = false, index = this.probeCalls.length - 1) {
    for (const handler of this.doneHandlers) handler({ runId: this.probeCalls[index].runId, cancelled });
  }
  get listeners(): number {
    return this.probeHandlers.size + this.doneHandlers.size;
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(nodes: ServerNode[], checkable = (n: ServerNode) => rm.realityMlkemCheckable(n, NONE, NO_ORIGINS)) {
  const bridge = new FakeBridge();
  const current = new Map(nodes.map((n) => [n.id, n]));
  const verdicts: Array<[string, boolean]> = [];
  const summaries: Array<{ delayOk: number; delayTotal: number; cancelled: boolean }> = [];
  const controller = new ServerTestsController(
    bridge,
    (id) => current.get(id),
    () => {},
    (summary) => summaries.push(summary),
    {
      variant: (n) => (checkable(n) ? rm.realityMlkemVariant(n) : null),
      verdict: (n, needed) => {
        verdicts.push([n.id, needed]);
        // As useSubscriptions does: a positive verdict rebuilds the node with the share.
        if (needed) current.set(n.id, rm.realityMlkemVariant(n));
      },
    },
  );
  controller.attach();
  return { bridge, controller, current, verdicts, summaries };
}

const A = { ...legacy, id: 'A' };
const B = { ...second, id: 'B' };
const T = { ...plain, id: 'T' };

{
  // Needed: held back, retried with the share, the retry's Delay lands, the switch turns on.
  const { bridge, controller, verdicts, current, summaries } = setup([A, B, T]);
  controller.start([A, B, T]);
  bridge.result('A', 'handshake_failed');
  bridge.result('B', 'ok', 120);
  bridge.result('T', 'handshake_failed'); // not REALITY: no retry
  check('held: A still testing while its retry is pending', controller.delay.A?.kind === 'testing', controller.delay.A);
  check('B passed without the share: verdict false', verdicts.some(([id, n]) => id === 'B' && n === false));
  check('T (not REALITY) failed at once', controller.delay.T?.kind === 'failed' && (controller.delay.T as { reason: string }).reason === 'Handshake failed');
  check('progress counts the held server as not done', controller.progress?.done === 2 && controller.progress?.total === 3, controller.progress);
  check('no retry before the first run is done', bridge.probeCalls.length === 1);
  bridge.done();
  check('the retry run: one more probe, A only', bridge.probeCalls.length === 2 && bridge.call().targets.length === 1 && bridge.call().targets[0].id === 'A');
  check('the retry probes A with the share', hasShare({ config: bridge.call().targets[0].config } as ServerNode));
  check('the retry has its own run id', bridge.call(1).runId !== bridge.call(0).runId);
  check('still running: no summary yet', summaries.length === 0 && controller.progress !== null);
  bridge.result('A', 'ok', 300);
  check('A shows the retry\'s Delay', controller.delay.A?.kind === 'ms' && (controller.delay.A as { ms: number }).ms === 300, controller.delay.A);
  check('A: verdict needed', verdicts.some(([id, n]) => id === 'A' && n === true));
  check('A rebuilt with the share (as the hook does)', hasShare(current.get('A')!));
  bridge.done();
  await settle();
  check('one summary, both working counted', summaries.length === 1 && summaries[0].delayOk === 2 && summaries[0].delayTotal === 3, summaries);
  check('progress cleared', controller.progress === null);
}
{
  // Not needed after all: the retry fails too, the original "Handshake failed" lands, no verdict.
  const { bridge, controller, verdicts } = setup([A]);
  controller.start([A]);
  bridge.result('A', 'handshake_failed');
  bridge.done();
  bridge.result('A', 'timeout');
  bridge.done();
  check('retry failed: A shows the original Handshake failed', controller.delay.A?.kind === 'failed' && (controller.delay.A as { reason: string }).reason === 'Handshake failed', controller.delay.A);
  check('retry failed: no verdict', verdicts.length === 0);
}
{
  // Other failures are no evidence: no retry.
  const { bridge, controller, verdicts } = setup([A]);
  controller.start([A]);
  bridge.result('A', 'timeout');
  bridge.done();
  check('timeout: no retry run', bridge.probeCalls.length === 1);
  check('timeout: shown at once', controller.delay.A?.kind === 'failed' && (controller.delay.A as { reason: string }).reason === 'Timeout');
  check('timeout: no verdict', verdicts.length === 0);
}
{
  // Not checkable (the user's choice): no retry, the failure shows.
  const { bridge, controller } = setup([A], () => false);
  controller.start([A]);
  bridge.result('A', 'handshake_failed');
  bridge.done();
  check('not checkable: no retry, failure shown', bridge.probeCalls.length === 1 && controller.delay.A?.kind === 'failed');
}
{
  // The retry run ends without answering (the app left the foreground): the first result stands.
  const { bridge, controller, summaries } = setup([A]);
  controller.start([A]);
  bridge.result('A', 'handshake_failed');
  bridge.done();
  bridge.done(true);
  await settle();
  check('retry cancelled: original failure shown', controller.delay.A?.kind === 'failed', controller.delay.A);
  check('retry cancelled: summary says cancelled', summaries.length === 1 && summaries[0].cancelled);
}
{
  // The first run is cancelled: no retry starts.
  const { bridge, controller } = setup([A]);
  controller.start([A]);
  bridge.result('A', 'handshake_failed');
  bridge.done(true);
  check('first run cancelled: no retry run', bridge.probeCalls.length === 1);
  check('first run cancelled: the failure it had stands', controller.delay.A?.kind === 'failed');
}
{
  // The retry probe is refused by the bridge: settled, not stuck.
  const { bridge, controller, summaries } = setup([A]);
  controller.start([A]);
  bridge.result('A', 'handshake_failed');
  bridge.rejectProbe = true;
  bridge.done();
  await settle();
  check('retry refused: original failure, run finished', controller.delay.A?.kind === 'failed' && summaries.length === 1 && controller.progress === null);
}
{
  // The user cancels during the retry: the retry run is the one cancelled.
  const { bridge, controller } = setup([A]);
  const previous = { kind: 'ms', ms: 99 } as const;
  controller.start([A]);
  bridge.result('A', 'handshake_failed');
  bridge.done();
  const retryRun = bridge.call().runId;
  controller.cancel();
  check('cancel during the retry cancels the retry run', bridge.cancelled.includes(retryRun));
  check('cancel during the retry: nothing left testing', controller.delay.A?.kind !== 'testing');
  void previous;
}
{
  // Edited mid-retry: the result is for a config that is gone, so nothing lands and no verdict.
  const { bridge, controller, verdicts, current } = setup([A]);
  controller.start([A]);
  bridge.result('A', 'handshake_failed');
  bridge.done();
  current.set('A', { ...A, config: A.config.replace('a.example.com', 'z.example.com') });
  bridge.result('A', 'ok', 200);
  check('edited mid-retry: no Delay painted', controller.delay.A === undefined, controller.delay.A);
  check('edited mid-retry: no verdict', verdicts.length === 0);
}
{
  // A stale retry event (wrong fingerprint) is ignored.
  const { bridge, controller, verdicts } = setup([A]);
  controller.start([A]);
  bridge.result('A', 'handshake_failed');
  bridge.done();
  for (const handler of (bridge as unknown as { probeHandlers: Set<(e: ServerProbeEvent) => void> }).probeHandlers) {
    handler({ runId: bridge.call().runId, serverId: 'A', fingerprint: configFingerprint(A.config), status: 'ok', delayMs: 1 });
  }
  check('retry event with the original fingerprint: ignored', controller.delay.A?.kind === 'testing' && verdicts.length === 0);
  controller.dispose();
  check('dispose: listeners gone', bridge.listeners === 0);
}

// --- 6. Connect's first look --------------------------------------------------------------------
class CheckBridge {
  calls: Array<{ runId: number; targets: Array<{ id: string; fingerprint: string; config: string }> }> = [];
  cancelled: number[] = [];
  probeHandlers = new Set<(event: ServerProbeEvent) => void>();
  doneHandlers = new Set<(event: { runId: number; cancelled: boolean }) => void>();
  reject = false;
  probeServers = (options: { runId: number; targets: Array<{ id: string; fingerprint: string; config: string }> }) => {
    this.calls.push(options);
    return this.reject ? Promise.reject(new Error('no core')) : Promise.resolve({ runId: options.runId });
  };
  cancelProbe = (options: { runId: number }) => {
    this.cancelled.push(options.runId);
    return Promise.resolve();
  };
  onProbe = (handler: (event: ServerProbeEvent) => void) => {
    this.probeHandlers.add(handler);
    return () => this.probeHandlers.delete(handler);
  };
  onProbeDone = (handler: (event: { runId: number; cancelled: boolean }) => void) => {
    this.doneHandlers.add(handler);
    return () => this.doneHandlers.delete(handler);
  };
  result(id: 'without' | 'with', status: ServerProbeStatus, runId = this.calls[0]?.runId ?? 0) {
    for (const h of this.probeHandlers) h({ runId, serverId: id, fingerprint: '', status, delayMs: 100 });
  }
  done(runId = this.calls[0]?.runId ?? 0) {
    for (const h of this.doneHandlers) h({ runId, cancelled: false });
  }
  get listeners() {
    return this.probeHandlers.size + this.doneHandlers.size;
  }
}

async function runCheck(script: (b: CheckBridge) => void, timeoutMs = 1000): Promise<{ verdict: boolean | null; bridge: CheckBridge }> {
  const bridge = new CheckBridge();
  const pending = checkRealityMlkem(legacy, bridge, timeoutMs);
  await settle();
  script(bridge);
  return { verdict: await pending, bridge };
}

{
  const { verdict, bridge } = await runCheck((b) => {
    b.result('without', 'handshake_failed');
    b.result('with', 'ok');
  });
  check('check: needed', verdict === true);
  check('check: one run, two targets, the node and its variant', bridge.calls.length === 1 && bridge.calls[0].targets.map((t) => t.id).join() === 'without,with');
  check('check: the "with" target offers the share, "without" does not', hasShare({ config: bridge.calls[0].targets[1].config } as ServerNode) && !hasShare({ config: bridge.calls[0].targets[0].config } as ServerNode));
  check('check: listeners released', bridge.listeners === 0);
}
{
  const { verdict, bridge } = await runCheck((b) => b.result('without', 'ok'));
  check('check: passes without -> not needed, decided at once', verdict === false);
  check('check: decided early, the rest of the run cancelled', bridge.cancelled.includes(bridge.calls[0].runId));
}
{
  const { verdict } = await runCheck((b) => {
    b.result('with', 'ok');
    b.result('without', 'handshake_failed');
  });
  check('check: answers in either order', verdict === true);
}
{
  const { verdict } = await runCheck((b) => {
    b.result('without', 'handshake_failed');
    b.result('with', 'handshake_failed');
  });
  check('check: fails both ways -> no verdict', verdict === null);
}
{
  const { verdict } = await runCheck((b) => b.result('without', 'timeout'));
  check('check: server down -> no verdict, without waiting for the other', verdict === null);
}
{
  const { verdict } = await runCheck((b) => {
    b.result('without', 'handshake_failed');
    b.done();
  });
  check('check: run ends with only one answer -> no verdict', verdict === null);
}
{
  const { verdict } = await runCheck((b) => {
    b.result('without', 'ok', 12345); // another run's event
    b.result('with', 'ok');
    b.result('without', 'handshake_failed');
  });
  check('check: events of another run ignored', verdict === true);
}
{
  const started = Date.now();
  const { verdict, bridge } = await runCheck(() => {}, 50);
  check('check: silence -> null after the timeout, not a hang', verdict === null && Date.now() - started < 1000);
  check('check: timeout cancels the run', bridge.cancelled.length > 0 && bridge.listeners === 0);
}
{
  const bridge = new CheckBridge();
  bridge.reject = true;
  const verdict = await checkRealityMlkem(legacy, bridge, 1000);
  check('check: the bridge refuses -> null', verdict === null && bridge.listeners === 0);
}
{
  const bridge = new CheckBridge();
  const verdict = await checkRealityMlkem(optedIn, bridge, 1000);
  check('check: a node whose link already opts in -> null, nothing probed', verdict === null && bridge.calls.length === 0);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
