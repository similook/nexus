import type { ServerProbeEvent, ServerProbeStatus } from './plugin';
import { realityMlkemVariant, realityMlkemVerdict } from './realityMlkem';
import { configFingerprint, nextRunId } from './serverTests';
import type { ServerNode } from '../data/servers';

/**
 * Connect's first look at a REALITY server no check has decided yet (realityMlkem.ts,
 * AUTOMATIC DETECTION).
 *
 * One probe run, two targets side by side: the node as it is, and the same node with the
 * X25519MLKEM768 key share. Both get the full handshake and URL test the Delay column uses, in
 * the short-lived probe core beside the tunnel. Resolves with realityMlkemVerdict of the pair -
 * true, the server needs the share; false, it does not - or null when there is no verdict:
 * neither worked, the probe failed, or it ran out of time. Never rejects.
 *
 * Cost: once per server. A verdict is stored and the next Connect skips this; a null is not,
 * so a server that was down is looked at again next time. The core runs one probe at a time,
 * so this cancels a Test All in progress - the user asked to connect.
 *
 * clients/web's realityMlkemCheck.ts with one change: the bridge is passed in (App builds it
 * from the platform port's core and coreEvents), as there is no global plugin here.
 */

/** The native calls and events this needs; injected so a check script can drive it. */
export interface MlkemCheckBridge {
  probeServers(options: {
    runId: number;
    targets: Array<{ id: string; fingerprint: string; config: string }>;
  }): Promise<unknown>;
  cancelProbe(options: { runId: number }): Promise<void>;
  onProbe(handler: (event: ServerProbeEvent) => void): () => void;
  onProbeDone(handler: (event: { runId: number; cancelled: boolean }) => void): () => void;
}

/** Longer than the probe's own per-server timeout, so a slow server answers before this gives up. */
const CHECK_TIMEOUT_MS = 20_000;

export function checkRealityMlkem(
  node: ServerNode,
  bridge: MlkemCheckBridge,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<boolean | null> {
  const withShare = realityMlkemVariant(node);
  if (withShare.config === node.config) return Promise.resolve(null);
  const runId = nextRunId();

  return new Promise<boolean | null>((resolve) => {
    const status: { without: ServerProbeStatus | null; with: ServerProbeStatus | null } = { without: null, with: null };
    let settled = false;
    const finish = (verdict: boolean | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offProbe();
      offDone();
      // Decided early (the first target passed): stop the other probe rather than spend a
      // handshake on an answer nobody reads. A no-op once the run has ended.
      void bridge.cancelProbe({ runId }).catch(() => {});
      resolve(verdict);
    };
    // Decide as soon as the pair allows it: "without" passing needs no second answer.
    const decide = (final: boolean) => {
      if (status.without === null) {
        if (final) finish(null);
        return;
      }
      const verdict = realityMlkemVerdict(status.without, status.with);
      if (verdict !== null || final || status.with !== null || status.without !== 'handshake_failed') finish(verdict);
    };

    const offProbe = bridge.onProbe((event) => {
      if (event.runId !== runId) return;
      if (event.serverId === 'without') status.without = event.status;
      else if (event.serverId === 'with') status.with = event.status;
      decide(false);
    });
    const offDone = bridge.onProbeDone((event) => {
      if (event.runId === runId) decide(true);
    });
    const timer = setTimeout(() => {
      void bridge.cancelProbe({ runId }).catch(() => {});
      decide(true);
    }, timeoutMs);

    bridge
      .probeServers({
        runId,
        targets: [
          { id: 'without', fingerprint: configFingerprint(node.config), config: node.config },
          { id: 'with', fingerprint: configFingerprint(withShare.config), config: withShare.config },
        ],
      })
      .catch(() => finish(null));
  });
}
