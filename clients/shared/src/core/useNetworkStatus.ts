import { useEffect, useState } from 'react';
import { usePlatform } from '../platform';
import type { NetworkStatusEvent } from './plugin';

/**
 * Device-network status, pushed from the platform.
 *
 * Ported from clients/web/src/core/useNetworkStatus.ts (v1.3.0) onto PlatformPort: the
 * Capacitor `App.addListener('appStateChange')` becomes `appState.subscribe`, and the
 * registered `NexusCore` plugin becomes `port.core`. Behaviour is otherwise identical.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THERE IS NO TIMER IN HERE, AND THERE MUST NOT BE ONE.
 *
 * Unlike useLivePing, this hook measures nothing. It subscribes to a native callback that the
 * platform fires when the machine's network actually changes — a handful of times a session,
 * not on a cadence — and the native side deduplicates before it crosses the bridge. A
 * setInterval here would re-create the wakeup pattern ADR-0001 exists to remove, to refresh a
 * value that had not changed.
 *
 * A shell's native monitor may stop observing while the UI is hidden (R1). That is why this
 * reconciles when the UI becomes visible again: whatever we last rendered is stale by however
 * long it was away.
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THE VALUE MEANS — read NetworkStatusState in plugin.ts before rendering it. In short:
 * this is the machine's own link, not the tunnel, and not a measurement of speed or quality.
 * 'ok' means the OS validated the LINK; a blocked proxy over a perfect connection still reads
 * 'ok'.
 */

/** Also the value while the platform has not answered yet — "we don't know", not "bad". */
const UNKNOWN: NetworkStatusEvent = { state: 'unknown', transport: 'unknown' };

export function useNetworkStatus(): NetworkStatusEvent {
  const { core, appState } = usePlatform();
  const [status, setStatus] = useState<NetworkStatusEvent>(UNKNOWN);

  useEffect(() => {
    let stopped = false;

    const reconcile = async () => {
      try {
        const next = await core.getNetworkStatus();
        if (!stopped) setStatus(next);
      } catch {
        // A bridge failure is not evidence about the network. Say so, rather than showing a
        // red "No network" the platform never reported.
        if (!stopped) setStatus(UNKNOWN);
      }
    };

    void reconcile();

    // addListener inside the effect, never in the component body: see the note in
    // coreEvents.ts on why a handle registered on a discarded render is dangerous.
    const statusListener = core.addListener('networkStatus', (event) => {
      if (!stopped) setStatus(event);
    });

    const unsubscribe = appState.subscribe((visible) => {
      if (visible) void reconcile();
    });

    return () => {
      stopped = true;
      // addListener resolves to a handle; removing it is async and the component is already
      // gone, so failures are swallowed rather than surfaced.
      void statusListener.then((handle) => handle.remove()).catch(() => {});
      unsubscribe();
    };
  }, [core, appState]);

  return status;
}
