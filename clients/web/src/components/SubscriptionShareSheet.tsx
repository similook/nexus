import { useEffect, useState } from 'react';
import { Clipboard } from '@capacitor/clipboard';
import type { SubscriptionRecord } from '../core/useSubscriptions';

/**
 * Share a subscription: its link as a QR code, plus Copy link.
 *
 * The same mechanism as a node's Share tab (NodeSheet) - QR encoder, warning, clipboard - so a
 * subscription shares exactly like a config does. What is shared is the subscription URL the
 * user added, never the downloaded node list: the link is what another client imports.
 *
 * That URL is a bearer credential. Whoever has it can pull every server in the subscription,
 * for as long as the panel serves it - hence the same warning as a config's QR.
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
  const [qr, setQr] = useState<string | null>(null);

  // Loaded on demand, as in NodeSheet: the encoder is ~130KB and only this sheet needs it.
  useEffect(() => {
    if (record === null) {
      setQr(null);
      return;
    }
    let live = true;
    const url = record.url;
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(url, {
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
  }, [record]);

  if (record === null) return null;

  const copy = async () => {
    try {
      await Clipboard.write({ string: record.url });
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
        <div className="shrink-0 p-5 pb-3">
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

        <div className="flex-1 min-h-0 overflow-y-auto custom-scroll px-5 pb-5">
          <div className="space-y-4">
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
        </div>
      </div>
    </div>
  );
}
