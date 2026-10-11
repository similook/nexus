# Nexus desktop

The Windows/macOS/Linux shell. Architecture: [ADR-0003](../../docs/adr/ADR-0003-desktop-client-architecture.md).

**Status: Phase 4 of 10, plus the Windows 1.3.1 release packaging.** The native Tauri window
runs the real UI against the real `nexusd` daemon over an opaque forwarder, with a tray,
single-instance, real window visibility (R1), native HTTP for subscription URLs, a
Content-Security-Policy and a native device-network source. On Windows the installer ships
`nexusd` and the app runs it, asking Windows for administrator rights when you connect — see
[Windows release](#windows-release-131). Phase 6's service will replace that prompt; see
[ADR-0003 §6.4](../../docs/adr/ADR-0003-desktop-client-architecture.md).

```bash
npm install
npm run dev          # http://localhost:5174 — browser, simulated core
```

### Running the Tauri shell against the daemon

```bash
# from clients/desktop
npx tauri dev        # builds nexusd first (npm run build:nexusd), and the app runs it
```

The app starts `nexusd` itself, not elevated, and elevates it on Connect — exactly as the
installed app does. To drive a daemon you started yourself instead (`nexusd serve -s <path>`,
from an Administrator console for a TUN), set `NEXUS_SOCKET=<path>`: the app then starts,
stops and elevates nothing. Keep that path short: AF_UNIX paths are limited to 108 bytes, and a
longer one fails to bind with an opaque `invalid argument`.

5174, not 5173 — that one is `clients/web`, and running both during the port is routine.

---

## What is here

```
src/
├── main.tsx          entry: build the port, attach coreEvents, render
├── fonts.ts          the eight @fontsource faces
└── port/
    ├── index.ts      choose a port for this run — both are lazy imports
    ├── browser.ts    the dev port — simulated core, fetch, navigator.clipboard
    └── tauri.ts      the shipping port — framed JSON to nexusd via the host
src-tauri/
├── src/lib.rs        the host: window + an opaque line forwarder to nexusd
├── src/daemon.rs     Windows: runs nexusd, elevates it through the UAC prompt on Connect
├── src/tray.rs       tray, hide-to-tray, quit-disconnects-first, window visibility (R1)
├── src/network.rs    device network status from the OS (Windows: NCSI via WinRT)
├── capabilities/     what the page may call: core, and native HTTP to http(s) URLs
├── tauri.conf.json   window, bundle icons, and the Content-Security-Policy
├── tauri.windows.conf.json   Windows only: nexusd as externalBin, the per-machine NSIS installer
└── windows/installer-hooks.nsh   a running nexusd during (un)install, and the daemon's state dir
scripts/
└── build-nexusd.mjs  nexusd for the bundle, via core/scripts/build-desktop.sh, then proven
```

Everything else — every view, component, hook and parser — comes from
[`@nexus/shared`](../shared), aliased in `vite.config.ts` to `../shared/src`.

### Why an alias and not an npm workspace

A workspace root would hoist `node_modules` and change how `clients/web` resolves its own
dependencies. `clients/web` is the shipped Android app and was off limits for this phase;
"it probably still resolves the same" is not a standard that survives a release.

Vite compiles `../shared/src` inside this project's graph, so React resolves from *this*
package. One React instance, no duplicate-copy hook errors.

---

## What the browser port does not do

It is honest about being a stub, which is the point:

| | Browser port (dev) | Tauri port (`port/tauri.ts`) |
|---|---|---|
| `core` | `NexusCoreWeb` simulation | framed JSON to `nexusd` over a pipe |
| `http` | `fetch` — **CORS-fails on real subscription links**, and the browser drops the `User-Agent` panels key off | native HTTP — the Tauri HTTP plugin, in the host |
| `clipboard` | `navigator.clipboard` | unchanged — a desktop webview has neither the secure-context nor user-activation problem that forced Android onto native ClipboardManager |
| `appState` | `document.visibilityState` — misses minimise, occlusion and tray-hide, so R1 is only approximated | window visibility reported by the host (hidden to tray, minimised, restored) |

`createPort()` **throws** if it detects Tauri, rather than falling back to the stub. A packaged
VPN client silently running a simulation is the worst failure available to it.

---

## Phase 4 checklist

- [x] `src-tauri/` — window (Tauri 2.11, not the 3.0 alpha on crates.io).
- [x] `src/port/tauri.ts` — `PlatformPort` over `invoke`/`listen`. The host forwards **opaque
  lines** and holds no model of the protocol (ADR-0003 §4.2); the contract lives in TypeScript
  and Go only.
- [x] **The stub is lazy.** Both ports are `import()`ed behind the host check, so the simulated
  core is never loaded under Tauri.
- [x] ~~Elevation failures must match `/permission denied/i`~~ — **that was backwards.** The regex
  meant "user declined Android's consent dialog" and hid the error. `clients/shared` now matches
  only `VPN permission denied`; every other failure is shown. See ADR-0003 §4.2.
- [x] **Tray** — left click restores, the menu has Show and Quit. Closing the window hides it
  and changes nothing; **Quit sends `stop` first**, then exits (ADR-0003 §4.3).
- [x] **Single-instance** — a second launch exits and brings the first window back, from the
  tray or the taskbar.
- [x] **Real window visibility** (`src-tauri/src/tray.rs`) — hidden to the tray or minimised is
  "not visible": the page drops its link to `nexusd` and reopens it on return (R1). The daemon,
  and any tunnel, carry on.
- [x] **Native HTTP** — the Tauri HTTP plugin, pinned to the npm package's minor (`~2.6`; the CLI
  refuses a mismatched pair). Scope: any http(s) URL, as on Android. Certificates are always
  verified (`dangerous-settings` is not compiled in), the system proxy is honoured, and the
  timeouts follow Android's (15 s connect, 15 s read): 15 s to connect, 30 s for the headers,
  then at most 15 s of *silence* — a slow link that keeps delivering is never cut off.
- [x] **Content-Security-Policy** — see [Security](#security).
- [x] **Device network status** (`src-tauri/src/network.rs`) — Windows' own connectivity verdict
  (NCSI, through WinRT), hardware adapters only: the counterpart of Android's `NOT_VPN` filter.
  A PC whose only link is PPPoE or a VPN reads `unknown`, never a false "No network". Other
  desktop OSes answer `unknown` until they have a source.
- [x] **Icons** — generated from `branding/icon-full.svg`, the existing artwork.
- [x] `externalBin` for `nexusd` — **Windows**, in the 1.3.1 installer (see below). Linux
  packages remain Phase 5.
- [ ] ADR-0003's Phase 4 exit test — connect/disconnect end to end from the real UI, with a
  TUN. The Windows build can now run it; the tests that need a UAC answer are listed under
  [Windows release](#windows-release-131) and have not been run yet.

---

## Windows release (1.3.1)

```bash
# from clients/desktop. Needs Node, Rust, Go, and Git for Windows (its bash runs the Go build)
npm install
npx tauri build      # -> src-tauri/target/release/bundle/nsis/Nexus_1.3.1_x64-setup.exe
```

A per-machine NSIS installer: Program Files, one UAC prompt to install. The user needs nothing
else — no Go, no PowerShell, no console, no daemon to start.

**The daemon in the bundle.** `tauri build` runs `npm run build:nexusd` (Windows only, from
`tauri.windows.conf.json`), which runs `core/scripts/build-desktop.sh` unchanged: tags
`with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api`, `-trimpath`,
`-ldflags "-s -w -X main.version=1.3.1"`, CGO off. It then refuses the binary unless
`go version -m` lists all five tags, sing-tun's gVisor stub is absent, `nexusd check` accepts a
config that needs clash_api, uTLS, QUIC and WireGuard (fake keys, 192.0.2.1), and the binary
reports the app's version. Each proof was checked against a build missing its tag: all five
were caught.

**How it runs** (`src-tauri/src/daemon.rs`):

| When | What happens |
|---|---|
| App start | `nexusd serve` starts **unelevated**, as the app's child, on `%TEMP%\nexusd-<app pid>.sock`. Ping, logs and status work at once. |
| First Connect of a session | The UI stays "connecting" with "Approve the Windows prompt to connect…" — cancellable, and outside the 10 s connect watchdog. The plain daemon is stopped and Windows' UAC prompt starts `nexusd.exe` as administrator on the same socket. Approved: the connect continues. Declined: back to Disconnected — never Connected — and the plain daemon comes back. |
| Later connects | No prompt: the elevated daemon serves the app until the app exits. |
| App exit | Both daemons run with `-parent <app pid>` and exit with the app — Quit, crash or Task Manager — stopping the tunnel on the way out. Tray Quit still sends `stop` first. |
| (Un)install | The template closes a running app; a running `nexusd.exe` is renamed aside so its file can be replaced, and deleted once it has exited (`windows/installer-hooks.nsh`). |

**Security.**

- Per-machine install, so the binary that gets elevated sits where only administrators can write.
- The elevated daemon's working directory (its cache.db) and guard state dir is
  `<install dir>\state`, created by the installer with Program Files' permissions. Not the
  user's profile: an unprivileged process could plant a link there to redirect an
  administrator's write.
- The app itself never runs elevated. The socket is still an AF_UNIX file in the user's temp
  directory, so any process running as the user can drive the elevated daemon — as with a
  manually elevated `nexusd serve`. The guard (`core/desktop/guard`) is the boundary; Phase 6's
  ACL'd named pipe with a peer check is the real fix.
- Nothing is code-signed yet: a downloaded installer may meet SmartScreen, and the UAC prompt
  says "Unknown publisher".

**Testing a real tunnel safely.** A tunnel changes this PC's routing table. Before connecting,
know the way back, in order:

1. Disconnect in the app, or tray → **Quit Nexus** (stops the tunnel, then exits).
2. App unresponsive: end `nexus-desktop.exe` in Task Manager. Its daemon notices and stops the
   tunnel as it exits (`-parent`).
3. Last resort: end `nexusd.exe` (Task Manager, as administrator). The TUN adapter and its routes
   go with the process.

An optional safety net, from a PowerShell window left open during the test. If a Nexus tunnel
is still up after 10 minutes, it closes the app, which stops the tunnel. `172.19.0.1` is the
TUN's address (`clients/shared/src/core/singboxConfig.ts`), so it touches nothing otherwise:

```powershell
Start-Job { Start-Sleep 600; if (Get-NetIPAddress -IPAddress 172.19.0.1 -EA SilentlyContinue) { Stop-Process -Name nexus-desktop -Force } }
```

Tunnel up: `Get-NetIPAddress -IPAddress 172.19.0.1` finds it. Routes back: `Get-NetRoute
-DestinationPrefix 0.0.0.0/0` lists only physical adapters. Nothing orphaned after Quit:
`Get-Process nexusd, nexus-desktop` finds nothing. What has and has not been verified is in
[ADR-0003 §6.4](../../docs/adr/ADR-0003-desktop-client-architecture.md).

---

## Routing (desktop only)

Home → **Routing**: two choices, each with its one-line explanation in the UI.

| Choice | Internet traffic | LAN / private addresses |
|---|---|---|
| **VPN** — "All traffic uses the VPN." | through the VPN | direct |
| **Direct** — "All traffic uses your normal internet connection." | direct | direct |

- **Default VPN**, remembered in `localStorage` (`nexus.routing.v2`, just the mode). The stored
  choice changes only when the user picks.
- **How**: at connect, the port composes both modes onto the node's config as sing-box
  `clash_mode` rules (`clients/shared/src/core/routing.ts`). Switching while connected is
  sing-box's own live switch (`setClashMode`), then `closeConnections` so open connections
  re-route. **The tunnel stays up; a switch is never a disconnect.**
- **What the row shows is what the daemon reports** — the `clashMode` event, the status
  snapshot, `getStatus()` on show — with "Switching to …" in between. The daemon re-applies the
  chosen mode after every start, because sing-box would otherwise restore the last mode saved in
  `cache.db` (a user who last used Direct would reconnect in Direct).
- **DNS**: address lookups get a fakeip answer in both modes, as before — that is what keeps a
  live switch correct. A connection routed direct resolves its real address through
  `dns-local`, the physical adapter's DNS servers. One DNS rule applies in Direct mode only:
  queries that are not address lookups (HTTPS, SVCB, TXT…) go to `dns-local` too, because
  their default server is pinned to the proxy. VPN-mode DNS is unchanged.
- **Tests**: `npm --prefix ../shared run check-routing` (modes, persistence, composition; it
  also writes `core/testdata/desktop/routing.json`) and `go test ./desktop/...` in `core/`, which
  runs that exact fixture on a real sing-box: where each destination goes in each mode, live
  switches both ways, connections restarted, and which DNS server answers in each mode.

Android has no routing selector: a shell opts in with `PlatformPort.routing`.

---

## Security

The Content-Security-Policy (`src-tauri/tauri.conf.json`):

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src ipc: http://ipc.localhost;
object-src 'none'; base-uri 'none'; form-action 'none'
```

No remote origin anywhere, because the page never needs one:

- `connect-src` is Tauri's IPC and nothing else. Subscription URLs are fetched by the **host**
  (the HTTP plugin), over IPC — the page itself cannot reach the network.
- `img-src data:` is the Share tab's QR code, a `data:` PNG.
- Fonts are the self-hosted `@fontsource` files. Tauri adds hashes for its own scripts at build
  time.
- The promo slot (`shared/src/core/ads.ts`) is disabled. Enabling it means adding its origins
  here, as the note beside `ENDPOINT` says.

Verified on the built app, not the dev server: zero violations and zero console errors while
driving IPC, a subscription import, the QR code, the QR scanner's decoder (loaded the way the
scanner loads it, decoding the Share tab's QR) and all eight font faces. A remote `fetch`, a
remote image and an inline script were each blocked and reported. The camera itself was not
switched on for the test; `getUserMedia` and `video.srcObject` are not governed by CSP.

**The Vite dev server's page is not covered.** Tauri injects nothing into `devUrl` pages on
desktop (checked: no header, no meta tag, and an inline script runs), so a CSP change has to be
checked on a `npx tauri build --debug --no-bundle` build, which serves the real assets with the
policy and keeps DevTools.

---

## Checks

```bash
npm run typecheck
npm run build
npm run build:nexusd   # Windows: cargo needs src-tauri/binaries/nexusd-<triple>.exe to exist
# the host, from src-tauri/
cargo fmt --check
cargo clippy --all-targets
cargo test
```

Both verified green. `npm run build` emits ~215 KB of JS (68 KB gzipped) plus split chunks for
`jsqr` and the QR encoder — no figure here is a performance claim, just what the bundler
reported.
