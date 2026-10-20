import type { ServerProbeEvent, ServerProbeStatus } from './plugin';
import { endpointOf, isQuicProtocol, type ServerNode } from '../data/servers';

/**
 * Test All: TCP and Delay for EVERY server, as two independent measurements.
 *
 *   TCP    NexusCore.tcpPing - a direct handshake to each server's endpoint. UDP-only protocols
 *          (Hysteria2, TUIC) have no TCP endpoint to time: n/a, not a failure.
 *   Delay  NexusCore.probeServers - each server's own config, full handshake and authentication,
 *          then the Live URL test, in a short-lived core instance beside (never inside) the
 *          tunnel. Works connected or not; never switches or disturbs the running server.
 *
 * Both start together and neither waits for the other. Neither ever writes the other's map.
 *
 * A result lands only if it still describes what is on screen:
 *   - it belongs to the CURRENT run - a newer run or a cancel makes every older result stale;
 *   - its server still exists with the config it was tested with (the fingerprint), so an edit
 *     or a subscription refresh mid-run cannot paint an old number onto a new config.
 *
 * BATTERY: runs only when start() is called - the Test All tap. No timer, no retry, nothing on
 * resume or visibility. dispose() cancels; NexusPlugin also cancels a probe when the app leaves
 * the foreground.
 *
 * REALITY ML-KEM RETRY: a Delay that ends in "Handshake failed" for a server whose ML-KEM
 * switch a check may still turn on (realityMlkem.ts, AUTOMATIC DETECTION) is not reported yet.
 * When the run's probe ends, those servers are probed once more with the key share, as a second
 * probe run inside the same Test All. A success lands as that server's Delay and turns the
 * switch on; anything else lands as the original "Handshake failed". A server that passes
 * without the share is recorded as not needing it.
 *
 * Plain TypeScript with its bridge injected, so scripts/check-server-tests.mts can drive it;
 * useServerTests is the React wrapper.
 */

export type TcpCell = { kind: 'testing' } | { kind: 'ms'; ms: number } | { kind: 'failed' } | { kind: 'na' };
export type DelayCell = { kind: 'testing' } | { kind: 'ms'; ms: number } | { kind: 'failed'; reason: string };

export interface TestAllSummary {
  cancelled: boolean;
  delayOk: number;
  delayTotal: number;
  tcpOk: number;
  tcpTotal: number;
}

/** The native calls and events this needs - NexusCore and coreEvents in the app. */
export interface ServerTestsBridge {
  probeServers(options: {
    runId: number;
    targets: Array<{ id: string; fingerprint: string; config: string }>;
  }): Promise<unknown>;
  cancelProbe(options: { runId: number }): Promise<void>;
  tcpPing(options: {
    targets: Array<{ id: string; server: string; port: number }>;
  }): Promise<{ results: Array<{ id: string; ms: number }> }>;
  onProbe(handler: (event: ServerProbeEvent) => void): () => void;
  onProbeDone(handler: (event: { runId: number; cancelled: boolean }) => void): () => void;
}

/** The REALITY ML-KEM retry's link to the switch (realityMlkem.ts), injected like the bridge. */
export interface MlkemRetry {
  /** The node with the key share when a failed handshake should be retried with it; null otherwise. */
  variant(node: ServerNode): ServerNode | null;
  /** A probe's verdict on the node as it is: true, it connects only with the share; false, without. */
  verdict(node: ServerNode, needed: boolean): void;
}

/** Short, sanitized reason for a failed Delay, shown when the user taps it. */
const REASONS: Partial<Record<ServerProbeStatus, string>> = {
  timeout: 'Timeout',
  refused: 'Refused',
  unreachable: 'Unreachable',
  dns_failed: 'DNS failed',
  handshake_failed: 'Handshake failed',
  rejected: 'Rejected',
  config_invalid: 'Config error',
};

/** FNV-1a (32-bit) over the config text, plus its length: changes whenever the config does. */
export function configFingerprint(config: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < config.length; i++) {
    hash ^= config.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${config.length.toString(36)}-${hash.toString(36)}`;
}

/**
 * Unique for the process's life, so a run from before a WebView reload can never match. Shared
 * with Connect's ML-KEM check (realityMlkemCheck.ts), whose runs go through the same probe.
 */
let lastRunId = 0;
export function nextRunId(): number {
  lastRunId = Math.max(Date.now(), lastRunId + 1);
  return lastRunId;
}

interface Run {
  id: number;
  /** id -> fingerprint of the config each server was tested with. */
  tested: Map<string, string>;
  /** Delay results still expected (progress) / cells this run may still write. */
  awaiting: Set<string>;
  delayWritable: Set<string>;
  tcpWritable: Set<string>;
  /** Cells as they were before the run, restored for anything the run never answers. */
  previousTcp: Record<string, TcpCell | undefined>;
  previousDelay: Record<string, DelayCell | undefined>;
  tcpPending: boolean;
  probePending: boolean;
  /** The core ended the probe early (the app left the foreground). */
  cancelled: boolean;
  /** Handshake failures waiting for the ML-KEM retry: id -> the node with the share, and the failure to show if it fails too. */
  retries: Map<string, { config: string; fingerprint: string; failed: DelayCell }>;
  /** The retry's probe run, once it has started. */
  retryRunId: number | null;
  total: number;
  delayOk: number;
  tcpOk: number;
  tcpTotal: number;
}

export class ServerTestsController {
  /** Replaced, never mutated, on every change. */
  tcp: Record<string, TcpCell> = {};
  delay: Record<string, DelayCell> = {};
  /** While a run is in progress: Delay results received of servers probed. */
  progress: { done: number; total: number } | null = null;

  private run: Run | null = null;
  private unsubscribe: Array<() => void> = [];

  constructor(
    private readonly bridge: ServerTestsBridge,
    /** The node with this id as it is NOW, or undefined if it is gone. */
    private readonly currentNode: (id: string) => ServerNode | undefined,
    private readonly changed: () => void,
    private readonly finished: (summary: TestAllSummary) => void = () => {},
    private readonly mlkem: MlkemRetry | null = null,
  ) {}

  /** Start listening. Idempotent. */
  attach(): void {
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe = [
      this.bridge.onProbe((event) => this.onProbe(event)),
      this.bridge.onProbeDone((event) => this.onProbeDone(event)),
    ];
  }

  /** Stop listening and cancel any run. Nothing is restored: there is no screen to restore. */
  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.endRun(false);
  }

  /** Test every server in `nodes`. Starting again cancels the run in progress. */
  start = (nodes: ServerNode[]): void => {
    this.endRun(true);
    const run: Run = {
      id: nextRunId(),
      tested: new Map(),
      awaiting: new Set(),
      delayWritable: new Set(),
      tcpWritable: new Set(),
      previousTcp: {},
      previousDelay: {},
      tcpPending: false,
      probePending: true,
      cancelled: false,
      retries: new Map(),
      retryRunId: null,
      total: 0,
      delayOk: 0,
      tcpOk: 0,
      tcpTotal: 0,
    };

    const probeTargets: Array<{ id: string; fingerprint: string; config: string }> = [];
    const tcpTargets: Array<{ id: string; server: string; port: number }> = [];
    const tcpChanges: Record<string, TcpCell> = {};
    const delayChanges: Record<string, DelayCell> = {};
    for (const node of nodes) {
      if (run.tested.has(node.id)) continue;
      const fingerprint = configFingerprint(node.config);
      run.tested.set(node.id, fingerprint);
      probeTargets.push({ id: node.id, fingerprint, config: node.config });
      run.awaiting.add(node.id);
      run.delayWritable.add(node.id);
      run.previousDelay[node.id] = this.delay[node.id];
      delayChanges[node.id] = { kind: 'testing' };

      run.previousTcp[node.id] = this.tcp[node.id];
      if (isQuicProtocol(node.protocol)) {
        tcpChanges[node.id] = { kind: 'na' };
        continue;
      }
      const endpoint = endpointOf(node);
      if (endpoint === null) continue;
      tcpTargets.push({ id: node.id, ...endpoint });
      run.tcpWritable.add(node.id);
      tcpChanges[node.id] = { kind: 'testing' };
    }
    if (probeTargets.length === 0) return;
    run.total = probeTargets.length;
    run.tcpTotal = tcpTargets.length;
    run.tcpPending = tcpTargets.length > 0;
    this.run = run;
    this.progress = { done: 0, total: run.total };
    this.patchTcp(tcpChanges);
    this.patchDelay(delayChanges);
    this.changed();

    // Delay: results stream in as serverProbe events.
    this.bridge.probeServers({ runId: run.id, targets: probeTargets }).catch(() => {
      if (this.run !== run) return;
      run.probePending = false;
      run.awaiting.clear();
      this.restore(run, 'delay');
      this.finishIfDone(run);
      this.changed();
    });

    // TCP: one batch, independent of the probe.
    if (tcpTargets.length > 0) {
      this.bridge
        .tcpPing({ targets: tcpTargets })
        .then(({ results }) => {
          if (this.run !== run) return;
          const changes: Record<string, TcpCell | undefined> = {};
          for (const { id, ms } of results) {
            if (!run.tcpWritable.delete(id)) continue;
            const fingerprint = run.tested.get(id);
            if (fingerprint === undefined || !this.stillCurrent(run, id, fingerprint)) {
              changes[id] = undefined;
            } else if (ms >= 0) {
              changes[id] = { kind: 'ms', ms };
              run.tcpOk++;
            } else {
              changes[id] = { kind: 'failed' };
            }
          }
          this.patchTcp(changes);
        })
        .catch(() => {})
        .finally(() => {
          if (this.run !== run) return;
          run.tcpPending = false;
          this.restore(run, 'tcp');
          this.finishIfDone(run);
          this.changed();
        });
    }
  };

  /** Stop the run in progress, putting back whatever it had not measured yet. */
  cancel = (): void => {
    const run = this.run;
    if (run === null) return;
    this.endRun(true);
    this.finished({ cancelled: true, delayOk: run.delayOk, delayTotal: run.total, tcpOk: run.tcpOk, tcpTotal: run.tcpTotal });
    this.changed();
  };

  /** Live (pingProxy) measured this server's Delay through the tunnel; null = no response. */
  recordLive = (id: string, ms: number | null): void => {
    // Newer than anything a run in progress may still send for this row.
    this.run?.delayWritable.delete(id);
    this.patchDelay({ [id]: ms === null ? { kind: 'failed', reason: 'No response' } : { kind: 'ms', ms } });
    this.changed();
  };

  private onProbe(event: ServerProbeEvent): void {
    const run = this.run;
    if (run === null) return;
    if (run.retryRunId !== null && event.runId === run.retryRunId) {
      this.onRetryProbe(run, event);
      return;
    }
    if (event.runId !== run.id || !run.awaiting.delete(event.serverId)) return;
    if (run.delayWritable.has(event.serverId)) {
      // null: leave the cell as it is, because the ML-KEM retry answers for it.
      let cell: DelayCell | undefined | null;
      if (!this.stillCurrent(run, event.serverId, event.fingerprint)) {
        cell = undefined; // edited or removed mid-run: the result is for a config that is gone
      } else if (event.status === 'cancelled') {
        cell = run.previousDelay[event.serverId];
      } else if (event.status === 'ok') {
        cell = { kind: 'ms', ms: event.delayMs };
        run.delayOk++;
        this.verdict(event.serverId, false);
      } else {
        const failed: DelayCell = { kind: 'failed', reason: REASONS[event.status] ?? 'Failed' };
        cell = event.status === 'handshake_failed' && this.queueRetry(run, event.serverId, failed) ? null : failed;
      }
      if (cell !== null) {
        run.delayWritable.delete(event.serverId);
        this.patchDelay({ [event.serverId]: cell });
      }
    }
    this.progress = { done: run.total - run.awaiting.size - run.retries.size, total: run.total };
    this.changed();
  }

  private onProbeDone(event: { runId: number; cancelled: boolean }): void {
    const run = this.run;
    if (run === null) return;
    const retryDone = run.retryRunId !== null && event.runId === run.retryRunId;
    if (!retryDone && event.runId !== run.id) return;
    if (!retryDone && !event.cancelled && run.retries.size > 0) {
      this.startRetries(run);
      this.changed();
      return;
    }
    run.probePending = false;
    run.cancelled = event.cancelled;
    this.settleRetries(run);
    this.restore(run, 'delay');
    this.finishIfDone(run);
    this.changed();
  }

  /** Hold a handshake failure for the ML-KEM retry. False when this server gets none. */
  private queueRetry(run: Run, id: string, failed: DelayCell): boolean {
    const node = this.currentNode(id);
    const variant = node === undefined || this.mlkem === null ? null : this.mlkem.variant(node);
    if (variant === null || variant.config === node?.config) return false;
    run.retries.set(id, { config: variant.config, fingerprint: configFingerprint(variant.config), failed });
    return true;
  }

  /** The second probe run of this Test All: every held server, with the key share. */
  private startRetries(run: Run): void {
    run.retryRunId = nextRunId();
    const targets = [...run.retries].map(([id, retry]) => ({ id, fingerprint: retry.fingerprint, config: retry.config }));
    this.bridge.probeServers({ runId: run.retryRunId, targets }).catch(() => {
      if (this.run !== run) return;
      run.probePending = false;
      this.settleRetries(run);
      this.restore(run, 'delay');
      this.finishIfDone(run);
      this.changed();
    });
  }

  private onRetryProbe(run: Run, event: ServerProbeEvent): void {
    const retry = run.retries.get(event.serverId);
    if (retry === undefined || event.fingerprint !== retry.fingerprint) return;
    run.retries.delete(event.serverId);
    if (run.delayWritable.delete(event.serverId)) {
      // Still the config the first probe tested? The retry's variant is derived from it.
      const original = run.tested.get(event.serverId);
      let cell: DelayCell | undefined;
      if (original === undefined || !this.stillCurrent(run, event.serverId, original)) {
        cell = undefined;
      } else if (event.status === 'ok') {
        cell = { kind: 'ms', ms: event.delayMs };
        run.delayOk++;
      } else if (event.status === 'cancelled') {
        cell = run.previousDelay[event.serverId];
      } else {
        cell = retry.failed;
      }
      this.patchDelay({ [event.serverId]: cell });
      // After the cell: the verdict rebuilds the node with the share, which changes its config.
      if (cell !== undefined && event.status === 'ok') this.verdict(event.serverId, true);
    }
    this.progress = { done: run.total - run.awaiting.size - run.retries.size, total: run.total };
    this.changed();
  }

  /** Retries that never got an answer: the server's own first result stands. */
  private settleRetries(run: Run): void {
    const changes: Record<string, DelayCell | undefined> = {};
    for (const [id, retry] of run.retries) {
      if (!run.delayWritable.delete(id)) continue;
      const original = run.tested.get(id);
      changes[id] = original !== undefined && this.stillCurrent(run, id, original) ? retry.failed : undefined;
    }
    run.retries.clear();
    this.patchDelay(changes);
  }

  private verdict(id: string, needed: boolean): void {
    const node = this.currentNode(id);
    if (node !== undefined && this.mlkem !== null) this.mlkem.verdict(node, needed);
  }

  /** Same server, same config as when the run started. */
  private stillCurrent(run: Run, id: string, fingerprint: string): boolean {
    const node = this.currentNode(id);
    return node !== undefined && run.tested.get(id) === fingerprint && configFingerprint(node.config) === fingerprint;
  }

  private finishIfDone(run: Run): void {
    if (this.run !== run || run.tcpPending || run.probePending) return;
    this.run = null;
    this.progress = null;
    this.finished({ cancelled: run.cancelled, delayOk: run.delayOk, delayTotal: run.total, tcpOk: run.tcpOk, tcpTotal: run.tcpTotal });
  }

  private endRun(restoreCells: boolean): void {
    const run = this.run;
    if (run === null) return;
    this.run = null;
    this.progress = null;
    void this.bridge.cancelProbe({ runId: run.retryRunId ?? run.id }).catch(() => {});
    if (restoreCells) {
      this.restore(run, 'tcp');
      this.restore(run, 'delay');
    }
  }

  /** Put back whatever this run never answered. */
  private restore(run: Run, which: 'tcp' | 'delay'): void {
    if (which === 'tcp') {
      const changes: Record<string, TcpCell | undefined> = {};
      for (const id of run.tcpWritable) changes[id] = run.previousTcp[id];
      run.tcpWritable.clear();
      this.patchTcp(changes);
    } else {
      const changes: Record<string, DelayCell | undefined> = {};
      for (const id of run.delayWritable) changes[id] = run.previousDelay[id];
      run.delayWritable.clear();
      this.patchDelay(changes);
    }
  }

  private patchTcp(changes: Record<string, TcpCell | undefined>): void {
    this.tcp = patched(this.tcp, changes);
  }

  private patchDelay(changes: Record<string, DelayCell | undefined>): void {
    this.delay = patched(this.delay, changes);
  }
}

function patched<T>(map: Record<string, T>, changes: Record<string, T | undefined>): Record<string, T> {
  const next = { ...map };
  for (const [id, cell] of Object.entries(changes)) {
    if (cell === undefined) delete next[id];
    else next[id] = cell;
  }
  return next;
}
