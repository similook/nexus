/**
 * Test All's result rules (src/core/serverTests.ts), driven through a fake native bridge.
 *
 *   npx tsx scripts/check-server-tests.mts
 *
 * What must hold: TCP and Delay are separate and neither waits for the other; only the current
 * run's results land, and only for a server that still has the config it was tested with;
 * cancel - from the user or the core - puts back what was not measured and lets nothing late
 * in; Live and Test All share the Delay column without clobbering each other.
 */
import type { ServerProbeEvent, ServerProbeStatus } from '../src/core/plugin';
import { ServerTestsController, configFingerprint, type TestAllSummary } from '../src/core/serverTests';
import type { ServerNode } from '../src/data/servers';

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

function node(id: string, protocol: ServerNode['protocol'], port = 443, extra = ''): ServerNode {
  const outbound = { type: 'vless', tag: 'proxy', server: `${id}.example.com`, server_port: port, extra };
  return {
    id,
    name: id,
    flag: '',
    country: '',
    transport: '',
    protocol,
    pingMs: null,
    config: JSON.stringify({ outbounds: [outbound, { type: 'direct', tag: 'direct' }] }),
  } as ServerNode;
}

class FakeBridge {
  probeCalls: Array<{ runId: number; targets: Array<{ id: string; fingerprint: string; config: string }> }> = [];
  cancelled: number[] = [];
  tcpCalls: Array<{ targets: Array<{ id: string; server: string; port: number }> }> = [];
  private tcpResolvers: Array<(value: { results: Array<{ id: string; ms: number }> }) => void> = [];
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
  tcpPing = (options: { targets: Array<{ id: string; server: string; port: number }> }) => {
    this.tcpCalls.push(options);
    return new Promise<{ results: Array<{ id: string; ms: number }> }>((resolve) => this.tcpResolvers.push(resolve));
  };
  onProbe = (handler: (event: ServerProbeEvent) => void) => {
    this.probeHandlers.add(handler);
    return () => this.probeHandlers.delete(handler);
  };
  onProbeDone = (handler: (event: { runId: number; cancelled: boolean }) => void) => {
    this.doneHandlers.add(handler);
    return () => this.doneHandlers.delete(handler);
  };

  get lastRunId(): number {
    return this.probeCalls[this.probeCalls.length - 1].runId;
  }
  fingerprintOf(id: string): string {
    const call = this.probeCalls[this.probeCalls.length - 1];
    return call.targets.find((t) => t.id === id)?.fingerprint ?? '';
  }
  result(id: string, status: ServerProbeStatus, delayMs = 0, runId = this.lastRunId, fingerprint = this.fingerprintOf(id)) {
    for (const handler of this.probeHandlers) handler({ runId, serverId: id, fingerprint, status, delayMs });
  }
  done(cancelled = false, runId = this.lastRunId) {
    for (const handler of this.doneHandlers) handler({ runId, cancelled });
  }
  async tcp(results: Array<{ id: string; ms: number }>, index = this.tcpResolvers.length - 1) {
    this.tcpResolvers[index]({ results });
    await settle();
  }
  get listeners(): number {
    return this.probeHandlers.size + this.doneHandlers.size;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(nodes: ServerNode[]) {
  const bridge = new FakeBridge();
  const current = new Map(nodes.map((n) => [n.id, n]));
  const summaries: TestAllSummary[] = [];
  let changes = 0;
  const controller = new ServerTestsController(
    bridge,
    (id) => current.get(id),
    () => changes++,
    (summary) => summaries.push(summary),
  );
  controller.attach();
  return { bridge, controller, current, summaries, changes: () => changes };
}

// --- 1. TCP and Delay: separate, every server, neither waits ------------------------------
{
  const nodes = [node('a', 'VLESS'), node('b', 'Hysteria2'), node('c', 'VLESS')];
  const { bridge, controller, summaries } = setup(nodes);
  controller.start(nodes);
  check('one probe run for every server', bridge.probeCalls.length === 1 && bridge.probeCalls[0].targets.length === 3);
  check('TCP for every TCP server, none for UDP-only', bridge.tcpCalls[0]?.targets.map((t) => t.id).join() === 'a,c');
  check('targets carry the config fingerprint', bridge.probeCalls[0].targets[0].fingerprint === configFingerprint(nodes[0].config));
  check('rows start testing', controller.tcp.a?.kind === 'testing' && controller.delay.a?.kind === 'testing');
  check('UDP-only TCP is n/a', controller.tcp.b?.kind === 'na');
  check('progress 0/3', controller.progress?.done === 0 && controller.progress?.total === 3);

  bridge.result('a', 'ok', 280);
  check('Delay lands before TCP finishes', controller.delay.a?.kind === 'ms' && controller.tcp.a?.kind === 'testing');
  check('progress 1/3', controller.progress?.done === 1);
  await bridge.tcp([{ id: 'a', ms: 52 }, { id: 'c', ms: -1 }]);
  check('TCP number', controller.tcp.a?.kind === 'ms' && controller.tcp.a.ms === 52);
  check('TCP failure', controller.tcp.c?.kind === 'failed');
  check('TCP did not touch Delay', controller.delay.a?.kind === 'ms' && controller.delay.a.ms === 280);
  bridge.result('b', 'rejected');
  const b = controller.delay.b;
  check('failed Delay keeps a sanitized reason', b?.kind === 'failed' && b.reason === 'Rejected', b);
  check('UDP-only TCP stays n/a after Delay', controller.tcp.b?.kind === 'na');
  bridge.result('c', 'timeout');
  check('run still open until done', summaries.length === 0);
  bridge.done();
  check('finished once', summaries.length === 1, summaries);
  check('summary', JSON.stringify(summaries[0]) === JSON.stringify({ cancelled: false, delayOk: 1, delayTotal: 3, tcpOk: 1, tcpTotal: 2 }), summaries[0]);
  check('progress cleared', controller.progress === null);
}

// --- 2. stale runs ------------------------------------------------------------------------
{
  const nodes = [node('a', 'VLESS'), node('b', 'VLESS')];
  const { bridge, controller } = setup(nodes);
  controller.start(nodes);
  const first = bridge.lastRunId;
  controller.start(nodes);
  check('a new run cancels the old one', bridge.cancelled.includes(first));
  check('run ids differ', bridge.lastRunId !== first);
  bridge.result('a', 'ok', 999, first);
  check('old run result ignored', controller.delay.a?.kind === 'testing', controller.delay.a);
  bridge.done(false, first);
  check('old run done ignored', controller.progress !== null);
  await bridge.tcp([{ id: 'a', ms: 11 }], 0);
  check('old run TCP ignored', controller.tcp.a?.kind === 'testing', controller.tcp.a);
  bridge.result('a', 'ok', 300);
  bridge.result('a', 'ok', 301);
  check('duplicate result ignored', controller.delay.a?.kind === 'ms' && controller.delay.a.ms === 300 && controller.progress?.done === 1);
  bridge.result('zzz', 'ok', 5);
  check('unknown server ignored', controller.delay.zzz === undefined && controller.progress?.done === 1);
}

// --- 3. edited / removed mid-run ------------------------------------------------------------
{
  const nodes = [node('a', 'VLESS'), node('b', 'VLESS'), node('c', 'VLESS')];
  const { bridge, controller, current } = setup(nodes);
  controller.start(nodes);
  current.set('a', node('a', 'VLESS', 8443)); // same id, new config
  current.delete('b');
  bridge.result('a', 'ok', 100);
  bridge.result('b', 'ok', 100);
  bridge.result('c', 'ok', 100, bridge.lastRunId, 'not-the-fingerprint');
  check('edited server: result dropped', controller.delay.a === undefined, controller.delay.a);
  check('removed server: result dropped', controller.delay.b === undefined, controller.delay.b);
  check('wrong fingerprint: result dropped', controller.delay.c === undefined, controller.delay.c);
  await bridge.tcp([{ id: 'a', ms: 10 }, { id: 'c', ms: 10 }]);
  check('edited server: TCP dropped', controller.tcp.a === undefined, controller.tcp.a);
  check('unchanged server: TCP lands', controller.tcp.c?.kind === 'ms');
}

// --- 4. user cancel -------------------------------------------------------------------------
{
  const nodes = [node('a', 'VLESS'), node('b', 'VLESS'), node('c', 'TUIC')];
  const { bridge, controller, summaries } = setup(nodes);
  controller.start(nodes);
  bridge.result('a', 'ok', 250);
  bridge.done();
  await bridge.tcp([{ id: 'a', ms: 40 }, { id: 'b', ms: 41 }]);
  check('first run complete', summaries.length === 1 && controller.progress === null);

  controller.start(nodes);
  const second = bridge.lastRunId;
  bridge.result('b', 'ok', 333);
  controller.cancel();
  check('cancel tells the core', bridge.cancelled.includes(second));
  check('cancel reports cancelled', summaries[1]?.cancelled === true, summaries[1]);
  check('cancel restores an untested row to its last value', controller.delay.a?.kind === 'ms' && controller.delay.a.ms === 250, controller.delay.a);
  check('cancel restores TCP to its last value', controller.tcp.a?.kind === 'ms' && controller.tcp.a.ms === 40, controller.tcp.a);
  check('cancel restores a never-tested row to untested', controller.delay.c === undefined, controller.delay.c);
  check('cancel keeps what was measured before it', controller.delay.b?.kind === 'ms' && controller.delay.b.ms === 333);
  check('cancel clears progress', controller.progress === null);
  bridge.result('a', 'ok', 1, second);
  bridge.done(true, second);
  await bridge.tcp([{ id: 'a', ms: 1 }]);
  check('nothing lands after cancel', controller.delay.a?.kind === 'ms' && controller.delay.a.ms === 250 && controller.tcp.a?.kind === 'ms' && controller.tcp.a.ms === 40);
  check('finished not reported twice', summaries.length === 2, summaries.length);
  controller.cancel();
  check('cancel with nothing running is a no-op', summaries.length === 2);
}

// --- 5. the core cancels (app left the foreground) ------------------------------------------
{
  const nodes = [node('a', 'VLESS'), node('b', 'VLESS')];
  const { bridge, controller, summaries } = setup(nodes);
  controller.start(nodes);
  bridge.result('a', 'cancelled');
  check('a cancelled status restores, not fails', controller.delay.a === undefined, controller.delay.a);
  bridge.done(true);
  check('pending Delay restored on done', controller.delay.b === undefined);
  check('run waits for TCP', summaries.length === 0 && controller.progress !== null);
  await bridge.tcp([{ id: 'a', ms: 20 }, { id: 'b', ms: 21 }]);
  check('then finishes as cancelled', summaries.length === 1 && summaries[0].cancelled === true, summaries);
}

// --- 6. Live shares the Delay column --------------------------------------------------------
{
  const nodes = [node('a', 'VLESS'), node('b', 'VLESS')];
  const { bridge, controller } = setup(nodes);
  controller.recordLive('a', 410);
  check('Live writes Delay', controller.delay.a?.kind === 'ms' && controller.delay.a.ms === 410);
  check('Live never writes TCP', controller.tcp.a === undefined);
  controller.start(nodes);
  controller.recordLive('a', 420);
  bridge.result('a', 'ok', 300);
  check('a Live result during a run is not overwritten by the run', controller.delay.a?.kind === 'ms' && controller.delay.a.ms === 420);
  check('but still counts for progress', controller.progress?.done === 1);
  controller.recordLive('b', null);
  const live = controller.delay.b;
  check('Live failure', live?.kind === 'failed' && live.reason === 'No response', live);
}

// --- 7. the native call fails; nothing to test; dispose -------------------------------------
{
  const nodes = [node('a', 'VLESS')];
  const { bridge, controller, summaries } = setup(nodes);
  bridge.rejectProbe = true;
  controller.start(nodes);
  await settle();
  check('probe rejection restores Delay', controller.delay.a === undefined, controller.delay.a);
  await bridge.tcp([{ id: 'a', ms: 30 }]);
  check('TCP still lands without the probe', controller.tcp.a?.kind === 'ms');
  check('and the run finishes', summaries.length === 1 && controller.progress === null);

  const empty = setup([]);
  empty.controller.start([]);
  check('no servers: no native calls', empty.bridge.probeCalls.length === 0 && empty.bridge.tcpCalls.length === 0);

  const live = setup(nodes);
  live.controller.start(nodes);
  const run = live.bridge.lastRunId;
  live.controller.dispose();
  check('dispose cancels the run', live.bridge.cancelled.includes(run));
  check('dispose unsubscribes', live.bridge.listeners === 0);
  live.controller.attach();
  live.controller.attach();
  check('attach is idempotent', live.bridge.listeners === 2);
}

// --- 8. fingerprint ---------------------------------------------------------------------------
{
  const a = node('a', 'VLESS').config;
  check('fingerprint is stable', configFingerprint(a) === configFingerprint(String(a)));
  check('fingerprint changes with the config', configFingerprint(a) !== configFingerprint(a.replace('443', '444')));
}

console.log(`${passed}/${passed + failed} server-test checks passed`);
if (failed > 0) process.exit(1);
