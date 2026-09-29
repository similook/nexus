import { useEffect, useState } from 'react';
import { checkForUpdateOnce, type AvailableUpdate } from '../core/update';

/** Dismissed for the rest of this launch, surviving Home unmounting on every tab change. */
let dismissedThisLaunch = false;

/**
 * "A newer Nexus is available" - only when a signed manifest says so. See core/update.ts.
 *
 * Renders NOTHING otherwise: no placeholder while the check runs, and nothing when it fails. A
 * failed check is not news to the user; the version they have keeps working.
 *
 * The button is a plain link, the same as AdBanner's: Capacitor hands any non-app URL to the
 * system, so Play opens in the Play Store and a release page in the browser. The URL was built
 * by update.ts from the signed version, never taken from the network.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [dismissed, setDismissed] = useState(dismissedThisLaunch);

  useEffect(() => {
    let live = true;
    void checkForUpdateOnce().then((result) => {
      if (live) setUpdate(result.update);
    });
    return () => {
      live = false;
    };
  }, []);

  if (update === null || dismissed) return null;

  return (
    <div className="shrink-0 flex items-center gap-2 p-3 rounded-2xl bg-brand-surface border border-brand-orange/40 mb-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-white truncate">Nexus {update.version} is available</div>
        <div className="text-[10px] text-brand-muted truncate">
          {update.channel === 'play' ? 'Update from Google Play' : 'Verified release on GitHub'}
        </div>
      </div>
      <a
        href={update.url}
        target="_blank"
        rel="noreferrer noopener"
        className="shrink-0 px-3 py-1.5 rounded-xl bg-gradient-to-r from-brand-orange to-brand-orange-dark text-white text-xs font-bold active:scale-95 transition-all"
      >
        Update
      </a>
      <button
        onClick={() => {
          dismissedThisLaunch = true;
          setDismissed(true);
        }}
        aria-label="Dismiss"
        className="shrink-0 w-7 h-7 rounded-lg text-brand-muted hover:text-white flex items-center justify-center"
      >
        ×
      </button>
    </div>
  );
}
