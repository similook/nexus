/**
 * Checks the signed update check (src/core/update.ts) and the signing tool's refusals
 * (scripts/update-manifest.mts).
 *
 * Signs with a throwaway key generated here. The real private key is never read: the checks that
 * need the real key only use its PUBLIC half, which is compiled into update.ts.
 *
 *   npx tsx scripts/check-update.mts
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkForUpdate,
  decide,
  openEnvelope,
  UPDATE_PUBLIC_KEY,
  type UpdateDeps,
  type UpdateManifest,
} from '../src/core/update';
import type { InstallInfo } from '../src/core/plugin';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks++;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
    if (detail !== undefined) console.error(`         ${JSON.stringify(detail)}`);
  }
}

function testKey(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

const KEY = testKey();
const OTHER = testKey();

const MANIFEST: UpdateManifest = {
  schema: 1,
  app: 'io.nexus.app',
  platform: 'android',
  version: '1.3.2',
  versionCode: 6,
  minSdk: 22,
  abi: 'arm64-v8a',
  channels: ['github'],
  asset: { name: 'nexus-v1.3.2-arm64.apk', size: 15_000_000, sha256: 'ab'.repeat(32) },
};

const INSTALL: InstallInfo = {
  packageName: 'io.nexus.app',
  versionCode: 5,
  versionName: '1.3.1',
  installer: 'com.google.android.packageinstaller',
  sdkInt: 34,
  abis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'],
};

/** An envelope as the signing tool writes it, signing `bytes` exactly. */
function envelopeFor(bytes: Buffer, key = KEY.privateKey, sig?: Buffer) {
  const signature = sig ?? sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' });
  return { manifest: bytes.toString('base64'), signature: signature.toString('base64') };
}
const signed = (manifest: unknown, key = KEY.privateKey) =>
  envelopeFor(Buffer.from(JSON.stringify(manifest), 'utf8'), key);

/** What Android's CapacitorHttp returns for a non-JSON body: Base64.DEFAULT, 76-column lines. */
function androidTransport(envelope: unknown): string {
  const b64 = Buffer.from(JSON.stringify(envelope)).toString('base64');
  return `${b64.replace(/(.{76})/g, '$1\n')}\n`;
}

async function reason(data: unknown, publicKey = KEY.publicKey): Promise<string> {
  const opened = await openEnvelope(data, publicKey);
  return 'reason' in opened ? opened.reason : 'ok';
}

// --- envelope and signature ------------------------------------------------------------------

check('valid envelope, as the parsed object Capacitor gives for application/json', (await reason(signed(MANIFEST))) === 'ok');
check('valid envelope, as Android line-wrapped base64', (await reason(androidTransport(signed(MANIFEST)))) === 'ok');
{
  const opened = await openEnvelope(signed(MANIFEST), KEY.publicKey);
  check('the verified manifest is the signed one', 'manifest' in opened && JSON.stringify(opened.manifest) === JSON.stringify(MANIFEST), opened);
}

{
  const bytes = Buffer.from(JSON.stringify(MANIFEST), 'utf8');
  const good = envelopeFor(bytes);
  const tampered = Buffer.from(JSON.stringify({ ...MANIFEST, versionCode: 99 }), 'utf8');
  check('tampered manifest, original signature: invalid signature', (await reason({ ...good, manifest: tampered.toString('base64') })) === 'invalid signature');
  const flipped = Buffer.from(bytes);
  flipped[10] ^= 1;
  check('one flipped byte: invalid signature', (await reason({ ...good, manifest: flipped.toString('base64') })) === 'invalid signature');
}
check('signed by another key: invalid signature', (await reason(signed(MANIFEST, OTHER.privateKey))) === 'invalid signature');
check('the compiled-in key rejects a manifest signed by any other key', (await reason(signed(MANIFEST), UPDATE_PUBLIC_KEY)) === 'invalid signature');
{
  const bytes = Buffer.from(JSON.stringify(MANIFEST), 'utf8');
  const der = sign('sha256', bytes, { key: KEY.privateKey, dsaEncoding: 'der' });
  check('DER signature instead of raw r||s: malformed', (await reason(envelopeFor(bytes, KEY.privateKey, der))) === 'malformed envelope');
  const raw = sign('sha256', bytes, { key: KEY.privateKey, dsaEncoding: 'ieee-p1363' });
  check('truncated signature: malformed', (await reason(envelopeFor(bytes, KEY.privateKey, raw.subarray(0, 63)))) === 'malformed envelope');
}
check('extra envelope field: malformed', (await reason({ ...signed(MANIFEST), note: 'x' })) === 'malformed envelope');
check('missing signature: malformed', (await reason({ manifest: signed(MANIFEST).manifest })) === 'malformed envelope');
check('not base64: malformed', (await reason({ ...signed(MANIFEST), manifest: 'not base64!' })) === 'malformed envelope');
check('transport that is not JSON: malformed', (await reason(Buffer.from('<html>').toString('base64'))) === 'malformed envelope');
check('nothing at all: malformed', (await reason(null)) === 'malformed envelope');

// --- manifest validation (all of these are validly SIGNED - the key-holder's own mistakes) ----

const malformed: Array<[string, unknown]> = [
  ['unknown field', { ...MANIFEST, extra: 1 }],
  ['missing field', (({ minSdk: _m, ...rest }) => rest)(MANIFEST)],
  ['schema 2', { ...MANIFEST, schema: 2 }],
  ['platform ios', { ...MANIFEST, platform: 'ios' }],
  ['version 1.3', { ...MANIFEST, version: '1.3' }],
  ['version with a path', { ...MANIFEST, version: '1.3.2/../../x' }],
  ['versionCode as a string', { ...MANIFEST, versionCode: '6' }],
  ['versionCode 6.5', { ...MANIFEST, versionCode: 6.5 }],
  ['unknown ABI', { ...MANIFEST, abi: 'mips' }],
  ['no channels', { ...MANIFEST, channels: [] }],
  ['unknown channel', { ...MANIFEST, channels: ['github', 'web'] }],
  ['duplicate channel', { ...MANIFEST, channels: ['github', 'github'] }],
  ['asset hash too short', { ...MANIFEST, asset: { ...MANIFEST.asset, sha256: 'ab'.repeat(31) } }],
  ['asset hash upper case', { ...MANIFEST, asset: { ...MANIFEST.asset, sha256: 'AB'.repeat(32) } }],
  ['asset not an apk', { ...MANIFEST, asset: { ...MANIFEST.asset, name: 'nexus.exe' } }],
  ['asset name with a path', { ...MANIFEST, asset: { ...MANIFEST.asset, name: '../nexus.apk' } }],
  ['asset size 0', { ...MANIFEST, asset: { ...MANIFEST.asset, size: 0 } }],
  ['asset extra field', { ...MANIFEST, asset: { ...MANIFEST.asset, url: 'https://evil.example/x.apk' } }],
  ['manifest is an array', [MANIFEST]],
];
for (const [name, manifest] of malformed) {
  check(`malformed manifest: ${name}`, (await reason(signed(manifest))) === 'malformed manifest');
}
check(
  'signed bytes that are not JSON: malformed manifest',
  (await reason(envelopeFor(Buffer.from('{not json', 'utf8')))) === 'malformed manifest',
);

// --- the decision --------------------------------------------------------------------------

const outcome = (manifest: UpdateManifest, install: InstallInfo) => {
  const result = decide(manifest, install);
  return result.update ?? result.reason;
};
check('newer, sideloaded: the verified GitHub release page', JSON.stringify(outcome(MANIFEST, INSTALL)) === JSON.stringify({
  version: '1.3.2',
  versionCode: 6,
  channel: 'github',
  url: 'https://github.com/similook/nexus/releases/tag/v1.3.2',
}), outcome(MANIFEST, INSTALL));
check('same versionCode: up to date', outcome(MANIFEST, { ...INSTALL, versionCode: 6 }) === 'up to date');
check('older versionCode: never a downgrade', outcome(MANIFEST, { ...INSTALL, versionCode: 7 }) === 'up to date');
check('another app: rejected', outcome({ ...MANIFEST, app: 'io.other.app' }, INSTALL) === 'manifest is for another app');
check('ABI the device lacks: rejected', outcome(MANIFEST, { ...INSTALL, abis: ['x86_64', 'x86'] }) === 'not built for this device (ABI)');
check('minSdk above the device: rejected', outcome({ ...MANIFEST, minSdk: 35 }, INSTALL) === 'needs a newer Android version');
const PLAY: InstallInfo = { ...INSTALL, installer: 'com.android.vending' };
check('Play install, GitHub-only release: nothing yet', outcome(MANIFEST, PLAY) === 'not yet available on play');
check(
  'Play install, Play release: Google Play, never GitHub',
  JSON.stringify(outcome({ ...MANIFEST, channels: ['github', 'play'] }, PLAY)) === JSON.stringify({
    version: '1.3.2',
    versionCode: 6,
    channel: 'play',
    url: 'https://play.google.com/store/apps/details?id=io.nexus.app',
  }),
);
check('sideload, Play-only release: nothing', outcome({ ...MANIFEST, channels: ['play'] }, INSTALL) === 'not yet available on github');

// --- the whole check, with the transport faked --------------------------------------------

function deps(over: Partial<UpdateDeps>, calls: { fetched: number }): UpdateDeps {
  return {
    installInfo: async () => INSTALL,
    fetchEnvelope: async () => {
      calls.fetched++;
      return { status: 200, data: androidTransport(signed(MANIFEST)) };
    },
    publicKey: KEY.publicKey,
    ...over,
  };
}
const run = async (over: Partial<UpdateDeps>) => {
  const calls = { fetched: 0 };
  const result = await checkForUpdate(deps(over, calls));
  return { result: result.update ? 'update' : result.reason, fetched: calls.fetched };
};

check('end to end: offered', (await run({})).result === 'update');
check('offline: fails closed', (await run({ fetchEnvelope: async () => Promise.reject(new Error('offline')) })).result === 'network unavailable');
check('404 (no manifest on the latest release): fails closed', (await run({ fetchEnvelope: async () => ({ status: 404, data: 'Not Found' }) })).result === 'HTTP 404');
{
  const r = await run({ installInfo: async () => Promise.reject(new Error('web')) });
  check('no install info (browser build): fails closed without fetching', r.result === 'install info unavailable' && r.fetched === 0, r);
}
check(
  'nonsense install info: fails closed',
  (await run({ installInfo: async () => ({ ...INSTALL, versionCode: 'x' }) as unknown as InstallInfo })).result === 'install info unavailable',
);
check('the default key rejects a test-signed manifest', (await run({ publicKey: undefined })).result === 'invalid signature');

// --- the compiled-in key -------------------------------------------------------------------

{
  let imported = false;
  try {
    await crypto.subtle.importKey('spki', Buffer.from(UPDATE_PUBLIC_KEY, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    imported = true;
  } catch {
    imported = false;
  }
  check('UPDATE_PUBLIC_KEY is a valid P-256 public key', imported);
}

// --- the signing tool's refusals -----------------------------------------------------------

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(WEB, 'scripts', 'update-manifest.mts');
function tool(...args: string[]) {
  const quoted = ['--yes', 'tsx', TOOL, ...args].map((a) => `"${a}"`).join(' ');
  const r = spawnSync(`npx ${quoted}`, { cwd: WEB, shell: true, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nexus-update-check-'));
try {
  const inRepo = path.join(WEB, 'refused-test-key.pem');
  const r1 = tool('keygen', inRepo);
  check('keygen refuses a path inside the repository', r1.code !== 0 && !existsSync(inRepo), r1.out);

  const keyPath = path.join(tmp, 'throwaway.pem');
  const r2 = tool('keygen', keyPath);
  check(
    'keygen writes outside the repository and prints only the public key',
    r2.code === 0 && existsSync(keyPath) && !r2.out.includes('PRIVATE KEY') && /^MFkw[A-Za-z0-9+/=]+$/m.test(r2.out),
    r2.out,
  );

  const before = readFileSync(keyPath, 'utf8');
  const r3 = tool('keygen', keyPath);
  check('keygen never overwrites a key', r3.code !== 0 && readFileSync(keyPath, 'utf8') === before, r3.out);

  const apk = path.join(tmp, 'nexus-v1.3.2-arm64.apk');
  writeFileSync(apk, 'not really an apk');
  const out = path.join(tmp, 'update-android.json');
  const r4 = tool('sign', '--key', keyPath, '--apk', apk, '--version', '1.3.2', '--version-code', '6', '--out', out);
  check(
    'sign refuses a key that is not compiled into the app',
    r4.code !== 0 && r4.out.includes('not the key compiled into the app') && !existsSync(out),
    r4.out,
  );

  const r5 = tool('sign', '--key', path.join(WEB, 'no-such-key.pem'), '--apk', apk, '--version', '1.3.2', '--version-code', '6', '--out', out);
  check('sign refuses a key path inside the repository', r5.code !== 0 && r5.out.includes('inside the repository'), r5.out);

  const forged = path.join(tmp, 'forged.json');
  writeFileSync(forged, JSON.stringify(signed(MANIFEST)));
  const r6 = tool('verify', forged);
  check('verify rejects a manifest not signed by the compiled-in key', r6.code !== 0 && r6.out.includes('invalid signature'), r6.out);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} of ${checks} update checks failed.`);
  process.exit(1);
}
console.log(`\nall ${checks} update checks passed`);
