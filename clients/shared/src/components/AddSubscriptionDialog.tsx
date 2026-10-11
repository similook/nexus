import { useEffect, useMemo, useState } from 'react';
import { extractConfigUris } from '../core/subscription';

/**
 * One field for everything the user can paste.
 *
 * There used to be a mode switch — "Subscription" or "Single config" — and it was a question
 * the app had no business asking. The text itself says which it is: a URL starts with http,
 * a config starts with a protocol scheme. Making the user classify their own clipboard is
 * work the machine can do, and getting it wrong meant a confusing rejection rather than an
 * import.
 *
 * Still warns about http:// rather than silently accepting or refusing it. The user asked for
 * both schemes and there are real panels that serve only plain HTTP — but a subscription body
 * carries server addresses, UUIDs and passwords, so over http:// anyone on the path can read
 * and rewrite it. Telling them is the honest middle ground.
 */

type Detected =
  | { kind: 'empty' }
  | { kind: 'subscription'; url: string; insecure: boolean }
  | { kind: 'configs'; uris: string[] }
  | { kind: 'unknown' };

/**
 * Decide what the pasted text is.
 *
 * Order matters. A subscription URL is checked FIRST and against the whole trimmed input,
 * because some panels hand out links with a proxy scheme inside the query string — scanning
 * for URIs first would pull that fragment out and import a broken node instead of fetching
 * the list.
 */
function detect(raw: string): Detected {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'empty' };

  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return { kind: 'subscription', url: trimmed, insecure: /^http:\/\//i.test(trimmed) };
  }

  const uris = extractConfigUris(trimmed);
  if (uris.length > 0) return { kind: 'configs', uris };

  return { kind: 'unknown' };
}

export function AddSubscriptionDialog({
  open,
  busy,
  onSubmitSubscription,
  onSubmitConfigs,
  onScan,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  onSubmitSubscription: (url: string) => void;
  onSubmitConfigs: (uris: string[]) => void;
  onScan: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');

  /**
   * Discard the draft whenever the sheet closes.
   *
   * Keyed on `open` rather than done in the close handler, because the sheet can be dismissed
   * three ways — the ✕, the backdrop, and a successful import — and a handler-based reset has
   * to be remembered at each one. This cannot be forgotten.
   */
  useEffect(() => {
    if (!open) setText('');
  }, [open]);

  // Scanning runs on every keystroke and a paste can be thousands of characters, so memoise
  // on the text rather than re-deriving during render.
  const detected = useMemo(() => detect(text), [text]);

  if (!open) return null;

  const submit = () => {
    if (busy) return;
    if (detected.kind === 'subscription') onSubmitSubscription(detected.url);
    else if (detected.kind === 'configs') onSubmitConfigs(detected.uris);
  };

  const canSubmit = detected.kind === 'subscription' || detected.kind === 'configs';

  return (
    <div
      className="absolute inset-0 z-50 flex items-end bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Add server"
      onClick={onClose}
    >
      <div
        className="w-full rounded-t-3xl bg-brand-surface border-t border-x border-brand-border p-5 pb-8 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-white tracking-tight">Add Server</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-lg bg-brand-navy border border-brand-border text-brand-muted hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="import-input" className="block text-[11px] text-brand-muted">
              Paste a link, or scan a QR code
            </label>
            <button
              onClick={onScan}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-brand-navy border border-brand-border text-xs font-medium text-brand-orange hover:text-brand-orange-glow active:scale-95 transition-all"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5zM13.5 13.5h2.25v2.25H13.5zM18 18h2.25v2.25H18zM13.5 18h2.25v2.25H13.5zM18 13.5h2.25v2.25H18z" />
              </svg>
              Scan
            </button>
          </div>
          {/*
            A textarea, not an input. Multi-config paste is a first-class case — people copy
            whole blocks out of channels — and a single-line field hides all but the first
            line of what they just pasted, which looks like it was truncated.
          */}
          <textarea
            id="import-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            autoComplete="off"
            spellCheck={false}
            placeholder={'https://example.com/sub\nvless://…\nvmess://…'}
            className="w-full px-3.5 py-2.5 rounded-xl bg-brand-navy border border-brand-border text-sm text-white font-mono placeholder:text-brand-muted/60 focus:outline-none focus:border-brand-orange resize-none"
          />

          {/* What we detected, said out loud before anything is imported. */}
          <div className="min-h-[1.25rem] text-[11px] leading-relaxed">
            {detected.kind === 'subscription' && (
              <span className="text-emerald-400">
                Subscription link detected
                {detected.insecure && (
                  <span className="block text-amber-400">
                    ⚠ Plain http:// — the list travels unencrypted, and it contains your
                    credentials. Anyone on the path can read or alter it.
                  </span>
                )}
              </span>
            )}
            {detected.kind === 'configs' && (
              <span className="text-emerald-400">
                {detected.uris.length === 1
                  ? '1 config link detected'
                  : `${detected.uris.length} config links detected`}
              </span>
            )}
            {detected.kind === 'unknown' && (
              <span className="text-brand-muted">
                No link found yet. Expected http(s):// for a subscription, or vless:// vmess://
                trojan:// ss:// hysteria2:// tuic:// for a config.
              </span>
            )}
          </div>
        </div>

        <button
          onClick={submit}
          disabled={!canSubmit || busy}
          className="w-full py-3 rounded-xl bg-gradient-to-r from-brand-orange to-brand-orange-dark text-white font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
        >
          {busy
            ? 'Importing…'
            : detected.kind === 'configs' && detected.uris.length > 1
              ? `Import ${detected.uris.length} configs`
              : 'Import'}
        </button>
      </div>
    </div>
  );
}
