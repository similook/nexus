import { useEffect, useState } from 'react';
import { usePlatform } from '../platform';
import type { SubscriptionRecord } from '../core/useSubscriptions';

/**
 * Share a subscription: its link as a QR code, plus Copy link.
 *
 * clients/web's SubscriptionShareSheet on the platform port: the same mechanism as a node's
 * Share tab (NodeSheet) - QR encoder, warning, port clipboard. What is shared is the
 * subscription URL the user added, never the downloaded node list: the link is what another
 * client imports. Desktop has no native share sheet (Tauri ships none for Windows), so Copy
 * link is the share action, as it is in NodeSheet here.
 *
 * That URL is a bearer credential. Whoever has it can pull every server in the subscription,
 * for as long as the panel serves it - hence the warning. It is never logged, and no message
 * here repeats it.
 */
export function SubscriptionShareSheet({
  record,
  onClose,
  onToast,
}: {
  record: SubscriptionRecord | null;
  onClose: () => void;
  onToast: (message: string, icon?: string) => void;
}) {
  const { clipboard } = usePlatform();
  const [qr, setQr] = useState<string | null>(null);
  const link = record === null ? null : shareableSubscriptionUrl(record.url);

  // Loaded on demand, as in NodeSheet: the encoder is ~130KB and only this sheet needs it.
  useEffect(() => {
    setQr(null);
    if (link === null) return;
    let live = true;
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(link, {
          width: 512,
          margin: 2,
          errorCorrectionLevel: 'M',
          // Dark modules on white, always - scanners assume dark-on-light (see NodeSheet).
          color: { dark: '#0F172A', light: '#FFFFFF' },
        }),
      )
      .then((dataUrl) => {
        if (live) setQr(dataUrl);
      })
      .catch(() => {
        if (live) setQr(null);
      });
    return () => {
      live = false;
    };
  }, [link]);

  if (record === null) return null;

  const copy = async () => {
    if (link === null) {
      onToast('This subscription has no shareable link', '⚠');
      return;
    }
    try {
      await clipboard.write(link);
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
      aria-label="Share subscription"
      onClick={onClose}
    >
      <div
        className="w-full max-h-[85%] flex flex-col rounded-t-3xl bg-brand-surface border-t border-x border-brand-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-4 pb-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-bold text-white tracking-tight truncate">{record.name}</h3>
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-7 h-7 shrink-0 rounded-lg bg-brand-navy border border-brand-border text-brand-muted hover:text-white"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scroll px-5 pb-4">
          {link === null ? (
            <p className="text-sm text-brand-muted text-center py-8">
              This subscription has no shareable link. Remove it and add it again from its original
              subscription URL.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-center">
                {qr === null ? (
                  <div className="w-56 h-56 rounded-xl bg-brand-navy border border-brand-border" />
                ) : (
                  <img src={qr} alt="Subscription QR code" className="w-56 h-56 rounded-xl bg-white p-2" />
                )}
              </div>
              <p className="text-[11px] text-amber-400 text-center leading-relaxed">
                This code carries the full credentials for this subscription. Anyone who scans it
                can use your account.
              </p>
              <button
                onClick={() => void copy()}
                className="w-full py-3 rounded-xl bg-brand-navy border border-brand-border text-slate-200 font-semibold text-sm active:scale-[0.98] transition-all"
              >
                Copy link
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The link to share, exactly as the user added it (trimmed), or null when there is nothing
 * importable to share: missing, unparseable, or not http(s) - the only schemes a subscription is
 * fetched over (core/subscription.ts).
 */
export function shareableSubscriptionUrl(url: string | null | undefined): string | null {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (trimmed === '') return null;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.host !== '' ? trimmed : null;
  } catch {
    return null;
  }
}
