import { useEffect, useState } from 'react';
import { AddSubscriptionDialog } from '../components/AddSubscriptionDialog';
import { NodeSheet, type NodeSheetTab } from '../components/NodeSheet';
import { SubscriptionShareSheet } from '../components/SubscriptionShareSheet';
import { QrScanner } from '../components/QrScanner';
import { useToast } from '../components/Toast';
import { useNexus } from '../core/NexusProvider';
import type { SubscriptionRecord, UseSubscriptions } from '../core/useSubscriptions';
import { extractConfigUris, type SubscriptionUserinfo } from '../core/subscription';
import { isQuicProtocol, pingTone, vpnLatencyTone, type ServerNode } from '../data/servers';
import { formatQuota } from '../core/format';
import { coreEvents } from '../core/coreEvents';
import { usePlatform } from '../platform';
import { useServerTests, type DelayCell, type TcpCell, type TestAllSummary } from '../core/useServerTests';
import { realityMlkemVariant } from '../core/realityMlkem';

export function ServersView({
  selectedId,
  onSelect,
  subs,
}: {
  selectedId: string | null;
  onSelect: (node: ServerNode) => void;
  subs: UseSubscriptions;
}) {
  const { core } = usePlatform();
  const toast = useToast();
  const { connection, activeConfig } = useNexus();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  /**
   * TCP and Delay per node id: two separate maps owned by useServerTests, never merged.
   *
   * DELIBERATELY NOT PERSISTED and not written onto the node. A latency figure is true for one
   * moment on one network; storing it would leave a stale number sitting next to a node the
   * user is choosing between, which is worse than "--".
   */
  const tests = useServerTests(
    subs.nodes,
    (summary: TestAllSummary) => {
      if (!summary.cancelled) toast(`${summary.delayOk} of ${summary.delayTotal} working`);
    },
    // A REALITY server that fails its handshake is retried with the ML-KEM key share, and the
    // switch turns on when that is what it takes (realityMlkem.ts, AUTOMATIC DETECTION).
    {
      variant: (node) => (subs.realityMlkemCheckable(node) ? realityMlkemVariant(node) : null),
      verdict: (node, needed) => void subs.applyRealityMlkemVerdict(node, needed),
    },
  );

  /** Which node the details/edit/share sheet is showing, and on which tab. */
  const [sheet, setSheet] = useState<{ node: ServerNode; tab: NodeSheetTab } | null>(null);
  /** Which subscription's share sheet is open. */
  const [sharing, setSharing] = useState<SubscriptionRecord | null>(null);
  const [scanning, setScanning] = useState(false);
  const totalNodes = subs.nodes.length;

  /**
   * Live: the core's own answer for the running tunnel, shown as a toast.
   *
   * NOT written into a row. On desktop nexusd's pingProxy is a TCP dial through the tunnel, not
   * the URL test the Delay column holds (core/desktop/ipc/server.go), so the two would share a
   * column without measuring the same thing. The rows' Delay comes from Test All's per-server
   * probe only.
   */
  useEffect(
    () =>
      coreEvents.subscribe('proxyDelay', ({ delayMs, ok }) => {
        toast(ok ? `${delayMs} ms through the tunnel` : 'No response through the tunnel', ok ? undefined : '⚠');
      }),
    [toast],
  );

  /**
   * Test every node in the list - TCP and Delay, each for every server, independently.
   *
   * TCP is a direct handshake to each server (n/a for UDP-only protocols). Delay is each
   * server's own config, handshake and authentication included, URL-tested by a short-lived
   * core instance beside the tunnel. Neither switches, reconnects or goes through the tunnel -
   * nexusd keeps both off an active one (core/desktop/ipc/probe.go) - so this works connected
   * or not and the running server is untouched. See useServerTests.
   *
   * Tapping again while it runs cancels it.
   */
  const handleTestAll = () => {
    if (tests.progress !== null) {
      tests.cancel();
      return;
    }
    if (subs.nodes.length === 0) {
      toast('Nothing to test yet', 'ℹ');
      return;
    }
    tests.start(subs.nodes);
  };

  /**
   * Persist an edited node.
   *
   * An edit changes the node's ID, because the ID is a hash of its URI - so this is a remove
   * plus an add, not an update in place. Doing it as one batch keeps the list from flickering
   * through a state where neither version exists.
   */
  const handleEditSave = (original: ServerNode, updated: ServerNode) => {
    // The stored node, which carries the REALITY ML-KEM switch over from the original.
    const stored = subs.replaceNode(original.id, updated);
    // Follow the edit: if the user was pointed at this node, they still mean to be, and the
    // old id is about to stop existing.
    if (selectedId === original.id) onSelect(stored);
  };

  /**
   * The sheet's REALITY ML-KEM switch. Read from the live list rather than the sheet's copy
   * of the node, which is a snapshot taken when the sheet opened.
   */
  const sheetMlkem = (() => {
    if (sheet === null) return null;
    const live = subs.nodes.find((n) => n.id === sheet.node.id) ?? sheet.node;
    return {
      state: subs.realityMlkem(live),
      running: activeConfig !== null && live.config === activeConfig,
      onChange: (on: boolean) => {
        if (subs.setRealityMlkem(live, on)) {
          toast(on ? 'ML-KEM on for this server' : 'ML-KEM off for this server');
        }
      },
    };
  })();

  /**
   * A scanned QR is treated exactly like a paste.
   *
   * QR codes in this ecosystem carry either a single config URI or a subscription URL, and the
   * scanner cannot tell which - so it hands the raw text to the same detection the import box
   * uses rather than guessing.
   */
  const handleScanned = (text: string) => {
    const trimmed = text.trim();
    if (/^https?:\/\/\S+$/i.test(trimmed)) {
      void handleAdd(trimmed);
      return;
    }
    const uris = extractConfigUris(trimmed);
    if (uris.length === 0) {
      toast('That QR code is not a config or subscription link', '⚠');
      return;
    }
    handleAddConfigs(uris);
  };

  /** Ask the core for the real, proxied latency of the node it is running. */
  const handleTestLive = async () => {
    if (connection !== 'connected') {
      toast('Connect first — this measures the live tunnel', 'ℹ');
      return;
    }
    try {
      await core.pingProxy();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Test failed', '⚠');
    }
  };

  const handleSelect = (node: ServerNode) => {
    onSelect(node);
    // The swap is live now (App.chooseNode calls reload when connected), so the message says
    // what actually happens rather than asking the user to do something they no longer need to.
    toast(
      connection === 'connected' || connection === 'connecting'
        ? `Switching to ${node.name}…`
        : `Selected ${node.name}`,
    );
  };

  const handleAdd = async (url: string) => {
    try {
      const { imported, failed } = await subs.add(url);
      setDialogOpen(false);
      // Report partial success honestly. "18 imported" when 2 were dropped is a lie the user
      // discovers later, at the worst moment.
      toast(
        failed > 0
          ? `${imported} nodes imported, ${failed} skipped`
          : `${imported} nodes imported`,
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Import failed', '⚠');
    }
  };

  /**
   * Import one or many pasted config links.
   *
   * Never throws the batch away over a single bad entry - a paste out of a channel routinely
   * contains a dead or truncated link, and refusing all of them because of one would be the
   * wrong trade. The count in the toast is the exact number that landed, not the number
   * pasted; reporting the latter is a lie the user discovers later.
   */
  const handleAddConfigs = (uris: string[]) => {
    const { imported, failed, failures } = subs.addManualBatch(uris);

    if (imported === 0) {
      toast(failures[0]?.reason ?? 'Could not parse those links', '⚠');
      return;
    }

    setDialogOpen(false);
    toast(
      failed > 0
        ? `${imported} config${imported === 1 ? '' : 's'} added, ${failed} skipped`
        : `${imported} config${imported === 1 ? '' : 's'} added`,
    );
  };

  const handleRefresh = async (id: string, name: string) => {
    try {
      const { imported, failed } = await subs.refresh(id);
      toast(failed > 0 ? `${name}: ${imported} nodes, ${failed} skipped` : `${name}: ${imported} nodes`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Update failed', '⚠');
    }
  };

  return (
    <section id="view-servers" role="tabpanel" className="h-full min-h-0 flex flex-col px-5 pt-3 pb-2 overflow-hidden">
      {/* Sticky header */}
      <div className="shrink-0 pb-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-white tracking-tight">Server Nodes</h2>
            {/*
              inline-flex + items-center, not a bare span.
              A span is inline, so its box is sized by the font's line box rather than its
              content - the pill ends up taller than the glyphs and the text sits high inside
              it. That is worse here than usual because the number is `font-mono` and the word
              is not: two fonts with different metrics sharing one inline baseline.

              leading-none hands vertical centring to the flex container instead of the line
              height, and the symmetric px/py then actually centre what is inside.
            */}
            <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-full bg-brand-surface-card border border-brand-border text-[11px] font-mono leading-none text-brand-orange font-semibold">
              {totalNodes} Configs
            </span>
          </div>
          {/*
            Test All + Live share a group so the outer justify-between always sees exactly
            TWO children.

            Without this wrapper the Live button - which only renders while connected - became
            a third child of a justify-between row, and the free space redistributed the moment
            the tunnel came up: Test All slid to the centre and the header looked broken in the
            connected state only.
          */}
          <div className="flex items-center gap-2">
          <button
            onClick={handleTestAll}
            aria-label={
              tests.progress !== null
                ? `Testing ${tests.progress.done} of ${tests.progress.total}, tap to cancel`
                : 'Test all servers'
            }
            title="TCP and Delay for every server, each through its own config — never switches the tunnel"
            className="text-xs text-brand-orange hover:text-brand-orange-glow font-medium flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-brand-surface border border-brand-border active:scale-95 transition-all disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
            <span className="tabular-nums">
              {tests.progress !== null ? `Testing ${tests.progress.done}/${tests.progress.total} ✕` : 'Test All'}
            </span>
          </button>
          {connection === 'connected' && (
            <button
              onClick={() => void handleTestLive()}
              title="Ask the core for the live tunnel's latency — proves the credentials work, not just that the host answers"
              className="text-xs text-emerald-400 hover:text-emerald-300 font-medium px-2.5 py-1.5 rounded-xl bg-brand-surface border border-brand-border active:scale-95 transition-all"
            >
              Live
            </button>
          )}
          </div>
        </div>

        <button
          onClick={() => setDialogOpen(true)}
          className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-brand-orange to-brand-orange-dark hover:from-brand-orange-glow hover:to-brand-orange text-white font-bold text-xs flex items-center justify-center gap-2 shadow-glow-orange-sm active:scale-[0.98] transition-all"
        >
          <span className="text-base leading-none">+</span>
          Add Subscription
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 min-h-0 space-y-4 overflow-y-auto pr-0.5 pb-4 custom-scroll">
        {subs.subscriptions.length === 0 && (
          <div className="rounded-2xl border border-dashed border-brand-border p-6 text-center space-y-1">
            <p className="text-sm font-semibold text-slate-300">No subscriptions yet</p>
            <p className="text-[11px] text-brand-muted leading-relaxed">
              Add a subscription link to import server nodes automatically.
            </p>
          </div>
        )}

        {subs.subscriptions.map((record) => {
          const isOpen = expanded[record.id] ?? true;
          return (
            <div
              key={record.id}
              className="rounded-2xl border border-brand-orange/40 bg-gradient-to-b from-brand-surface-card to-brand-surface overflow-hidden shadow-lg"
            >
              <div className="p-3.5 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 shrink-0 rounded-xl bg-brand-orange/20 border border-brand-orange/50 flex items-center justify-center text-brand-orange">
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-bold text-white tracking-tight truncate">
                          {record.name}
                        </span>
                        {record.insecure && (
                          <span
                            title="Fetched over http:// — contents travelled unencrypted"
                            className="px-1 py-px shrink-0 rounded text-[9px] font-mono font-semibold bg-amber-950/60 border border-amber-800/50 text-amber-400"
                          >
                            HTTP
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        <span className="text-[10px] text-brand-muted">
                          {record.nodes.length} nodes • updated{' '}
                          {new Date(record.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <IconBtn
                      label="Update"
                      onClick={() => void handleRefresh(record.id, record.name)}
                      disabled={subs.busy}
                      spinning={subs.busy}
                      path="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                    />
                    <IconBtn
                      label="Share"
                      onClick={() => setSharing(record)}
                      path="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
                    />
                    <IconBtn
                      label="Delete"
                      danger
                      onClick={() => {
                        subs.remove(record.id);
                        toast(`${record.name} removed`);
                      }}
                      path={TRASH_PATH}
                    />
                    <IconBtn
                      label={isOpen ? 'Collapse' : 'Expand'}
                      onClick={() => setExpanded((p) => ({ ...p, [record.id]: !isOpen }))}
                      path="M19.5 8.25l-7.5 7.5-7.5-7.5"
                      rotated={!isOpen}
                    />
                  </div>
                </div>

                <UserinfoPanel info={record.userinfo} />
              </div>

              {isOpen && (
                <div className="border-t border-brand-border/40 bg-brand-navy/60 p-2.5 space-y-2">
                  {record.nodes.map((node) => (
                    <NodeRow
                      key={node.id}
                      node={node}
                      selected={node.id === selectedId}
                      onSelect={handleSelect}
                      tcp={tests.tcp[node.id]}
                      delay={tests.delay[node.id]}
                      onReason={(reason) => toast(reason, '⚠')}
                      onInspect={(n, tab) => setSheet({ node: n, tab })}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {subs.manualNodes.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-brand-muted">
                Manually added
              </h3>
              <span className="text-[11px] text-brand-muted">{subs.manualNodes.length} items</span>
            </div>
            {subs.manualNodes.map((node) => (
              <div key={node.id} className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <NodeRow
                    node={node}
                    selected={node.id === selectedId}
                    onSelect={handleSelect}
                    tcp={tests.tcp[node.id]}
                    delay={tests.delay[node.id]}
                    onReason={(reason) => toast(reason, '⚠')}
                    onInspect={(n, tab) => setSheet({ node: n, tab })}
                  />
                </div>
                <IconBtn
                  label="Remove"
                  danger
                  onClick={() => {
                    subs.removeManual(node.id);
                    toast(`${node.name} removed`);
                  }}
                  path={TRASH_PATH}
                />
              </div>
            ))}
          </div>
        )}

      </div>

      <NodeSheet
        node={sheet?.node ?? null}
        initialTab={sheet?.tab ?? 'details'}
        mlkem={sheetMlkem}
        onSave={handleEditSave}
        onClose={() => setSheet(null)}
        onToast={toast}
      />

      <SubscriptionShareSheet record={sharing} onClose={() => setSharing(null)} onToast={toast} />

      {/*
        These handlers are inline and get a new identity on every render of this component -
        which is roughly once a second, because ServersView subscribes to the core status
        stream. That is SAFE only because QrScanner keeps onResult in a ref and depends on
        `open` alone; when it listed the callback as a dependency instead, the camera was torn
        down and reopened on every status tick and visibly flickered.

        If you ever move that callback back into QrScanner's dependency array, memoise these
        first - or the flicker comes back.
      */}
      <QrScanner
        open={scanning}
        onResult={(text) => {
          setScanning(false);
          handleScanned(text);
        }}
        onClose={() => setScanning(false)}
      />

      <AddSubscriptionDialog
        open={dialogOpen}
        onScan={() => {
          // Close the sheet first: the scanner is full-screen and a bottom sheet left mounted
          // underneath keeps its backdrop click handler live.
          setDialogOpen(false);
          setScanning(true);
        }}
        busy={subs.busy}
        onSubmitSubscription={(url) => void handleAdd(url)}
        onSubmitConfigs={handleAddConfigs}
        onClose={() => setDialogOpen(false)}
      />
    </section>
  );
}

/**
 * Quota and expiry from the Subscription-Userinfo header.
 *
 * Renders nothing at all when the panel sent no header — an empty bar reading "0 GB" would be
 * a fabrication, and the user would plan around it. Each field is independently optional for
 * the same reason.
 */
function UserinfoPanel({ info }: { info: SubscriptionUserinfo | null }) {
  if (!info) return null;

  const used = (info.uploadBytes ?? 0) + (info.downloadBytes ?? 0);
  const total = info.totalBytes;
  // total = 0 is the common "unlimited" sentinel, not "no quota left".
  const hasQuota = total !== null && total > 0;
  const ratio = hasQuota ? Math.min(1, used / total) : 0;
  const remaining = hasQuota ? Math.max(0, total - used) : null;

  const daysLeft =
    info.expiresAt !== null
      ? Math.max(0, Math.ceil((info.expiresAt - Date.now()) / 86_400_000))
      : null;

  return (
    <div className="space-y-2 pt-1">
      {daysLeft !== null && (
        <div className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${daysLeft <= 3 ? 'bg-rose-400' : 'bg-emerald-400'}`}
          />
          <span
            className={`text-[10px] font-mono font-medium px-1.5 py-px rounded border ${
              daysLeft <= 3
                ? 'text-rose-400 bg-rose-950/60 border-rose-800/40'
                : 'text-emerald-400 bg-emerald-950/60 border-emerald-800/40'
            }`}
          >
            {daysLeft === 0 ? 'Expired' : `${daysLeft} days left`}
          </span>
        </div>
      )}

      {hasQuota && (
        <div>
          <div className="flex items-center justify-between text-[11px] font-mono mb-1.5">
            <span className="text-slate-300 font-semibold">
              {formatQuota(used)} <span className="text-brand-muted font-normal">/ {formatQuota(total)}</span>
            </span>
            <span className={ratio > 0.9 ? 'text-rose-400 font-medium' : 'text-brand-orange font-medium'}>
              Remaining: {formatQuota(remaining ?? 0)}
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-brand-navy border border-brand-border/80 overflow-hidden">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${
                ratio > 0.9
                  ? 'bg-gradient-to-r from-rose-600 to-rose-400'
                  : 'bg-gradient-to-r from-amber-500 to-brand-orange'
              }`}
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Heroicons' outline trash, lid included: the same path as Logs → Clear. */
const TRASH_PATH =
  'M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0';

function IconBtn({
  label,
  path,
  onClick,
  danger = false,
  disabled = false,
  spinning = false,
  rotated = false,
}: {
  label: string;
  path: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  spinning?: boolean;
  rotated?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`w-7 h-7 rounded-lg bg-brand-surface border border-brand-border/80 flex items-center justify-center transition-colors disabled:opacity-40 ${
        danger ? 'text-brand-muted hover:text-rose-400 hover:bg-rose-950/40' : 'text-brand-muted hover:text-white'
      }`}
    >
      <svg
        className={`w-3.5 h-3.5 transition-transform ${spinning ? 'animate-spin' : ''} ${rotated ? '-rotate-90' : ''}`}
        fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={path} />
      </svg>
    </button>
  );
}

function NodeRow({
  node,
  selected,
  onSelect,
  tcp,
  delay,
  onReason,
  onInspect,
}: {
  node: ServerNode;
  selected: boolean;
  onSelect: (node: ServerNode) => void;
  /** TCP: Test All's direct handshake; overrides the stored one while it is fresh. */
  tcp?: TcpCell;
  /** Delay: Test All's per-server probe. */
  delay?: DelayCell;
  /** Show why a Delay failed (sanitized: Timeout, Refused, Rejected...). */
  onReason: (reason: string) => void;
  onInspect: (node: ServerNode, tab: NodeSheetTab) => void;
}) {
  return (
    /*
      A div wrapping a button, not one big button.
      The row now carries its own actions, and a <button> inside a <button> is invalid HTML -
      browsers resolve the ambiguity by firing BOTH handlers, so tapping "edit" would also
      select the node and, while connected, reconnect the tunnel.
    */
    <div
      className={`w-full p-2.5 rounded-xl border flex items-center gap-2 transition-all ${
        selected
          ? 'border-brand-orange bg-brand-surface-card'
          : 'border-brand-border bg-brand-surface hover:border-brand-border/60'
      }`}
    >
      <button
        onClick={() => onSelect(node)}
        aria-pressed={selected}
        className="flex-1 min-w-0 text-left flex items-center gap-2.5 active:scale-[0.99] transition-transform"
      >
        <span
          className={`w-4 h-4 shrink-0 rounded-full border flex items-center justify-center ${
            selected ? 'border-brand-orange bg-brand-orange/20' : 'border-brand-border'
          }`}
        >
          {selected && <span className="w-2 h-2 rounded-full bg-brand-orange shadow-glow-orange-sm" />}
        </span>
        <span className="text-base leading-none">{node.flag}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className={`text-xs font-bold truncate ${selected ? 'text-brand-orange' : 'text-white'}`}>
              {node.name}
            </span>
            <span className="px-1.5 py-px shrink-0 rounded text-[9px] font-mono font-semibold bg-brand-navy border border-brand-border text-brand-muted">
              {node.protocol}
            </span>
            {/* ADR-0001 §5.1: QUIC protocols hold a connection open with periodic heartbeats,
                which keeps the cellular radio promoted at idle. The user is entitled to know
                that before picking the node with the best ping. */}
            {isQuicProtocol(node.protocol) && (
              <span
                title="Higher idle battery use — keeps a QUIC connection alive"
                className="px-1 py-px shrink-0 rounded text-[9px] font-mono font-semibold bg-amber-950/60 border border-amber-800/50 text-amber-400"
              >
                ⚡
              </span>
            )}
            {/* A node whose config could not be regenerated is running output from an older
                build. It will fail in ways that read as a dead server, so say so here rather
                than let the user burn an evening on it. */}
            {node.staleReason && (
              <span
                title={`Config is out of date: ${node.staleReason}. Remove and re-add this subscription.`}
                className="px-1 py-px shrink-0 rounded text-[9px] font-mono font-semibold bg-red-950/60 border border-red-800/50 text-red-400"
              >
                STALE
              </span>
            )}
          </span>
          <span className="block text-[10px] text-brand-muted truncate">
            {node.country} • {node.transport}
          </span>
        </span>
      </button>

      {/* TCP (direct handshake) and Delay (URL test through each server) - two different
          measurements, never merged, each on its own colour bands. Stacked and compact, so the
          row keeps its height and the host keeps its width. */}
      <span className="shrink-0 grid grid-cols-[auto_auto] items-center gap-x-1 gap-y-0.5">
        <RowLatency label="TCP" {...tcpChip(tcp, node.pingMs)} />
        <RowLatency
          label="Delay"
          {...delayChip(delay)}
          onClick={delay?.kind === 'failed' ? () => onReason(`Delay: ${delay.reason}`) : undefined}
        />
      </span>

      <IconBtn
        label="Edit or view details"
        onClick={() => onInspect(node, 'details')}
        path="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zM19.5 14.25v4.125A2.625 2.625 0 0116.875 21H5.625A2.625 2.625 0 013 18.375V7.125A2.625 2.625 0 015.625 4.5H9.75"
      />
      <IconBtn
        label="Share"
        onClick={() => onInspect(node, 'share')}
        path="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
      />
    </div>
  );
}

const FAILED_TONE = 'text-rose-400 bg-rose-950/50 border-rose-800/40';
const MUTED_TONE = pingTone(null);

/** `--` untested, `…` testing, a number (TCP bands), `✕` failed, `n/a` UDP-only server. */
function tcpChip(cell: TcpCell | undefined, stored: number | null): { text: string; tone: string } {
  if (cell === undefined) {
    return stored === null ? { text: '--', tone: MUTED_TONE } : { text: `${stored}`, tone: pingTone(stored) };
  }
  switch (cell.kind) {
    case 'testing':
      return { text: '…', tone: MUTED_TONE };
    case 'ms':
      return { text: `${cell.ms}`, tone: pingTone(cell.ms) };
    case 'failed':
      return { text: '✕', tone: FAILED_TONE };
    case 'na':
      return { text: 'n/a', tone: MUTED_TONE };
  }
}

/** `--` untested, `…` testing, a number (Delay bands), `✕` failed. */
function delayChip(cell: DelayCell | undefined): { text: string; tone: string } {
  if (cell === undefined) return { text: '--', tone: MUTED_TONE };
  switch (cell.kind) {
    case 'testing':
      return { text: '…', tone: MUTED_TONE };
    case 'ms':
      return { text: `${cell.ms}`, tone: vpnLatencyTone(cell.ms) };
    case 'failed':
      return { text: '✕', tone: FAILED_TONE };
  }
}

/**
 * One labelled figure of a row's TCP/Delay pair, in milliseconds without the unit (the labels
 * say what it is, and the width goes to the server name). A minimum width keeps the row from
 * shifting as `…` turns into a number. Tappable only when it has a reason to show.
 */
function RowLatency({
  label,
  text,
  tone,
  onClick,
}: {
  label: string;
  text: string;
  tone: string;
  onClick?: () => void;
}) {
  const chip = `min-w-[24px] text-center text-[9px] font-mono font-semibold leading-none px-1 py-px rounded border ${tone}`;
  return (
    <>
      <span className="text-[9px] font-semibold text-brand-muted text-right leading-none">{label}</span>
      {onClick ? (
        <button type="button" onClick={onClick} aria-label={`${label} failed: show why`} className={chip}>
          {text}
        </button>
      ) : (
        <span className={chip}>{text}</span>
      )}
    </>
  );
}
