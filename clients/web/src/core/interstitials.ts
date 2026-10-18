/**
 * Full-screen ad after the user disconnects - the decisions, without the SDK.
 *
 * Everything here is plain logic over an injected driver, so scripts/check-ads.mts can run the
 * whole flow (consent, loading, the cap, expiry) in Node without a device. core/admob.ts binds
 * it to the real Google Mobile Ads plugin.
 *
 * The rules it enforces:
 *   - OFF unless the build turned it on. An off build never loads the driver at all.
 *   - Consent first. Google's consent message (UMP) is asked for before the SDK starts, and no
 *     ad is requested while consent is REQUIRED or could not be determined. A consent request
 *     that fails - no network, or a region Google does not serve - means no ads this launch, and
 *     no retry: nothing keeps calling out.
 *   - Only after a DISCONNECT the user made in the app. Never on launch, never on connect, and
 *     never for a stop from the notification or the Quick Settings tile, where the app is not
 *     on screen.
 *   - At most one per MIN_INTERVAL_MS, across launches. Xiaomi GetApps rules out ads that pop up
 *     frequently, and an ad on every reconnect is that.
 *   - Never wait for an ad. One is shown only if it is already loaded; otherwise the disconnect
 *     just happens and the next one is fetched in the background.
 */

export type AdsMode = 'off' | 'test' | 'live';

/** The consent states Google's UMP reports, as the plugin passes them through. */
export type ConsentStatus = 'REQUIRED' | 'NOT_REQUIRED' | 'OBTAINED' | 'UNKNOWN';

/** Google's published test interstitial. Always fills, never pays, safe to tap. */
export const TEST_INTERSTITIAL_ID = 'ca-app-pub-3940256099942544/1033173712';

/** At most one ad per three minutes, however often the user reconnects. */
export const MIN_INTERVAL_MS = 3 * 60 * 1000;

/** Google expires a loaded interstitial after an hour; one older than this is reloaded, not shown. */
export const AD_TTL_MS = 55 * 60 * 1000;

const UNIT_ID = /^ca-app-pub-\d{16}\/\d{10}$/;

export interface AdsConfig {
  mode: AdsMode;
  unitId: string;
}

/**
 * The build-time switch. `test` uses Google's test unit; `live` needs a real interstitial unit
 * id and falls back to off without a well-formed one, so a half-configured build ships no ads
 * rather than broken ones.
 */
export function parseAdsConfig(mode: string | undefined, unitId: string | undefined): AdsConfig {
  if (mode === 'test') return { mode: 'test', unitId: TEST_INTERSTITIAL_ID };
  if (mode === 'live' && unitId !== undefined && UNIT_ID.test(unitId) && unitId !== TEST_INTERSTITIAL_ID) {
    return { mode: 'live', unitId };
  }
  return { mode: 'off', unitId: '' };
}

/** True when enough time has passed since the last ad. A clock that went backwards counts as due. */
export function isDue(now: number, lastShownAt: number): boolean {
  const since = now - lastShownAt;
  return since < 0 || since >= MIN_INTERVAL_MS;
}

/** What the controller needs from the ad SDK. */
export interface AdDriver {
  requestConsent(): Promise<{ status: ConsentStatus; formAvailable: boolean }>;
  /** Shows Google's consent form and resolves with the status it left. */
  showConsentForm(): Promise<ConsentStatus>;
  initialize(testing: boolean): Promise<void>;
  /** Resolves once an interstitial is loaded, rejects when none could be. */
  load(unitId: string, testing: boolean): Promise<void>;
  show(): Promise<void>;
}

/** Where the time of the last ad is kept, so the cap holds across launches. */
export interface ShownStore {
  lastShownAt(): number;
  markShown(at: number): void;
}

export interface Interstitials {
  /** Once per launch: consent, then the SDK, then the first ad. Never rejects. */
  start(): Promise<void>;
  /** Fetch an ad in the background if none is ready. Called when the user connects. */
  prepare(): void;
  /** Called after a disconnect the user made in the app. Resolves true if an ad was shown. */
  afterUserDisconnect(): Promise<boolean>;
  /** Whether the app must offer a way back into the consent form (EEA/UK users). */
  privacyOptionsAvailable(): boolean;
  /** Re-opens the consent form, for the "Ad privacy" entry. */
  openPrivacyOptions(): Promise<void>;
  /** Plain callback set, not a Capacitor listener: notifies when privacyOptionsAvailable changes. */
  subscribe(listener: () => void): () => void;
}

export function createInterstitials(
  config: AdsConfig,
  loadDriver: () => Promise<AdDriver>,
  store: ShownStore,
  now: () => number = Date.now,
): Interstitials {
  const testing = config.mode === 'test';
  const listeners = new Set<() => void>();

  let driver: AdDriver | null = null;
  let started = false;
  /** Consent allows ads and the SDK is initialised. */
  let ready = false;
  let loading = false;
  /** When the ad that is waiting was loaded; null when there is none. */
  let loadedAt: number | null = null;
  /** The user is in a region where consent applies, and the form exists to change it. */
  let privacyOptions = false;

  const notify = () => listeners.forEach((listener) => listener());

  async function becomeReady(d: AdDriver, status: ConsentStatus): Promise<void> {
    if (ready || (status !== 'OBTAINED' && status !== 'NOT_REQUIRED')) return;
    await d.initialize(testing);
    ready = true;
    prepare();
  }

  function prepare(): void {
    const d = driver;
    if (d === null || !ready || loading) return;
    if (loadedAt !== null && now() - loadedAt <= AD_TTL_MS) return;
    loadedAt = null;
    loading = true;
    d.load(config.unitId, testing).then(
      () => {
        loadedAt = now();
        loading = false;
      },
      () => {
        // No fill, no network, or a region the ad network does not serve. Silent: the next
        // connect asks again, nothing retries on its own.
        loading = false;
      },
    );
  }

  return {
    async start() {
      if (config.mode === 'off' || started) return;
      started = true;
      try {
        const d = await loadDriver();
        driver = d;
        const consent = await d.requestConsent();
        let status = consent.status;
        if (status === 'REQUIRED' && consent.formAvailable) status = await d.showConsentForm();
        privacyOptions = consent.formAvailable && (consent.status === 'REQUIRED' || consent.status === 'OBTAINED');
        if (privacyOptions) notify();
        await becomeReady(d, status);
      } catch {
        // Consent could not be settled, or the SDK did not start: no ads this launch.
      }
    },

    prepare,

    async afterUserDisconnect() {
      const d = driver;
      if (d === null || !ready) return false;
      const t = now();
      if (loadedAt === null || t - loadedAt > AD_TTL_MS) {
        prepare();
        return false;
      }
      if (!isDue(t, store.lastShownAt())) return false;
      // An interstitial shows once. Forget it and count it before showing, so a show that fails
      // still holds the cap rather than retrying on the next disconnect.
      loadedAt = null;
      store.markShown(t);
      try {
        await d.show();
        return true;
      } catch {
        return false;
      }
    },

    privacyOptionsAvailable: () => privacyOptions,

    async openPrivacyOptions() {
      const d = driver;
      if (d === null || !privacyOptions) return;
      try {
        await becomeReady(d, await d.showConsentForm());
      } catch {
        // The form could not open or the SDK could not start; the entry stays for another try.
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
