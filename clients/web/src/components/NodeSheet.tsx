import { useEffect, useMemo, useState } from 'react';
import { Clipboard } from '@capacitor/clipboard';
import { applyEdit, describeNode, editableOf } from '../core/nodeDetails';
import type { ServerNode } from '../data/servers';

/**
 * Details / edit / share for one node.
 *
 * One sheet with three tabs rather than three sheets, because all three answer questions about
 * the same object and the user does not know which one they want until they have looked.
 */

export type NodeSheetTab = 'details' | 'edit' | 'share';

export function NodeSheet({
  node,
  initialTab,
  onSave,
  onClose,
  onToast,
}: {
  node: ServerNode | null;
  initialTab: NodeSheetTab;
  onSave: (original: ServerNode, updated: ServerNode) => void;
  onClose: () => void;
  onToast: (message: string, icon?: string) => void;
}) {
  const [tab, setTab] = useState<NodeSheetTab>(initialTab);
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState({ name: '', server: '', port: '' });
  const [qr, setQr] = useState<string | null>(null);

  // Re-seed on every open. Without this, reopening shows the PREVIOUS node's draft, and a
  // stray Save would write one node's address onto another.
  useEffect(() => {
    if (node === null) return;
    setTab(initialTab);
    setRevealed(false);
    const fields = editableOf(node);
    setDraft({ name: fields.name, server: fields.server, port: String(fields.port) });
  }, [node, initialTab]);

  // Encoding a QR is synchronous work proportional to the URI length, so it runs once per
  // node and only while the share tab is actually open.
  useEffect(() => {
    if (node === null || tab !== 'share' || !node.uri) {
      setQr(null);
      return;
    }
    let live = true;
    // Loaded on demand. The encoder is ~130KB and is needed only when this tab is opened, so
    // keeping it in the main bundle would tax every cold start of the app for a screen most
    // sessions never reach.
    const uri = node.uri;
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(uri, {
          width: 512,
          margin: 2,
          errorCorrectionLevel: 'M',
          // Dark modules on white, always. A QR rendered in the app's dark palette is
          // unreadable to most scanners, which assume dark-on-light and do not try inverting.
          color: { dark: '#0F172A', light: '#FFFFFF' },
        }),
      )
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        if (live) setQr(null);
      });
    return () => {
      live = false;
    };
  }, [node, tab]);

  const rows = useMemo(() => (node === null ? [] : describeNode(node)), [node]);

  if (node === null) return null;

  const save = () => {
    try {
      const port = Number.parseInt(draft.port, 10);
      const updated = applyEdit(node, { name: draft.name, server: draft.server, port });
      onSave(node, updated);
      onToast('Saved');
      onClose();
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Could not save', '⚠');
    }
  };

  const copy = async () => {
    if (!node.uri) {
      onToast('This node has no shareable link', '⚠');
      return;
    }
    try {
      await Clipboard.write({ string: node.uri });
      onToast('Link copied');
    } catch {
      onToast('Could not copy', '⚠');
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-end bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Server details"
      onClick={onClose}
    >
      <div
        className="w-full max-h-[85%] flex flex-col rounded-t-3xl bg-brand-surface border-t border-x border-brand-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 p-5 pb-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-bold text-white tracking-tight truncate">{node.name}</h3>
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-7 h-7 shrink-0 rounded-lg bg-brand-navy border border-brand-border text-brand-muted hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-brand-navy border border-brand-border">
            {(['details', 'edit', 'share'] as NodeSheetTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`py-2 rounded-lg text-xs font-semibold capitalize transition-colors ${
                  tab === t ? 'bg-brand-orange text-white' : 'text-brand-muted hover:text-slate-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-8 custom-scroll">
          {tab === 'details' && (
            <dl className="space-y-1.5">
              {rows.map((row) => (
                <div
                  key={row.label}
                  className="flex items-start justify-between gap-3 py-1.5 border-b border-brand-border/40"
                >
                  <dt className="text-[11px] text-brand-muted shrink-0">{row.label}</dt>
                  <dd className="text-[11px] font-mono text-slate-200 text-right break-all">
                    {row.secret && !revealed ? '••••••••' : row.value}
                  </dd>
                </div>
              ))}
              {rows.some((r) => r.secret) && (
                <button
                  onClick={() => setRevealed((v) => !v)}
                  className="mt-2 text-[11px] text-brand-orange hover:text-brand-orange-glow"
                >
                  {revealed ? 'Hide credentials' : 'Reveal credentials'}
                </button>
              )}
            </dl>
          )}

          {tab === 'edit' && (
            <div className="space-y-3">
              {!node.uri && (
                <p className="text-[11px] text-amber-400">
                  This node has no source link, so it cannot be edited.
                </p>
              )}
              <Field
                label="Remarks"
                value={draft.name}
                onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
              />
              <Field
                label="Address"
                value={draft.server}
                onChange={(v) => setDraft((d) => ({ ...d, server: v }))}
              />
              <Field
                label="Port"
                value={draft.port}
                inputMode="numeric"
                onChange={(v) => setDraft((d) => ({ ...d, port: v }))}
              />
              {/*
                Only these three are editable, deliberately. Everything else - protocol,
                transport, security - is interdependent: a transport changed without its path,
                or a security mode without its public key, produces a config that parses
                cleanly and then cannot connect. That failure looks like a dead server and
                costs an evening to trace, which this project has already paid for once.
              */}
              <p className="text-[11px] text-brand-muted leading-relaxed">
                Other parameters come from the link itself. To change them, import an edited
                link — a half-changed transport or security block parses fine and then fails at
                connect time.
              </p>
              <button
                onClick={save}
                disabled={!node.uri}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-brand-orange to-brand-orange-dark text-white font-bold text-sm disabled:opacity-40 active:scale-[0.98] transition-all"
              >
                Save
              </button>
            </div>
          )}

          {tab === 'share' && (
            <div className="space-y-4">
              {!node.uri ? (
                <p className="text-[11px] text-amber-400">
                  This node has no source link, so there is nothing to share.
                </p>
              ) : (
                <>
                  <div className="flex justify-center">
                    {qr === null ? (
                      <div className="w-56 h-56 rounded-xl bg-brand-navy border border-brand-border" />
                    ) : (
                      <img
                        src={qr}
                        alt="Config QR code"
                        className="w-56 h-56 rounded-xl bg-white p-2"
                      />
                    )}
                  </div>
                  <p className="text-[11px] text-amber-400 text-center leading-relaxed">
                    This code carries the full credentials for this server. Anyone who scans it
                    can use your account.
                  </p>
                  <button
                    onClick={() => void copy()}
                    className="w-full py-3 rounded-xl bg-brand-navy border border-brand-border text-slate-200 font-semibold text-sm active:scale-[0.98] transition-all"
                  >
                    Copy link
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: 'numeric';
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] text-brand-muted">{label}</span>
      <input
        value={value}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3.5 py-2.5 rounded-xl bg-brand-navy border border-brand-border text-sm text-white font-mono focus:outline-none focus:border-brand-orange"
      />
    </label>
  );
}
