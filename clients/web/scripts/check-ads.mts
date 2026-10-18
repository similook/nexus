/**
 * The AdMob rules in src/core/interstitials.ts, run against a fake SDK.
 *
 *   npm run check-ads
 *
 * Nothing here touches Google: the driver records what it was asked to do, and the clock is a
 * number the checks move by hand.
 */
import {
  AD_TTL_MS,
  MIN_INTERVAL_MS,
  TEST_INTERSTITIAL_ID,
  createInterstitials,
  isDue,
  parseAdsConfig,
  type AdDriver,
  type AdsConfig,
  type ConsentStatus,
} from '../src/core/interstitials';
import { readFileSync } from 'node:fs';
import { ADMOB_PLUGIN, androidPlugins } from '../capacitor.config';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL ${name}`, detail ?? '');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeOptions {
  consent?: ConsentStatus;
  formAvailable?: boolean;
  /** What each successive showing of the consent form returns; the last one repeats. */
  formResults?: ConsentStatus[];
  consentFails?: boolean;
  loadFails?: boolean;
}

function harness(config: AdsConfig, options: FakeOptions = {}) {
  const calls: string[] = [];
  let clock = 1_000_000_000;
  let lastShown = 0;
  let driverLoads = 0;
  const driver: AdDriver = {
    async requestConsent() {
      calls.push('consent');
      if (options.consentFails) throw new Error('offline');
      return { status: options.consent ?? 'NOT_REQUIRED', formAvailable: options.formAvailable ?? false };
    },
    async showConsentForm() {
      calls.push('form');
      const results = options.formResults ?? ['OBTAINED'];
      return results.length > 1 ? results.shift()! : results[0];
    },
    async initialize(testing) {
      calls.push(`init:${testing}`);
    },
    async load(unitId, testing) {
      calls.push(`load:${unitId}:${testing}`);
      if (options.loadFails) throw new Error('no fill');
    },
    async show() {
      calls.push('show');
    },
  };
  const ads = createInterstitials(
    config,
    async () => {
      driverLoads++;
      return driver;
    },
    { lastShownAt: () => lastShown, markShown: (at) => (lastShown = at) },
    () => clock,
  );
  return {
    ads,
    calls,
    count: (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length,
    advance: (ms: number) => (clock += ms),
    driverLoads: () => driverLoads,
    lastShown: () => lastShown,
  };
}

const TEST = parseAdsConfig('test', undefined);
const LIVE_UNIT = 'ca-app-pub-1234567890123456/1234567890';

// The build switch.
check('unset is off', parseAdsConfig(undefined, undefined).mode === 'off');
check('an unknown value is off', parseAdsConfig('on', LIVE_UNIT).mode === 'off');
check('test uses Google\'s test unit, whatever unit is passed', TEST.mode === 'test' && parseAdsConfig('test', LIVE_UNIT).unitId === TEST_INTERSTITIAL_ID);
check('live with a unit id is live', parseAdsConfig('live', LIVE_UNIT).mode === 'live' && parseAdsConfig('live', LIVE_UNIT).unitId === LIVE_UNIT);
check('live without a unit id is off', parseAdsConfig('live', undefined).mode === 'off');
check('live with a malformed unit id is off', parseAdsConfig('live', 'ca-app-pub-123/456').mode === 'off');
check('live with the app id instead of a unit id is off', parseAdsConfig('live', 'ca-app-pub-1234567890123456~1234567890').mode === 'off');
check('live with the test unit is off', parseAdsConfig('live', TEST_INTERSTITIAL_ID).mode === 'off');

// The cap.
check('due after the interval', isDue(MIN_INTERVAL_MS, 0));
check('not due inside the interval', !isDue(MIN_INTERVAL_MS - 1, 0));
check('a clock that went backwards is due', isDue(0, 1000));

// Off: the SDK is never even loaded.
{
  const h = harness(parseAdsConfig(undefined, undefined));
  await h.ads.start();
  h.ads.prepare();
  const shown = await h.ads.afterUserDisconnect();
  await h.ads.openPrivacyOptions();
  check('off: driver never loaded and nothing called', h.driverLoads() === 0 && h.calls.length === 0 && !shown, h.calls);
}

// Outside the consent regions: consent, init, one load, then one ad on disconnect.
{
  const h = harness(TEST);
  await h.ads.start();
  await tick();
  check('not required: consent, then init (testing), then one load', h.calls.join() === `consent,init:true,load:${TEST_INTERSTITIAL_ID}:true`, h.calls);
  check('not required: no privacy entry', !h.ads.privacyOptionsAvailable());
  check('first disconnect shows the loaded ad', await h.ads.afterUserDisconnect());
  check('the show is counted for the cap', h.lastShown() !== 0);

  // Inside the interval: no ad, even with a fresh one loaded.
  h.ads.prepare();
  await tick();
  h.advance(MIN_INTERVAL_MS - 1000);
  check('a disconnect inside the interval shows nothing', !(await h.ads.afterUserDisconnect()));
  check('and the loaded ad is kept for later', h.count('show') === 1 && h.count('load') === 2, h.calls);

  h.advance(1000);
  check('after the interval the kept ad shows', await h.ads.afterUserDisconnect());
  check('an ad is never shown twice', !(await h.ads.afterUserDisconnect()) && h.count('show') === 2, h.calls);
}

// start() runs once per launch.
{
  const h = harness(TEST);
  await Promise.all([h.ads.start(), h.ads.start()]);
  await h.ads.start();
  check('start twice: one consent request', h.count('consent') === 1 && h.driverLoads() === 1, h.calls);
}

// Consent required: the form first, ads only once it is answered.
{
  const h = harness(TEST, { consent: 'REQUIRED', formAvailable: true, formResults: ['OBTAINED'] });
  await h.ads.start();
  await tick();
  check('required: form before init and load', h.calls.join() === `consent,form,init:true,load:${TEST_INTERSTITIAL_ID}:true`, h.calls);
  check('required: privacy entry offered', h.ads.privacyOptionsAvailable());
}
{
  // Dismissed on launch, answered later from the "Ad privacy settings" entry.
  const h = harness(TEST, { consent: 'REQUIRED', formAvailable: true, formResults: ['REQUIRED', 'OBTAINED'] });
  let notified = 0;
  h.ads.subscribe(() => notified++);
  await h.ads.start();
  await tick();
  check('form dismissed unanswered: no init, no load', h.count('init') === 0 && h.count('load') === 0, h.calls);
  check('form dismissed: entry still offered, subscriber told', h.ads.privacyOptionsAvailable() && notified === 1);
  check('form dismissed: a disconnect shows nothing', !(await h.ads.afterUserDisconnect()));

  await h.ads.openPrivacyOptions();
  await tick();
  check('answered from the entry: SDK starts and an ad loads', h.count('init') === 1 && h.count('load') === 1, h.calls);

  await h.ads.openPrivacyOptions();
  await tick();
  check('opening the entry again does not start the SDK twice', h.count('form') === 3 && h.count('init') === 1, h.calls);
}
{
  const h = harness(TEST, { consent: 'REQUIRED', formAvailable: false });
  await h.ads.start();
  await tick();
  check('required but no form: no ads, no entry', h.count('init') === 0 && h.count('load') === 0 && !h.ads.privacyOptionsAvailable(), h.calls);
}
{
  const h = harness(TEST, { consent: 'OBTAINED', formAvailable: true });
  await h.ads.start();
  await tick();
  check('obtained earlier: no form, ads start, entry offered', !h.calls.includes('form') && h.count('load') === 1 && h.ads.privacyOptionsAvailable(), h.calls);
}
{
  const h = harness(TEST, { consent: 'UNKNOWN' });
  await h.ads.start();
  await tick();
  check('unknown consent: no ads', h.count('init') === 0 && h.count('load') === 0, h.calls);
}

// Consent cannot be reached (offline, or a region Google does not serve): nothing more goes out.
{
  const h = harness(TEST, { consentFails: true });
  await h.ads.start();
  h.ads.prepare();
  const shown = await h.ads.afterUserDisconnect();
  await tick();
  check('consent failure: no init, no load, no retry', h.calls.join() === 'consent' && !shown, h.calls);
}

// No fill: never waits, never shows, asks again only on the next connect.
{
  const h = harness(TEST, { loadFails: true });
  await h.ads.start();
  await tick();
  check('no fill: disconnect shows nothing', !(await h.ads.afterUserDisconnect()));
  await tick();
  check('no fill: one more load from that disconnect, nothing else', h.count('load') === 2 && h.count('show') === 0, h.calls);
}

// Expiry: an ad older than the TTL is replaced, not shown.
{
  const h = harness(TEST);
  await h.ads.start();
  await tick();
  h.advance(AD_TTL_MS + 1);
  check('expired ad: not shown', !(await h.ads.afterUserDisconnect()));
  await tick();
  check('expired ad: a fresh one is loaded instead', h.count('load') === 2 && h.count('show') === 0, h.calls);
  check('the fresh one shows on the next disconnect', await h.ads.afterUserDisconnect());
}

// prepare() never stacks requests.
{
  const h = harness(TEST);
  await h.ads.start();
  h.ads.prepare();
  h.ads.prepare();
  await tick();
  h.ads.prepare();
  check('prepare while loading or loaded: one load only', h.count('load') === 1, h.calls);
}

// Live builds pass the real unit and no testing flag.
{
  const h = harness(parseAdsConfig('live', LIVE_UNIT));
  await h.ads.start();
  await tick();
  check('live: init and load without the testing flag', h.calls.join() === `consent,init:false,load:${LIVE_UNIT}:false`, h.calls);
}

// Which plugins `cap sync` links: the ad SDK only in an ads build (capacitor.config.ts).
{
  const deps = ['@capacitor/android', ADMOB_PLUGIN, '@capacitor/app', 'react'];
  const off = androidPlugins(deps, undefined);
  check('no ads: every dependency but AdMob', off?.join() === '@capacitor/android,@capacitor/app,react', off);
  check('an unknown mode links no AdMob', androidPlugins(deps, 'on')?.includes(ADMOB_PLUGIN) === false);
  check('test keeps Capacitor\'s default, AdMob included', androidPlugins(deps, 'test') === undefined);
  check('live keeps Capacitor\'s default, AdMob included', androidPlugins(deps, 'live') === undefined);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string> };
  check('the AdMob name matches the dependency', pkg.dependencies?.[ADMOB_PLUGIN] !== undefined, Object.keys(pkg.dependencies ?? {}));
}

console.log(`${passed} ads checks passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed) process.exit(1);
