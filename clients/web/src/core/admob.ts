import { Capacitor } from '@capacitor/core';
import { createInterstitials, parseAdsConfig, type AdDriver, type ConsentStatus } from './interstitials';

/**
 * Google AdMob, bound to the decisions in interstitials.ts.
 *
 * OFF BY DEFAULT. A build turns it on with VITE_NEXUS_ADS:
 *   VITE_NEXUS_ADS=test                       Google's test ads (sample app id + test unit)
 *   VITE_NEXUS_ADS=live
 *   VITE_NEXUS_ADMOB_INTERSTITIAL=ca-app-pub-…/…   a real interstitial unit, and the matching
 *                                                  app id passed to Gradle as nexusAdmobAppId
 * With neither set, nothing here runs: the plugin module is never loaded, no consent request
 * goes out, and the SDK never starts.
 *
 * The native SDK is in the APK only when `npx cap sync` ran with the same VITE_NEXUS_ADS
 * (capacitor.config.ts androidPlugins); every other build carries no ad SDK at all. An ads web
 * build synced without it finds no native plugin, start() fails quietly, and no ad is shown.
 *
 * The SDK's own requests leave over the user's real IP, not the tunnel - the app's package is
 * on the VpnService deny list (see core/ads.ts). Google therefore sees the device's own network,
 * and in a region it does not serve the consent request fails and no ad is ever requested.
 */
const CONFIG = parseAdsConfig(import.meta.env.VITE_NEXUS_ADS, import.meta.env.VITE_NEXUS_ADMOB_INTERSTITIAL);

const LAST_SHOWN_KEY = 'nexus.admob.lastShownAt.v1';

async function loadDriver(): Promise<AdDriver> {
  // Loaded on first use, so a build with ads off never even evaluates the plugin's module.
  const { AdMob } = await import('@capacitor-community/admob');
  return {
    async requestConsent() {
      const info = await AdMob.requestConsentInfo();
      return { status: info.status as ConsentStatus, formAvailable: info.isConsentFormAvailable === true };
    },
    async showConsentForm() {
      return (await AdMob.showConsentForm()).status as ConsentStatus;
    },
    initialize: (testing) => AdMob.initialize({ initializeForTesting: testing }),
    async load(adId, testing) {
      await AdMob.prepareInterstitial({ adId, isTesting: testing });
    },
    show: () => AdMob.showInterstitial(),
  };
}

const interstitials = createInterstitials(CONFIG, loadDriver, {
  lastShownAt() {
    try {
      const value = Number.parseInt(localStorage.getItem(LAST_SHOWN_KEY) ?? '', 10);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  },
  markShown(at) {
    try {
      localStorage.setItem(LAST_SHOWN_KEY, String(at));
    } catch {
      // Storage unavailable: the cap degrades to per-launch.
    }
  },
});

/** True when this build shows ads at all. */
export const adsEnabled = CONFIG.mode !== 'off' && Capacitor.isNativePlatform();

/** Once, at app start. A no-op when ads are off or outside the native app. */
export function initAds(): void {
  if (adsEnabled) void interstitials.start();
}

/** The user connected from the app: have an ad ready for their disconnect. */
export function prepareAd(): void {
  if (adsEnabled) interstitials.prepare();
}

/** The user disconnected from the app: show the waiting ad, if one is loaded and due. */
export function adAfterDisconnect(): void {
  if (adsEnabled) void interstitials.afterUserDisconnect();
}

export const adPrivacy = {
  available: interstitials.privacyOptionsAvailable,
  open: interstitials.openPrivacyOptions,
  subscribe: interstitials.subscribe,
};
