import { useEffect, useState } from 'react';
import { fetchPromo, isDue, markShown, type Promo } from '../core/ads';

/**
 * Promo shown once the tunnel is up.
 *
 * Renders NOTHING until a promo has actually loaded — no placeholder, no skeleton, no reserved
 * gap. The slot is optional and often disabled, so a layout that holds space for it would put
 * a hole in the home screen of every build that never fills it.
 *
 * See core/ads.ts for why this request leaves over the user's real IP, and what that discloses.
 */
export function AdBanner({ connected }: { connected: boolean }) {
  const [promo, setPromo] = useState<Promo | null>(null);

  useEffect(() => {
    // Only after the tunnel is established, which is the moment the user was asked about —
    // and the moment the direct path is known to work, since it is the path we just did not
    // route through the proxy.
    if (!connected || !isDue()) return;

    let live = true;
    void fetchPromo().then((result) => {
      if (!live || result === null) return;
      setPromo(result);
      markShown();
    });

    return () => {
      // A promo that arrives after the user disconnected or left the screen is dropped
      // rather than setting state on a gone component.
      live = false;
    };
  }, [connected]);

  // Clear it on disconnect so a stale banner does not outlive the session it belonged to.
  useEffect(() => {
    if (!connected) setPromo(null);
  }, [connected]);

  if (promo === null) return null;

  return (
    <a
      href={promo.clickUrl}
      target="_blank"
      // noreferrer is not cosmetic here: it withholds the originating URL from the
      // destination, and it implies noopener, which stops the opened page from reaching back
      // into this WebView through window.opener.
      rel="noreferrer noopener"
      className="shrink-0 mt-3 block rounded-2xl overflow-hidden border border-brand-border bg-brand-surface"
    >
      <img
        src={promo.imageUrl}
        alt={promo.alt}
        // Height-capped and cropped: a remote image dictates its own dimensions, and one
        // 2000px tall would otherwise push the whole home screen off the display.
        className="w-full max-h-24 object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
      <span className="block px-3 py-1 text-[9px] uppercase tracking-wider text-brand-muted">
        Sponsored
      </span>
    </a>
  );
}
