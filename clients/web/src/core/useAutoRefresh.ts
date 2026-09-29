import { useEffect, useState } from 'react';
import { SubscriptionError } from './subscription';
import type { ConnectionState } from './useNexusCore';
import type { RefreshOptions, UseSubscriptions } from './useSubscriptions';

/**
 * Automatic subscription refresh: one attempt per launch, and at most one retry.
 *
 * THIS IS THE WHOLE POLICY. There is no other automatic fetch anywhere:
 *
 *   1. At launch, every stored subscription is refreshed once, directly - the same request a
 *      manual Update makes.
 *   2. One that got NO answer at all (SubscriptionError.network: offline, unreachable, blocked,
 *      timed out) is retried exactly once, THROUGH THE TUNNEL, the first time Nexus is connected
 *      during this launch. Through the tunnel because the app's own requests bypass its VPN: a
 *      direct retry after connecting would fail exactly as the first attempt did. See
 *      NexusCorePlugin.fetchViaTunnel.
 *   3. Nothing more. An error status or unusable content is an answer - the network works, and
 *      asking again would get the same answer - so it is not retried. No timer, no polling, no
 *      background job: a failure stays failed until the next launch or a manual Update, which
 *      none of this affects.
 *
 * Silent, and never sets `busy`: a failed automatic refresh leaves the stored nodes exactly as
 * they were, the same outcome as not having tried, and a manual Update or Add stays usable
 * while one is in flight.
 *
 * The policy is a plain object so scripts/check-auto-refresh.mts can drive it without React;
 * the hook below only decides WHEN to call it.
 */

type Phase = 'idle' | 'running' | 'awaiting-tunnel' | 'done';

type Refresh = (id: string, options: RefreshOptions) => Promise<unknown>;

export interface RefreshPolicy {
  readonly phase: Phase;
  /** The launch pass. Runs at most once; resolves when every attempt has settled. */
  launch(ids: string[], refresh: Refresh): Promise<void>;
  /** The tunnel retry. Runs at most once, and only after a launch pass left something unreached. */
  retry(refresh: Refresh): Promise<void>;
}

export function createRefreshPolicy(): RefreshPolicy {
  let phase: Phase = 'idle';
  let unreachable: string[] = [];

  return {
    get phase() {
      return phase;
    },

    async launch(ids, refresh) {
      if (phase !== 'idle') return;
      phase = 'running';
      const failed: string[] = [];
      // One at a time: a launch is not the moment to open a burst of parallel requests.
      for (const id of ids) {
        try {
          await refresh(id, { automatic: true });
        } catch (e) {
          if (e instanceof SubscriptionError && e.network) failed.push(id);
        }
      }
      unreachable = failed;
      phase = failed.length > 0 ? 'awaiting-tunnel' : 'done';
    },

    async retry(refresh) {
      if (phase !== 'awaiting-tunnel') return;
      // Spent before the first request goes out, so nothing can make this run a second time.
      phase = 'done';
      const ids = unreachable;
      unreachable = [];
      for (const id of ids) {
        try {
          await refresh(id, { viaTunnel: true, automatic: true });
        } catch {
          // Final either way. The next attempt is the next launch or a manual Update.
        }
      }
    },
  };
}

/*
 * Module scope, not component state. "Once per launch" means once per JS context: a remount -
 * or StrictMode running every effect twice in development (main.tsx) - must not fetch again.
 */
const policy = createRefreshPolicy();

export function useAutoRefresh(subs: UseSubscriptions, connection: ConnectionState): void {
  const { hydrated, refresh } = subs;

  // Re-renders once the launch pass has settled, so the retry below also runs when the tunnel
  // was already up by then - started from the tile before the app was opened, say.
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (policy.phase !== 'idle' || !hydrated) return;
    void policy.launch(subs.subscriptions.map((r) => r.id), refresh).then(() => setSettled(true));
    // Deliberately keyed on `hydrated` alone. The list changes with every refresh this starts,
    // and none of those changes may start another pass.
  }, [hydrated]);

  useEffect(() => {
    if (connection === 'connected') void policy.retry(refresh);
  }, [connection, settled, refresh]);
}
