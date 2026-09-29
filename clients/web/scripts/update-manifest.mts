/**
 * Create the update-signing key, sign an Android update manifest, verify a published one.
 * The only tool that ever touches the private key. See docs/RELEASE.md, "Update manifest".
 *
 *   npx tsx scripts/update-manifest.mts keygen <private-key.pem>
 *   npx tsx scripts/update-manifest.mts sign --key <private-key.pem> --apk <nexus-vX.Y.Z-arm64.apk>
 *       --version X.Y.Z --version-code N [--min-sdk 22] [--abi arm64-v8a]
 *       [--channels github[,play]] [--out update-android.json]
 *   npx tsx scripts/update-manifest.mts verify <update-android.json> [--apk <downloaded.apk>]
 *
 * THE PRIVATE KEY NEVER ENTERS THIS REPOSITORY. keygen and sign refuse a key path inside it, and
 * nothing here prints, logs or copies the key: keygen prints the PUBLIC half, sign prints the
 * manifest it signed.
 *
 * Verification is src/core/update.ts itself - the code the app runs - so a manifest this tool
 * accepts is one every installed copy accepts.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openEnvelope,
  UPDATE_PUBLIC_KEY,
  validateManifest,
  type UpdateChannel,
  type UpdateManifest,
} from '../src/core/update';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function insideRepo(file: string): boolean {
  const relative = path.relative(REPO_ROOT, path.resolve(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    const value = args[i + 1];
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) fail(`bad argument: ${name}`);
    out[name.slice(2)] = value;
    i++;
  }
  return out;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function keygen(out: string | undefined): void {
  if (!out) fail('usage: keygen <private-key.pem> - a path OUTSIDE this repository');
  if (insideRepo(out)) fail('refusing to write a private key inside the repository');

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  // 'wx': never overwrite. A replaced key orphans every installed copy of the app.
  writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });

  console.log(`private key written: ${path.resolve(out)}`);
  console.log('Back it up offline. It cannot be recovered, and never commit it.');
  console.log('\npublic key - UPDATE_PUBLIC_KEY in src/core/update.ts:');
  console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
}

async function signManifest(args: string[]): Promise<void> {
  const f = flags(args);
  for (const required of ['key', 'apk', 'version', 'version-code']) {
    if (!f[required]) fail(`--${required} is required`);
  }
  if (insideRepo(f.key)) fail('the private key must not live inside the repository');

  const privateKey = createPrivateKey(readFileSync(f.key));
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  if (publicKey !== UPDATE_PUBLIC_KEY) {
    fail('this is not the key compiled into the app (UPDATE_PUBLIC_KEY): every installed copy would reject it');
  }

  const apk = readFileSync(f.apk);
  const manifest: UpdateManifest = {
    schema: 1,
    app: 'io.nexus.app',
    platform: 'android',
    version: f.version,
    versionCode: Number(f['version-code']),
    minSdk: Number(f['min-sdk'] ?? 22),
    abi: f.abi ?? 'arm64-v8a',
    channels: (f.channels ?? 'github').split(',') as UpdateChannel[],
    asset: { name: path.basename(f.apk), size: apk.length, sha256: sha256(apk) },
  };
  if (validateManifest(manifest) === null) {
    fail(`the app would reject this manifest - check every field:\n${JSON.stringify(manifest, null, 2)}`);
  }

  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  const signature = sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const envelope = JSON.stringify({ manifest: bytes.toString('base64'), signature: signature.toString('base64') });

  // Opened exactly the way the app opens it, in both shapes Capacitor can hand over, before
  // anything is written.
  for (const shape of [JSON.parse(envelope), Buffer.from(envelope).toString('base64')]) {
    const opened = await openEnvelope(shape);
    if ('reason' in opened) fail(`self-check failed: ${opened.reason}`);
  }

  const out = f.out ?? 'update-android.json';
  writeFileSync(out, `${envelope}\n`);
  console.log(`signed: ${path.resolve(out)}`);
  console.log(JSON.stringify(manifest, null, 2));
}

async function verify(file: string | undefined, args: string[]): Promise<void> {
  if (!file) fail('usage: verify <update-android.json> [--apk <file>]');
  const f = flags(args);

  let envelope: unknown;
  try {
    envelope = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail('not a JSON envelope');
  }
  const opened = await openEnvelope(envelope);
  if ('reason' in opened) fail(opened.reason);
  console.log('signature OK: signed by the key compiled into the app');
  console.log(JSON.stringify(opened.manifest, null, 2));

  if (f.apk) {
    // The published asset against the signed hash. This is where a replaced or truncated
    // upload is caught - the app itself never downloads the APK.
    const apk = readFileSync(f.apk);
    const { name, size, sha256: signed } = opened.manifest.asset;
    if (apk.length !== size || sha256(apk) !== signed) {
      fail(`${path.basename(f.apk)} does NOT match the signed asset ${name} (size or SHA-256 differ)`);
    }
    console.log(`${path.basename(f.apk)} matches the signed size and SHA-256`);
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'keygen':
    keygen(rest[0]);
    break;
  case 'sign':
    await signManifest(rest);
    break;
  case 'verify':
    await verify(rest[0], rest.slice(1));
    break;
  default:
    fail('usage: update-manifest.mts keygen|sign|verify - see the header of this file');
}
