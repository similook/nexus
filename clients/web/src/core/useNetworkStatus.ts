import { useEffect, useState } from 'react';
import { App } from '@capacitor/app';
import { NexusCore, type NetworkStatusEvent } from './plugin';

/**
 * Device-network status, pushed from the platform.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THERE IS NO TIMER IN HERE, AND THERE MUST NOT BE ONE.
 *
 * Unlike useLivePing, this hook measures nothing. It subscribes to a native callback that
 * ConnectivityManager fires when the phone's network actually changes — a handful of times a
 * session, not on a cadence — and the native side deduplicates before it crosses the bridge.
 * A setInterval here would re-create the wakeup pattern ADR-0001 exists to remove, to refresh
 * a value that had not changed.
 *
 * The native monitor unregisters in handleOnPause, so nothing is observed while the app is
 * backgrounded. That is why this reconciles on foreground: whatever we last rendered is stale
 * by however long the app was away.
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THE VALUE MEANS — read NetworkStatusState in plugin.ts before rendering it. In short:
 * this is the phone's own link, not the tunnel, and not a measurement of speed or quality.
 * 'ok' means Android validated the LINK; a blocked proxy over perfect Wi-Fi still reads 'ok'.
 */

/** Also the value while the platform has not answered yet — "we don't know", not "bad". */
const UNKNOWN: NetworkStatusEvent = { state: 'unknown', transport: 'unknown' };

export function useNetworkStatus(): NetworkStatusEvent {
  const [status, setStatus] = useState<NetworkStatusEvent>(UNKNOWN);

  useEffect(() => {
    let stopped = false;

    const reconcile = async () => {
      try {
        const next = await NexusCore.getNetworkStatus();
        if (!stopped) setStatus(next);
      } catch {
        // A bridge failure is not evidence about the network. Say so, rather than showing a
        // red "No network" the platform never reported.
        if (!stopped) setStatus(UNKNOWN);
      }
    };

    void reconcile();

    // addListener inside the effect, never in the component body: Capacitor's listener
    // removal splices by index without guarding, so a handle registered on a render that is
    // later discarded can silently remove a live listener belonging to someone else.
    const statusListener = NexusCore.addListener('networkStatus', (event) => {
      if (!stopped) setStatus(event);
    });

    const appListener = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void reconcile();
    });

    return () => {
      stopped = true;
      // addListener resolves to a handle; removing it is async and the component is already
      // gone, so failures are swallowed rather than surfaced.
      void statusListener.then((handle) => handle.remove()).catch(() => {});
      void appListener.then((handle) => handle.remove()).catch(() => {});
    };
  }, []);

  return status;
}
