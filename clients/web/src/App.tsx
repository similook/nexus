import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BottomNav, type Tab } from './components/BottomNav';
import { ToastProvider } from './components/Toast';
import { NexusProvider, useNexus } from './core/NexusProvider';
import { useSubscriptions } from './core/useSubscriptions';
import { loadSelectedId, saveSelectedId } from './core/selection';
import { protocolOf, type ServerNode } from './data/servers';
import { HomeView } from './views/HomeView';
import { LogsView } from './views/LogsView';
import { ServersView } from './views/ServersView';

export function App() {
  return (
    // NexusProvider is OUTSIDE the tab switch on purpose. Inside, every tab change would tear
    // down and re-establish the status subscription — see NexusProvider.tsx.
    <NexusProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </NexusProvider>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  /**
   * null until something is imported. There are no built-in nodes any more, so a fresh install
   * genuinely has nothing selected - and the UI must say so rather than point at a placeholder
   * that cannot connect.
   */
  const [selected, setSelected] = useState<ServerNode | null>(null);
  const native = Capacitor.isNativePlatform();

  // Lives here, not in ServersView: the selected node can come from a subscription, and the
  // Home tab has to keep rendering it after ServersView unmounts.
  const subs = useSubscriptions();
  const { connection, switchTo } = useNexus();

  /**
   * Has the user picked a node themselves?
   *
   * A ref, not state: it must not trigger a render, and auto-selection reads it during an
   * effect that also runs on every node-list change. Once true it stays true for the session —
   * a manual choice outranks every subsequent auto-pick, which is the whole point of the rule.
   */
  const userChoseRef = useRef(false);

  /**
   * The node id remembered from the previous session, consumed once.
   *
   * Read synchronously at mount so it is available on the FIRST pass of the auto-selection
   * effect — the nodes arrive after it, so a restore that waited for a render would lose the
   * race against auto-pick and the user would watch their choice get overwritten.
   *
   * A ref because it is a one-shot: once the node exists and is selected, or turns out to be
   * gone, this must stop influencing anything. Leaving it in play would resurrect a stale
   * choice every time the list changed.
   */
  const pendingRestoreRef = useRef<string | null>(loadSelectedId());

  /**
   * Auto-selection (item 5 of the device feedback):
   *   - exactly one node        -> select it
   *   - several                 -> lowest ping wins; unmeasured nodes lose to measured ones
   *   - user has chosen already -> never override
   *
   * Also re-runs when the selected node disappears (subscription deleted or refreshed into a
   * new set of ids), because leaving `selected` pointing at a node that no longer exists is how
   * you get a Connect button that silently does nothing.
   */
  useEffect(() => {
    const pool = subs.nodes;

    /**
     * Restore the previous session's choice before any auto-pick can run.
     *
     * A remembered selection IS a manual choice, just an older one, so it outranks
     * lowest-ping auto-selection exactly the way a fresh tap does - hence userChoseRef.
     *
     * If the id is gone (subscription deleted, or refreshed into a new set of ids) the restore
     * is abandoned and the normal auto-pick below takes over. Silently keeping a dangling id
     * is how you get a Connect button that does nothing.
     */
    const restoreId = pendingRestoreRef.current;
    if (restoreId !== null && pool.length > 0) {
      pendingRestoreRef.current = null;
      const remembered = pool.find((n) => n.id === restoreId);
      if (remembered) {
        userChoseRef.current = true;
        setSelected(remembered);
        return;
      }
    }

    if (pool.length === 0) {
      // The last node was removed. Clearing is the honest state; leaving `selected` pointing
      // at a deleted node is how you get a Connect button that silently does nothing.
      if (selected !== null) setSelected(null);
      // Forget the remembered id too - it can only refer to something deleted now, and
      // keeping it would make the next import restore a node the user did not choose.
      saveSelectedId(null);
      return;
    }

    const stillThere = selected !== null && pool.some((n) => n.id === selected.id);
    if (userChoseRef.current && stillThere) return;
    if (stillThere) return;

    if (pool.length === 1) {
      setSelected(pool[0]);
      return;
    }

    // null ping means "never tested", which is not the same as "fast". Sort measured nodes
    // first, then by latency.
    const best = [...pool].sort((a, b) => {
      if (a.pingMs === null && b.pingMs === null) return 0;
      if (a.pingMs === null) return 1;
      if (b.pingMs === null) return -1;
      return a.pingMs - b.pingMs;
    })[0];

    setSelected(best);
  }, [subs.nodes, selected]);

  /**
   * Item 6: selecting a node while connected swaps the tunnel in place.
   *
   * reload() goes to the Go Service.reload(), which keeps the tunnel process, the command
   * socket and the status subscription alive — so the user sees a brief reconnect rather than
   * the full stop/start they previously had to do by hand.
   *
   * When disconnected this only records the choice; nothing should start a tunnel because the
   * user tapped a list row.
   */
  const chooseNode = useCallback(
    (node: ServerNode) => {
      userChoseRef.current = true;
      setSelected(node);
      saveSelectedId(node.id);

      if (connection === 'connected' || connection === 'connecting') {
        // Full stop/start, not a hot reload - see switchTo for why the reload path stalled.
        void switchTo(node.config, node.name).catch(() => {
          // Surfaced by ServersView's toast; swallowing here keeps selection working even if
          // the swap fails.
        });
      }
    },
    [connection, switchTo],
  );

  return (
    <div className="w-full max-w-md h-full bg-brand-navy border-x border-brand-border/40 flex flex-col relative overflow-hidden shadow-2xl">
      {!native && <StubBanner />}
      <Header node={selected} />

      {/*
        Views are unmounted rather than hidden. LogsView refetches its ring on mount, so
        returning to the tab gets fresh output with no polling timer — and an unmounted view
        cannot hold a subscription open behind the user's back. The state that must survive a
        tab change (connection, uptime, totals) lives in NexusProvider, not in the views.
      */}
      {/*
        flex-1 min-h-0 overflow-hidden is the load-bearing trio.

        min-h-0 lets this shrink below its content's intrinsic height — without it a flex item
        refuses to shrink and pushes the nav off-screen. overflow-hidden keeps a tall view's
        scrollbar inside this box instead of resizing the shell. Each view owns its own
        scrolling.
      */}
      <main className="flex-1 min-h-0 overflow-hidden">
        {tab === 'home' && <HomeView node={selected} />}
        {tab === 'servers' && (
          <ServersView selectedId={selected?.id ?? null} onSelect={chooseNode} subs={subs} />
        )}
        {tab === 'logs' && <LogsView />}
      </main>

      <BottomNav active={tab} onChange={setTab} />
    </div>
  );
}

function Header({ node }: { node: ServerNode | null }) {
  const { connection } = useNexus();

  const online = connection === 'connected';
  const busy = connection === 'connecting';

  return (
    <header
      className="shrink-0 px-5 pb-3 flex items-center justify-between z-20 border-b border-brand-border/30 bg-brand-navy/90 backdrop-blur-md"
      style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
    >
      <div className="flex items-center gap-2.5">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-orange to-brand-orange-dark flex items-center justify-center shadow-glow-orange-sm">
          <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 1a5 5 0 00-5 5v3H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm3 8H9V6a3 3 0 016 0v3z" />
          </svg>
        </div>
        <div>
          <div className="text-lg font-extrabold tracking-tight leading-none">
            <span className="text-white">Nex</span>
            <span className="text-brand-orange">us</span>
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                online ? 'bg-emerald-400' : busy ? 'bg-brand-orange animate-pulse' : 'bg-slate-500'
              }`}
            />
            <span className="text-[10px] font-medium text-brand-muted tracking-wide uppercase">
              {online ? 'Online' : busy ? 'Connecting' : 'Offline'}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="px-2.5 py-1.5 rounded-xl bg-brand-surface border border-brand-border text-[11px] font-mono font-semibold text-brand-orange flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-400' : 'bg-brand-orange'}`} />
          {protocolOf(node)}
        </span>
      </div>
    </header>
  );
}

/**
 * Visible marker that the UI is talking to plugin.web.ts, not a real core.
 *
 * Worth the screen space: the stub is convincing enough that it is genuinely easy to spend an
 * afternoon polishing behaviour that does not exist on a device. Numbers here are synthetic.
 */
function StubBanner() {
  return (
    <div className="shrink-0 px-4 py-1.5 bg-amber-950/60 border-b border-amber-800/50 flex items-center gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
      <span className="text-[10px] font-mono text-amber-300 tracking-wide">
        WEB STUB — synthetic data, no core attached
      </span>
    </div>
  );
}
