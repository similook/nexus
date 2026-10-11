import { useCallback, useEffect, useState } from 'react';
import { usePlatform } from '../platform';
import { coreEvents } from './coreEvents';
import { useNexus } from './NexusProvider';
import { loadRoutingMode, saveRoutingMode, type RoutingMode } from './routing';

export interface RoutingApi {
  /** The stored choice: what the next connect starts in. */
  mode: RoutingMode;
  /** What the running tunnel reports. Null while no tunnel runs, and until the daemon has said. */
  active: string | null;
  /** A live switch in flight — shown as switching until the daemon confirms the new mode. */
  pending: RoutingMode | null;
  error: string | null;
  select(mode: RoutingMode): Promise<void>;
  dismissError(): void;
}

/**
 * The desktop routing selector's state: VPN or Direct. See core/routing.ts.
 *
 * NOTHING HERE MARKS A MODE ACTIVE ON ITS OWN SAY-SO. The active mode comes from the daemon
 * only: the clashMode event it pushes after a start and after every switch, the same value on
 * each status tick, and getStatus() on mount and whenever the window is shown again — the
 * reconcile useNexusCore already does, for the same reason: a page that loaded after the
 * tunnel came up missed the event.
 *
 * Disconnected, a choice is only stored; the next connect starts in it. Connected, a choice is
 * a live switch: setClashMode, then closeConnections so open connections re-route — the tunnel
 * stays up throughout. The stored choice changes only when the user picks, never on its own.
 */
export function useRouting(): RoutingApi {
  const { core, appState } = usePlatform();
  const { connection } = useNexus();
  const connected = connection === 'connected';

  const [mode, setMode] = useState<RoutingMode>(loadRoutingMode);
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<RoutingMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((current: string | undefined) => {
    setActive(current || null);
    // A switch is done when the daemon says so, and not before.
    if (current) {
      setPending((waiting) => (waiting !== null && waiting.toLowerCase() === current.toLowerCase() ? null : waiting));
    }
  }, []);

  const reconcile = useCallback(async () => {
    try {
      const snapshot = await core.getStatus();
      // 'unknown' means the link to the daemon is down, which says nothing about routing.
      if (snapshot.state !== 'unknown') report(snapshot.clashMode);
    } catch {
      // Same: an unreachable daemon is not evidence about the route.
    }
  }, [core, report]);

  useEffect(() => {
    const offMode = coreEvents.subscribe('clashMode', (event) => report(event.current));
    const offStatus = coreEvents.subscribe('status', (status) => report(status.clashMode));
    void reconcile();
    const offVisible = appState.subscribe((visible) => {
      if (visible) void reconcile();
    });
    return () => {
      offMode();
      offStatus();
      offVisible();
    };
  }, [appState, reconcile, report]);

  // No tunnel, no active mode — including the moment a server switch replaces one.
  useEffect(() => {
    if (!connected) {
      setActive(null);
      setPending(null);
    }
  }, [connected]);

  const choose = useCallback((next: RoutingMode) => {
    setMode(next);
    saveRoutingMode(next);
  }, []);

  const select = useCallback(
    async (next: RoutingMode) => {
      setError(null);
      if (!connected) {
        choose(next);
        return;
      }
      if (active === null) {
        setError('The tunnel has not reported its routing yet. Try again in a moment.');
        return;
      }
      if (active.toLowerCase() === next.toLowerCase()) {
        choose(next);
        return;
      }

      setPending(next);
      try {
        await core.setClashMode({ mode: next });
      } catch (e) {
        setPending(null);
        setError(`Could not switch to ${next}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      // The daemon has switched; the choice is stored only now, so a failed switch never
      // leaves a stored choice that differs from the running one.
      choose(next);
      try {
        await core.closeConnections();
      } catch (e) {
        setError(
          `Switched to ${next}, but open connections could not be restarted: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
      void reconcile();
    },
    [active, choose, connected, core, reconcile],
  );

  return { mode, active, pending, error, select, dismissError: () => setError(null) };
}
