import { CapacitorHttp } from '@capacitor/core';
import { NexusCore, type InstallInfo } from './plugin';

/**
 * "Is there a newer official Nexus, and where does THIS install get it?" - once per launch.
 *
 * ================================ THE TRUST MODEL - READ THIS ================================
 *
 * HTTPS is not the authority here; a key is. Each release carries update-android.json: an
 * envelope holding a manifest (app, platform, version, versionCode, minSdk, ABI, channels, and
 * the APK's name, size and SHA-256) plus an ECDSA P-256 signature over the manifest's EXACT
 * bytes. The private key never enters this repository (docs/RELEASE.md); the public key below
 * can only verify. So a replaced release asset, a hijacked account without the key, or anything
 * on the network path can at worst make this check fail - never make it say something the
 * key-holder did not sign.
 *
 * Everything fails CLOSED to "no update": no network, a non-200, a malformed envelope, a bad
 * signature, a malformed manifest, another app or platform, an ABI or Android version this
 * device cannot run, or a version that is not strictly newer. The installed app keeps working
 * either way; a failed check costs nothing but a banner that does not appear.
 *
 * What it does NOT do: download or install anything. It sends the user to the one official
 * place for their install - Google Play for a Play install (Play may sign with its own key, so
 * a GitHub APK could not update it anyway), otherwise the release page, built here from the
 * signed version rather than taken from any URL in the manifest. The APK's SHA-256 is signed
 * so that the release tooling can check the published asset against it (update-manifest.mts
 * verify --apk); on the device, Android itself refuses an update not signed with the installed
 * app's certificate, which is what stops a tampered APK.
 * =============================================================================================
 */

/** The official repository. The only place a GitHub update is ever sent. */
const RELEASES = 'https://github.com/similook/nexus/releases';

/** A static asset on the latest release: no API call, nothing rate-limited. */
export const MANIFEST_URL = `${RELEASES}/latest/download/update-android.json`;

/**
 * Public half of the update-signing key: ECDSA P-256, SubjectPublicKeyInfo, base64.
 *
 * Safe to publish - it can only verify. Changing it orphans every installed copy (they would
 * reject everything signed with the new key), so it changes only in an app release that users
 * install by hand. The private half lives outside this repository; see docs/RELEASE.md.
 */
export const UPDATE_PUBLIC_KEY =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAENUG/srLEsr9mT3prxEuVgTv74/gjxTC56XlTFrKDsD217XweNX+qJixLRcB3v5zSfMAuYHtYb9tdVO3t+6WXrg==';

export type UpdateChannel = 'github' | 'play';

export interface UpdateManifest {
  schema: 1;
  app: string;
  platform: 'android';
  version: string;
  versionCode: number;
  minSdk: number;
  abi: string;
  /** Where this version can be installed from. Play lags GitHub by its review time. */
  channels: UpdateChannel[];
  asset: { name: string; size: number; sha256: string };
}

export interface AvailableUpdate {
  version: string;
  versionCode: number;
  channel: UpdateChannel;
  /** Google Play, or the verified release page - never a URL from the network. */
  url: string;
}

export type UpdateCheck = { update: AvailableUpdate } | { update: null; reason: string };

const PLAY_INSTALLER = 'com.android.vending';

/** The envelope is a few hundred bytes. Anything near this is not one. */
const MAX_ENVELOPE_CHARS = 64 * 1024;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const APP_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const CHANNELS: UpdateChannel[] = ['github', 'play'];
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$/;
const SHA256 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------

/**
 * Verify an envelope as CapacitorHttp hands it over, and return the manifest it carries.
 *
 * `data` arrives in one of two shapes, and both are expected. With responseType 'arraybuffer'
 * it is base64 of the exact file bytes - line-wrapped, since Android encodes with
 * Base64.DEFAULT. But when the server labels the file application/json, Capacitor parses it no
 * matter what was asked for, and hands over an object. The signed bytes survive either way,
 * because they travel inside the envelope as base64 rather than as JSON that could be re-shaped.
 */
export async function openEnvelope(
  data: unknown,
  publicKey: string = UPDATE_PUBLIC_KEY,
): Promise<{ manifest: UpdateManifest } | { reason: string }> {
  const envelope = readEnvelope(data);
  if (envelope === null) return { reason: 'malformed envelope' };

  const manifestBytes = fromBase64(envelope.manifest);
  const signature = fromBase64(envelope.signature);
  // Raw r||s (IEEE P1363), the form WebCrypto verifies: exactly 64 bytes for P-256.
  if (manifestBytes === null || signature === null || signature.length !== 64) {
    return { reason: 'malformed envelope' };
  }

  if (!(await verifySignature(manifestBytes, signature, publicKey))) {
    return { reason: 'invalid signature' };
  }

  // Parsed only AFTER the signature holds: nothing unauthenticated reaches the parser.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    return { reason: 'malformed manifest' };
  }
  const manifest = validateManifest(parsed);
  return manifest === null ? { reason: 'malformed manifest' } : { manifest };
}

function readEnvelope(data: unknown): { manifest: string; signature: string } | null {
  let value = data;
  if (typeof data === 'string') {
    // Transport base64. Whitespace is Android's line wrapping, not content.
    const bytes = data.length <= MAX_ENVELOPE_CHARS * 2 ? fromBase64(data.replace(/\s+/g, '')) : null;
    if (bytes === null) return null;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return null;
    }
  }
  if (!isRecord(value) || !hasExactly(value, ['manifest', 'signature'])) return null;
  const { manifest, signature } = value;
  if (typeof manifest !== 'string' || typeof signature !== 'string') return null;
  return { manifest, signature };
}

async function verifySignature(
  data: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
  publicKey: string,
): Promise<boolean> {
  // WebCrypto exists only in a secure context. Capacitor serves the app from https://localhost,
  // which is one; if that ever changes, this fails closed rather than skipping the check.
  const subtle = globalThis.crypto?.subtle;
  const spki = fromBase64(publicKey);
  if (!subtle || spki === null) return false;
  try {
    const key = await subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ]);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
  } catch {
    return false;
  }
}

/** The manifest, rebuilt field by field, or null if any field is missing, extra or wrong. */
export function validateManifest(value: unknown): UpdateManifest | null {
  if (
    !isRecord(value) ||
    !hasExactly(value, ['schema', 'app', 'platform', 'version', 'versionCode', 'minSdk', 'abi', 'channels', 'asset'])
  ) {
    return null;
  }
  const { schema, app, platform, version, versionCode, minSdk, abi, channels, asset } = value;
  if (schema !== 1 || platform !== 'android') return null;
  if (typeof app !== 'string' || !APP_ID.test(app)) return null;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  if (!isInt(versionCode, 1, 2_100_000_000) || !isInt(minSdk, 1, 1000)) return null;
  if (typeof abi !== 'string' || !ABIS.includes(abi)) return null;
  if (
    !Array.isArray(channels) ||
    channels.length === 0 ||
    new Set(channels).size !== channels.length ||
    !channels.every((c) => CHANNELS.includes(c))
  ) {
    return null;
  }
  if (!isRecord(asset) || !hasExactly(asset, ['name', 'size', 'sha256'])) return null;
  const { name, size, sha256 } = asset;
  if (typeof name !== 'string' || !ASSET_NAME.test(name)) return null;
  if (!isInt(size, 1, 1 << 30)) return null;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;

  return {
    schema: 1,
    app,
    platform: 'android',
    version,
    versionCode,
    minSdk,
    abi,
    channels: [...(channels as UpdateChannel[])],
    asset: { name, size, sha256 },
  };
}

// ---------------------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------------------

/** Whether a verified manifest is an update for THIS install, and where to get it. */
export function decide(manifest: UpdateManifest, install: InstallInfo): UpdateCheck {
  if (manifest.app !== install.packageName) return { update: null, reason: 'manifest is for another app' };
  // Strictly newer. Equal is "up to date", and lower would be a downgrade - never suggested.
  if (manifest.versionCode <= install.versionCode) return { update: null, reason: 'up to date' };
  if (manifest.minSdk > install.sdkInt) return { update: null, reason: 'needs a newer Android version' };
  if (!install.abis.includes(manifest.abi)) return { update: null, reason: 'not built for this device (ABI)' };

  // A Play install is updated by Play. Pointing it at a GitHub APK would at best fail to install.
  const channel: UpdateChannel = install.installer === PLAY_INSTALLER ? 'play' : 'github';
  if (!manifest.channels.includes(channel)) return { update: null, reason: `not yet available on ${channel}` };

  const url =
    channel === 'play'
      ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(install.packageName)}`
      : `${RELEASES}/tag/v${manifest.version}`;
  return { update: { version: manifest.version, versionCode: manifest.versionCode, channel, url } };
}

// ---------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------

export interface UpdateDeps {
  installInfo(): Promise<InstallInfo>;
  fetchEnvelope(): Promise<{ status: number; data: unknown }>;
  publicKey?: string;
}

const nativeDeps: UpdateDeps = {
  installInfo: () => NexusCore.getInstallInfo(),
  fetchEnvelope: () =>
    CapacitorHttp.get({
      url: MANIFEST_URL,
      headers: { Accept: '*/*' },
      connectTimeout: 15000,
      readTimeout: 15000,
      responseType: 'arraybuffer',
    }),
};

export async function checkForUpdate(deps: UpdateDeps = nativeDeps): Promise<UpdateCheck> {
  try {
    let install: InstallInfo;
    try {
      install = await deps.installInfo();
    } catch {
      // The browser build, or a native failure. Asked first, so nothing is fetched for it.
      return { update: null, reason: 'install info unavailable' };
    }
    if (!validInstall(install)) return { update: null, reason: 'install info unavailable' };

    let response: { status: number; data: unknown };
    try {
      response = await deps.fetchEnvelope();
    } catch {
      return { update: null, reason: 'network unavailable' };
    }
    if (response.status !== 200) return { update: null, reason: `HTTP ${response.status}` };

    const opened = await openEnvelope(response.data, deps.publicKey);
    if ('reason' in opened) return { update: null, reason: opened.reason };
    return decide(opened.manifest, install);
  } catch {
    return { update: null, reason: 'check failed' };
  }
}

let once: Promise<UpdateCheck> | null = null;

/**
 * checkForUpdate, at most once per launch.
 *
 * Module scope, like useAutoRefresh: once per JS context, whatever mounts and remounts. There
 * is no timer and no retry - the next check is the next launch.
 */
export function checkForUpdateOnce(): Promise<UpdateCheck> {
  once ??= checkForUpdate().then((result) => {
    if (result.update === null) console.info(`[nexus] update check: ${result.reason}`);
    return result;
  });
  return once;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

function validInstall(install: InstallInfo): boolean {
  return (
    isRecord(install) &&
    typeof install.packageName === 'string' &&
    install.packageName.length > 0 &&
    isInt(install.versionCode, 1, Number.MAX_SAFE_INTEGER) &&
    isInt(install.sdkInt, 1, 1000) &&
    typeof install.installer === 'string' &&
    Array.isArray(install.abis) &&
    install.abis.every((abi) => typeof abi === 'string')
  );
}

/** Strict base64: no whitespace, correct padding, nothing else. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (
    text.length === 0 ||
    text.length > MAX_ENVELOPE_CHARS * 2 ||
    text.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(text)
  ) {
    return null;
  }
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
