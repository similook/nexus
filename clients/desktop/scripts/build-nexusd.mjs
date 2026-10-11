// Build nexusd for the Windows bundle: src-tauri/binaries/nexusd-<target triple>.exe, the name
// bundle.externalBin (src-tauri/tauri.windows.conf.json) looks for. `tauri build` and `tauri dev`
// run this first; cargo needs the file too, so run it by hand before `cargo build`/`clippy`.
//
// THE BUILD IS core/scripts/build-desktop.sh, UNCHANGED. This only chooses its target, output and
// version, then proves what came out, because a daemon missing a tag fails late and far away:
// without with_gvisor, only when a TUN starts on the user's machine.
//
//   tags      `go version -m` must list all five, and TAGS from the environment is dropped so
//             the script's own set is what a release gets
//   gvisor    the binary must not contain sing-tun's "not included" stub, which is linked only
//             without the tag - a TUN would fail with it at connect time
//   the rest  `nexusd check` of a config that needs clash_api, utls, quic and wireguard: each
//             fails at construction when its tag is missing. Fake keys and a documentation
//             address (192.0.2.1), generated here, so nothing key-shaped lives in the tree.
//   version   stamped from tauri.conf.json, so the daemon and the app report the same one
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_TAGS = ['with_gvisor', 'with_quic', 'with_wireguard', 'with_utls', 'with_clash_api'];
const GVISOR_STUB = 'gVisor is not included in this build';

// Rust target triple -> GOOS/GOARCH. Windows is the only desktop target that bundles nexusd.
const GO_TARGETS = {
  'x86_64-pc-windows-msvc': ['windows', 'amd64'],
  'aarch64-pc-windows-msvc': ['windows', 'arm64'],
};

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..', '..');

function fail(message) {
  console.error(`build-nexusd: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`${command}: ${result.error.message}`);
  return result;
}

// Git for Windows' bash. Not `bash` from PATH: on Windows that can be WSL's, which would build a
// Linux binary in a Linux filesystem, and Git's bash is often not on the PATH npm sees at all.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  const git = run('where.exe', ['git']).stdout?.split(/\r?\n/).filter(Boolean) ?? [];
  for (const exe of git) {
    // <Git>\cmd\git.exe or <Git>\mingw64\bin\git.exe
    candidates.push(join(dirname(dirname(exe)), 'bin', 'bash.exe'));
    candidates.push(join(dirname(dirname(dirname(exe))), 'bin', 'bash.exe'));
  }
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (root) candidates.push(join(root, 'Git', 'bin', 'bash.exe'));
  }
  for (const bash of candidates) {
    if (!existsSync(bash)) continue;
    const system = run(bash, ['-c', 'uname -s']).stdout?.trim() ?? '';
    if (/^(MINGW|MSYS)/.test(system)) return bash;
  }
  fail('Git for Windows (its bash) is needed to run core/scripts/build-desktop.sh');
}

const forward = (path) => path.replaceAll('\\', '/');

const version = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
const triple =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  /^host: (.+)$/m.exec(run('rustc', ['-vV']).stdout ?? '')?.[1]?.trim() ||
  fail('cannot tell the Rust target triple (no TAURI_ENV_TARGET_TRIPLE, no rustc)');
const target = GO_TARGETS[triple] ?? fail(`no nexusd build for ${triple}`);
const [goos, goarch] = target;

const outdir = join(desktop, 'src-tauri', 'target', 'nexusd');
const built = join(outdir, `nexusd-${goos}-${goarch}.exe`);
const bundled = join(desktop, 'src-tauri', 'binaries', `nexusd-${triple}.exe`);

// --- build ---------------------------------------------------------------------------------

const env = { ...process.env, TARGETS: `${goos}/${goarch}`, OUTDIR: forward(outdir), VERSION: version };
delete env.TAGS;
const build = run(findBash(), [forward(join(repo, 'core', 'scripts', 'build-desktop.sh'))], {
  env,
  stdio: 'inherit',
});
if (build.status !== 0) fail(`core/scripts/build-desktop.sh exited with ${build.status}`);

// --- prove it ------------------------------------------------------------------------------

const info = run('go', ['version', '-m', built]).stdout ?? '';
const tags = /^\s*build\s+-tags=(\S+)/m.exec(info)?.[1]?.split(',') ?? [];
const missing = REQUIRED_TAGS.filter((tag) => !tags.includes(tag));
if (missing.length > 0) fail(`built without ${missing.join(', ')} (tags: ${tags.join(',') || 'none'})`);
// Asked of the binary: build info omits -ldflags under -trimpath.
const reported = run(built, ['version']).stdout ?? '';
if (!reported.startsWith(`nexusd ${version} `)) fail(`expected version ${version}, the binary says: ${reported.trim()}`);

if (readFileSync(built).includes(GVISOR_STUB)) fail('the gVisor stub is linked: a TUN would fail to start');

const scratch = mkdtempSync(join(tmpdir(), 'nexusd-check-'));
try {
  const key = () => randomBytes(32).toString('base64');
  const config = join(scratch, 'features.json');
  writeFileSync(
    config,
    JSON.stringify({
      log: { level: 'error' },
      endpoints: [
        {
          type: 'wireguard',
          tag: 'needs-wireguard',
          address: ['10.200.0.2/32'],
          private_key: key(),
          peers: [{ address: '192.0.2.1', port: 51820, public_key: key(), allowed_ips: ['0.0.0.0/0'] }],
        },
      ],
      outbounds: [
        {
          type: 'vless',
          tag: 'needs-utls',
          server: '192.0.2.1',
          server_port: 443,
          uuid: randomUUID(),
          tls: { enabled: true, server_name: 'example.com', utls: { enabled: true, fingerprint: 'chrome' } },
        },
        {
          type: 'hysteria2',
          tag: 'needs-quic',
          server: '192.0.2.1',
          server_port: 443,
          password: randomUUID(),
          tls: { enabled: true, server_name: 'example.com' },
        },
        { type: 'direct', tag: 'direct' },
      ],
      route: { final: 'direct' },
      experimental: { clash_api: { external_controller: '127.0.0.1:0' } },
    }),
  );
  const check = run(built, ['check', '-c', config]);
  if (check.status !== 0) fail(`nexusd check rejected the feature config:\n${check.stderr || check.stdout}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// --- hand it to the bundler ----------------------------------------------------------------

mkdirSync(dirname(bundled), { recursive: true });
copyFileSync(built, bundled);
const size = (statSync(bundled).size / 1024 / 1024).toFixed(1);
console.log(`nexusd ${version} for ${triple}: ${REQUIRED_TAGS.join(', ')} - verified`);
console.log(`  -> ${bundled} (${size} MB)`);
