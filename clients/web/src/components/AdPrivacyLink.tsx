import { useSyncExternalStore } from 'react';
import { adPrivacy } from '../core/admob';

/**
 * "Ad privacy settings" - the way back into Google's consent form.
 *
 * Shown only in an ads build, and only to a user where consent applies (EEA, UK, Switzerland):
 * the consent rules require that choice to stay changeable after the first launch. Everyone else
 * never sees it, and a build without ads renders nothing.
 *
 * The subscription is a plain callback set in core/interstitials.ts, not a Capacitor listener,
 * so subscribing from a component is safe here.
 */
export function AdPrivacyLink() {
  const available = useSyncExternalStore(adPrivacy.subscribe, adPrivacy.available);
  if (!available) return null;

  return (
    <button
      type="button"
      onClick={() => void adPrivacy.open()}
      className="shrink-0 mt-3 self-center text-[11px] text-brand-muted underline underline-offset-2"
    >
      Ad privacy settings
    </button>
  );
}
