# ADR-0003 — Desktop client architecture

- **Status:** Proposed
- **Date:** 2026-09-19
- **Decision:** **Tauri v2** shell + **`nexusd`**, a privileged Go daemon that hosts sing-box
  in-process and owns the TUN. They talk over a **named pipe / unix socket** carrying the
  existing `NexusCorePlugin` contract as framed JSON. The Tauri host never parses it.

---

## 1. Context

Android v1.1.0 is frozen. Desktop (Windows, macOS, Linux) is next, iOS after it.

Three things about the existing codebase determine the whole design, and all three were
verified rather than assumed:

**The frontend is already portable.** `clients/web/src` is 5,505 lines across 26 files, of
which fewer than ~250 touch Capacitor. There is exactly **one** `registerPlugin` call
([plugin.ts:233](../../clients/web/src/core/plugin.ts)), and the UI actually uses only **8
methods and 3 events** of the declared surface — `start`, `stop`, `getStatus`, `tcpPing`,
`pingProxy`, `readLogs`, `clearLogs`, `setLogStreaming`; `status`, `serviceState`,
`proxyDelay`. Everything else in `plugin.ts` is declared and never called.

**The Go core is already portable.** `core/nexuscore` has **zero build tags, zero cgo, zero
GOOS gating**; `power.go` and `runtime.go` import nothing from sing-box at all. The module
resolves cleanly for `GOOS=windows/darwin/linux` with the shipped tag set. `sing-tun` and
`golang.zx2c4.com/wintun` are already in `go.sum`.

**But libbox can never create a TUN.** This is the fact the design turns on.
`experimental/libbox/service.go:55`:

```go
func (w *platformInterfaceWrapper) UsePlatformInterface() bool {
	return true
}
```

A literal, not a delegation. And `protocol/tun/inbound.go:428` is where it matters:

```go
if t.platformInterface != nil && t.platformInterface.UsePlatformInterface() {
	tunInterface, err = t.platformInterface.OpenInterface(&tunOptions, t.platformOptions)
} else {
	tunInterface, err = tun.New(tunOptions)     // ← sing-tun: Wintun / utun / /dev/net/tun
}
```

On Android that is correct: Kotlin's `VpnService.Builder.establish()` produces the fd and
hands it down. On desktop nothing produces an fd, so **desktop must drop below libbox**.

> **Amended in Phase 2 — it is simpler than this.** The original plan was to implement
> `adapter.PlatformInterface` with `UsePlatformInterface()` returning `false`, following
> `experimental/boxdd/platform_linux.go:54` and `platform_windows.go:68`. That works, but it
> is 35 methods of interface to satisfy for one boolean.
>
> It is not necessary. `box.New` reads the platform interface out of the **service context**
> (`box.go:172`), not from its `Options`, so if nothing registers one the value is `nil` — and
> the guard above tests `!= nil` first. **sing-box's own CLI does exactly this:**
> `cmd/sing-box/` contains no reference to `PlatformInterface` at all, and it is a working
> desktop TUN client.
>
> So `nexusd` registers no platform interface and sing-tun owns the device. We follow the CLI,
> not `boxdd`. A platform interface becomes necessary only for the things it is actually for —
> system proxy, process-owner lookup, notifications — none of which is the tunnel itself.
> Implemented in `core/desktop/tunnel`.

`boxdd` is `package main`, so it cannot be imported — it is a template, not a library. Note
also that **it has no `platform_darwin.go`**: upstream's daemon covers Linux and Windows only.
sing-tun itself does support macOS (`tun_darwin.go` creates a utun over
`AF_SYSTEM`/`SYSPROTO_CONTROL`), so the device works — it is the *daemon and privilege*
scaffolding we write ourselves on macOS.

---

## 2. Framework: Tauri v2

### 2.1 The argument that decides it

The instinct is Wails, because the core is Go and Wails would put it in-process. **That
advantage does not exist here**, and seeing why settles the question.

The desktop TUN needs `CAP_NET_ADMIN` / root / Administrator, plus route-table and firewall
writes. Putting the core in the GUI process means **running the entire webview as root**. That
is not a trade-off to weigh; it is disqualifying. A webview renders untrusted remote content
(subscription bodies, promo images), and it is the single largest attack surface in the
product.

So the Go core is a **separate privileged process on every OS regardless of framework**. Once
that is fixed, the GUI framework is only a window, a tray icon, and a pipe — and should
therefore be whichever option is smallest and most stable.

### 2.2 Comparison

| | Tauri v2 | Wails v3 | Electron |
|---|---|---|---|
| Host language | Rust (new to us) | Go (known) | Node (known) |
| Webview | OS-native (WebView2 / WKWebView / WebKitGTK) | OS-native | Bundled Chromium |
| Installer size | smallest | small | largest |
| Idle memory | lowest | low | highest |
| Tray | first-class, all 3 OSes | first-class in v3 | mature |
| Sidecar binary | `externalBin` — built for this | manual | manual |
| Maturity | stable since Oct 2024 | v3 is the newer rewrite; verify its release state before committing | most mature |
| In-process Go core | n/a | **yes, but we must not use it** | n/a |

No size or memory figures are quoted because we have not measured them, and `CLAUDE.md`
forbids performance numbers not backed by a run in `bench/`. The ordering above is
directional; **if footprint is to be claimed publicly it needs a `bench/B-05` run.**

### 2.3 Why Tauri wins, and what it costs

- **Sidecar packaging is the deciding feature.** `nexusd` is an external binary that must be
  built per-target, signed, bundled, and installed as a service. Tauri's `externalBin` /
  `bundle.resources` plus its NSIS/MSI, `.app`/`.dmg` and deb/rpm/AppImage targets do this as
  a first-class flow. On the other two it is hand-rolled packaging scripts.
- **Smallest shell**, which is the honest expression of a project whose stated primary metric
  is idle power.
- **Stable.** Wails v3's maturity is the open risk; Tauri v2 has been stable for nearly two
  years.

The real cost is **Rust, which nobody on this project writes**. The mitigation is §4.2: the
Rust host is deliberately kept contract-free — a window, a tray, and a byte forwarder. If it
ever grows a model of the protocol, that mitigation has failed and the cost becomes real.

**Electron is rejected** on footprint: shipping a second browser engine inside a client whose
differentiator is restraint is incoherent, and it would have to be justified in the README
next to a battery claim.

**Wails v3 is the fallback** if the Rust surface turns out bigger than §4.2 predicts. Nothing
else in this ADR changes if we switch — the daemon, the protocol, and the shared frontend are
all framework-independent. That is deliberate.

---

## 3. Privileged TUN and routing

One daemon, `nexusd`, same Go source on all three OSes, differing only in a per-OS platform
file and a per-OS service harness. It hosts sing-box in-process via `box.New` with a platform
interface returning `UsePlatformInterface() == false`.

### 3.1 Windows

- **Wintun.** Ship `wintun.dll` (signed by WireGuard LLC) next to `nexusd.exe`; sing-tun loads
  it through `golang.zx2c4.com/wintun`. The DLL installs its own kernel driver on first adapter
  creation, so **no WHQL work of ours** — but adapter creation requires Administrator.
- **Privilege model: a Windows Service, not an elevated sidecar.** `nexusd` registers with the
  SCM as LocalSystem, installed once by the MSI/NSIS installer under a single UAC prompt at
  setup. Harness: `golang.org/x/sys/windows/svc`; upstream's template is
  `boxdd/cmd_service_windows.go`.

  The alternative — relaunching an elevated sidecar per session — means a **UAC prompt on
  every connect**. Users click through prompts they see repeatedly, which trains exactly the
  wrong reflex for a security product. Rejected.
- **IPC:** named pipe `\\.\pipe\nexus-<sid>`, ACL'd via SDDL to the installing user's SID plus
  `SYSTEM`. Not `Authenticated Users` — on a shared machine that would let any logged-in
  account drive the tunnel.
- **Routing:** `auto_route` + `strict_route: true`. On Windows strict_route installs WFP
  filters; both the filters and the adapter must be torn down (§5).
- **Shutdown:** accept `SERVICE_ACCEPT_PRESHUTDOWN`, not just `SERVICE_CONTROL_SHUTDOWN`.
  Plain shutdown notification gives seconds; preshutdown gives minutes. Tearing down WFP and
  a Wintun adapter is not a five-second job, and losing that race is how a machine reboots
  with no network.

### 3.2 macOS

Upstream gives us the least here — no `boxdd/platform_darwin.go` — so this is the most
original work.

- **utun** via sing-tun's `tun_darwin.go` (`AF_SYSTEM` / `SYSPROTO_CONTROL`,
  `com.apple.net.utun_control`). Needs root.
- **Privilege model: a `LaunchDaemon`,** at `/Library/LaunchDaemons/io.nexus.nexusd.plist`,
  registered from the GUI app via `SMAppService.daemon(plistName:)` (macOS 13+). The user
  approves once in System Settings → Login Items. The binary lives inside the app bundle at
  `Contents/Library/LaunchDaemons/`.
- **Rejected: a NetworkExtension System Extension.** It needs the
  `com.apple.developer.networking.networkextension` entitlement, which is granted per-request
  by Apple, and it would require a *second*, Apple-only core integration path — precisely the
  NEPacketTunnelProvider work iOS needs but built a second time for a different host. For a
  GPL project shipping from GitHub Releases, a LaunchDaemon keeps one `nexusd` across all
  three desktop OSes.
- **This requires a paid Apple Developer Program membership** (Developer ID + notarization).
  Without it macOS users get a Gatekeeper wall. There is no way around this that is not worse.
  It is the one hard external dependency in this ADR.
- **IPC:** unix socket at `/var/run/nexusd.sock`, `0660`, owned by a `nexus` group; peer
  identity checked with `LOCAL_PEERCRED` / `getpeereid()`.

### 3.3 Linux

- **`/dev/net/tun`** via `tun_linux.go`.
- **Privilege model: a systemd system service** with
  `AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW` running as a dedicated `nexusd` user —
  capabilities, not full root. Upstream template: `boxdd/cmd_service_linux.go`.
- **IPC:** unix socket at `/run/nexusd/nexusd.sock`, `0660`, group `nexus`; the user must be
  in that group (the postinstall script says so explicitly rather than adding them silently).
  Peer identity via `SO_PEERCRED` — copy `boxdd/peer_linux.go`, which additionally checks the
  peer's **process start time** to defeat PID reuse.
- **DNS:** taking over DNS conflicts with `systemd-resolved` on `127.0.0.53`. Needs explicit
  handling, and it is the most likely source of distro-specific bug reports.
- **Packaging:** `.deb`, `.rpm`, and AppImage + an install script. **Flatpak cannot ship a
  privileged system daemon** — at best a Flatpak GUI talking to a host-installed `nexusd`.
  Out of scope for v1; say so in the README rather than letting users discover it.
- **Non-systemd distros:** `nexusd --foreground` exists and works; OpenRC/runit units are
  community-contributed, not supported.

### 3.4 Config differences from Android, and a new security boundary

Two values in [singboxConfig.ts](../../clients/web/src/core/singboxConfig.ts) are wrong for
desktop and the file already explains why:

- **`strict_route: false`** is set because "on Android the VpnService builder already owns
  routing". On desktop nothing owns routing but sing-box, so **`strict_route: true`** — it is
  what prevents leaks around the tun.
- **`stack: 'gvisor'`** was chosen after `system` carried UDP but dropped all TCP *on Android*.
  That evidence is Android-specific. Desktop must **re-test, not inherit** — `system` or
  `mixed` may work and cost less. Do not copy the value across and do not claim a figure
  without a `bench/` run.

More importantly: **`nexusd` is privileged and takes a config blob from an unprivileged
client.** That is a new privilege boundary that does not exist on Android, where the config
never crosses a trust line. A hostile or malformed config reaching a LocalSystem/root process
is a local privilege-escalation path.

So [ConfigGuard.kt](../../clients/android/nexus-plugin/src/main/java/io/nexus/plugin/ConfigGuard.kt)
is **ported to Go in the daemon and promoted from policy guard to security control**: validate
the config shape, reject unexpected inbound types, reject file paths outside our own
directories, reject `auto_redirect`, clamp health-check intervals, keep the DNS pre-resolution
and `assertUsableAddress` checks. This also puts validation where
[ADR-0002 §2](ADR-0002-frontend-stack.md) always said it belonged.

### 3.5 Latency probes must not go through the tunnel

On Android, `tcpPing` measures the real network because the app's own package is on the
VpnService **deny** list. On a system-wide desktop TUN that inverts: probes would measure the
tunnel and "Test All" silently stops meaning what it says. The same inversion breaks the
privacy note in [ads.ts](../../clients/web/src/core/ads.ts).

**Fix: run the probes inside `nexusd`, dialled through the same path sing-box already uses for
its own proxy connections.** That path *must* bypass the tun — otherwise the proxy connection
itself would loop back through the tunnel it creates — so the exclusion already exists on every
OS (fwmark on Linux, WFP process exclusion on Windows, interface binding on macOS). Reusing it
is correct by construction rather than a second mechanism to maintain.

---

## 4. IPC and lifecycle

### 4.1 Two hops, not three — and no libbox command server

[core/docs/ipc-boundary.md](../../core/docs/ipc-boundary.md) describes three hops because on
mobile the plugin and the core are in different processes, bridged by
`libbox.CommandServer`/`CommandClient` over gRPC.

**On desktop the daemon and the core are the same process.** Hop ② has nothing to cross. Using
libbox's command server here would mean the daemon serialising gRPC to itself so it can
deserialise it again.

```
┌─ user session (unprivileged) ─────────┐   ┌─ nexusd (privileged) ──────────┐
│  React + TS (WebView)                 │   │  box.Box (sing-box in-process) │
│        ▲                              │   │  PlatformInterface:            │
│        │ ① Tauri invoke / emit        │   │    UsePlatformInterface()=false│
│        ▼                              │   │  sing-tun → Wintun/utun/tun    │
│  Rust host (window, tray, forwarder)  │   │  ConfigGuard (Go)              │
│        ▲                              │   │  IPC server                    │
│        │ ② named pipe / unix socket ──────────────┘                        │
└───────────────────────────────────────┘   └────────────────────────────────┘
```

**`CommandServerListenPort: 0` stays 0, and there is still no localhost TCP port** — the
ipc-boundary rule holds, by a different mechanism. R1–R5 carry over, with R1 rebased: there is
no "app backgrounded" signal on desktop, so status streaming stops on **window hidden /
minimised / tray-only**, and the daemon keeps counting while nobody is subscribed.

### 4.2 Protocol: framed JSON, and the Rust host does not parse it

The daemon speaks the **existing `NexusCorePlugin` contract** — the same 8 methods and 3
events — as newline-framed JSON over the pipe. Not gRPC.

- gRPC would add tonic, proto codegen and a second schema to the Rust host for an 8-method
  surface, and would put a typed model of the contract in a third language.
- The contract already exists in TypeScript. The frontend should need **zero** changes to it.

The important part is the shape: **`invoke('nexus_rpc', { payload })` forwards opaque bytes and
returns opaque bytes; daemon events are forwarded to the webview unparsed.** The Rust host has
no structs for any of it.

This directly fixes the known weakness on Android, where `plugin.ts` hand-mirrors
`NexusPlugin.kt` with no build-time check and the file itself admits a mismatch "fails at
runtime with an unhelpful error". With a byte forwarder the contract lives in exactly **two**
places (TypeScript and Go) instead of three, and the host cannot drift because it holds no
opinion about the payload.

Versioning: the daemon reports a protocol version on connect; the GUI refuses to drive a
daemon it does not understand and says so, rather than failing method by method. GUI and
daemon can be updated independently — they will be, on Linux.

Reconnection: the GUI reconnects with backoff and re-subscribes; the daemon is the source of
truth for state, and `getStatus` already returns `'unknown'` for exactly this case.

**Error strings are part of the contract** — but not in the way this section first said.
**Corrected 2026-09-23.** The original text claimed `useNexusCore.ts` matches
`/permission denied/i` "to decide whether to render a failure in red", and that elevation
failures must match it. The regex actually meant *the user declined Android's VPN consent
dialog* and rendered the failure as **nothing**. Designing `nexusd`'s elevation error to match
it made a non-elevated desktop Connect return silently to "Disconnected" — found end to end in
Phase 4. `clients/shared` now matches only the exact Android sentinel, `VPN permission denied`
(the one string `NexusPlugin.kt` produces for a declined dialog), so every other failure,
elevation included, is shown. The rule that survives: **only a genuine user choice may be
silent.**

### 4.3 Lifecycle and teardown

The Android lessons transfer almost unchanged, because they were about sing-box and bbolt, not
about Android:

- **The `cache.db` bbolt flock recurs.** Switching servers is still close-then-open on the same
  file. Same fix: one goroutine owns the box instance and serialises the swap; retry with
  backoff on `initialize cache-file: timeout`.
- **Teardown ordering still matters.** Close the device before the core, with a hard timeout,
  then force cleanup regardless of whether the core acknowledged. A tunnel that will not tear
  down is worse than one that tears down rudely.
- **`nexusd` must never hold its own mutex across a call into sing-box** — the re-entrancy
  hazard documented in [service.go:42](../../core/nexuscore/service.go) is sing-box's, not
  Android's.

New on desktop:

- **GUI exit must not strand a tunnel.** Default: quitting from the tray disconnects. A setting
  allows keeping it up. Closing the *window* only hides to tray and changes nothing. The
  failure to avoid is a user who thinks they quit and is still tunnelled.
- **The janitor.** On every start, before anything else, `nexusd` reclaims stale state from a
  previous crash: leftover Wintun adapter, WFP sublayer, `ip rule`/table, routes pointing at a
  dead utun. It knows what to clean because it **writes a state file listing what it
  installed** and deletes that file on clean teardown. A state file present at startup means
  the last run died.

  This is the desktop equivalent of the zombie-tunnel bug, and it is worse here: on Android a
  stranded tunnel dies with the process, whereas a stranded default route survives a reboot
  and leaves a machine with no internet and no obvious cause.
- **Sleep / hibernate / resume** map onto the existing `PowerController`
  (`SetDeviceIdle`, `NetworkChanged`) — it is already written to be correct when only some
  signals arrive, so desktop wiring is additive.

---

## 5. Directory layout

```
core/
├── cmd/nexusd/                  NEW — the daemon binary
│   ├── main.go
│   ├── service_windows.go       SCM harness      (template: boxdd/cmd_service_windows.go)
│   ├── service_linux.go         systemd          (template: boxdd/cmd_service_linux.go)
│   ├── service_darwin.go        LaunchDaemon     (no upstream template — ours)
│   └── janitor_{windows,linux,darwin}.go
├── desktop/                     NEW — portable desktop Go
│   ├── platform_{windows,linux,darwin}.go   UsePlatformInterface() == false
│   ├── ipc/                     framed-JSON server; the 8-method + 3-event contract
│   ├── guard/                   ConfigGuard, ported from Kotlin, now a security control
│   ├── probe/                   tcpPing / pingProxy dialled off-tunnel (§3.5)
│   └── state/                   the janitor state file
├── nexuscore/                   UNCHANGED — mobile (gomobile) path
└── scripts/build-desktop.sh     NEW — go build, same tag set, per-target

clients/
├── shared/                      NEW — everything platform-neutral, extracted from web/src
│   └── src/{core,components,views,data}/ + platform.ts (the port interface)
├── web/                         Android shell: index.html, main.tsx, plugin.capacitor.ts
└── desktop/                     NEW
    ├── src/{main.tsx, plugin.desktop.ts, shell/}
    ├── src-tauri/{src/{main.rs,rpc.rs,tray.rs}, tauri.conf.json, Cargo.toml}
    └── vite.config.ts

docs/adr/ADR-0003-desktop-client-architecture.md     this file
```

### 5.1 Sharing the frontend

The repo already duplicates its Kotlin tree, and `CONTRIBUTING.md` treats that as a wart to be
managed, not a pattern to copy. **Do not duplicate the frontend.**

Use **npm workspaces**. `clients/shared` holds everything platform-neutral; each shell owns
only its entry point, its Vite config, and its implementation of one interface:

```ts
export interface PlatformPort {
  core: NexusCorePlugin;                                    // the 8 + 3 contract
  clipboard: { write(text: string): Promise<void> };
  http: { get(url: string, headers?: Record<string,string>): Promise<HttpResponse> };
  appState: { subscribe(cb: (visible: boolean) => void): () => void };
  isStub: boolean;
}
```

That one interface closes every Capacitor leak at once — the two `Clipboard.write` call sites,
`CapacitorHttp.get` in `subscription.ts`, both `appStateChange` subscriptions, and
`Capacitor.isNativePlatform()` in `App.tsx:33`.

**That last one is a day-one desktop bug** and the reason `isStub` is a property of the port
rather than a runtime check: outside Capacitor, `isNativePlatform()` returns `false`, so a
desktop build would render the `WEB STUB — synthetic data, no core attached` banner
permanently, on top of a working tunnel.

Two known follow-ons, both real work, neither blocking:

- **`ServerNode.config` is raw sing-box JSON** generated in the frontend and read by five UI
  files. Two backends will drift through it. Interim: parameterise
  `buildConfig(outbound, { platform })`. The real fix is ADR-0002 §2 — move assembly into Go —
  deferred rather than done now, because doing it now blocks desktop on a mobile refactor.
- **The UI is a fixed 448 px phone shell** (`max-w-md`, `body { overflow: hidden }`, no
  breakpoints anywhere). It will run on desktop and look like a phone strip in the middle of a
  1440 px window. Scheduled as its own phase, not smuggled into the port.

---

## 6. Implementation plan

Each phase ends in something demonstrable. Phases 2–4 are Linux-only on purpose: it is the
cheapest place to prove the core architecture, and it needs no code signing.

| # | Phase | Ends when |
|---|---|---|
| 0 | This ADR | Accepted |
| 1 | Extract `clients/shared` + `PlatformPort`; Capacitor confined to `clients/web` | **Android v1.1.0 still builds, installs and connects.** Pure refactor — no behaviour change. This is the regression gate for the whole project. |
| 2 | ✅ **Done, partially verified.** `core/cmd/nexusd` + `core/desktop/tunnel`. `box.New` with **no** platform interface (see §1 amendment). No IPC. | Box lifecycle proven end-to-end and traffic routed, but **over a loopback inbound, not a TUN** — see §6.1. |
| 3 | ✅ **Done.** `core/desktop/ipc` (server + client), `core/desktop/guard`, `nexusd serve`, `nexusctl`. | `nexusctl verify` — 18 checks, 0 failed. See §6.2. |
| 4 | **Windows-testable work done; exit test open** (see §6.3). Tauri shell: window, tray, single-instance, opaque RPC forwarder, native HTTP, CSP, device-network source. `port/tauri.ts` (named `plugin.desktop.ts` above, before it existed). Windows 1.3.1 ships `nexusd` in the installer with app-managed elevation (§6.4). | End-to-end connect/disconnect on Linux from the real UI. **Not yet run** — it needs a TUN. |
| 5 | Linux packaging: systemd unit, ambient caps, socket group, deb/rpm/AppImage, postinstall. | A clean VM installs and connects without manual steps. |
| 6 | Windows: Wintun, SCM service, named pipe + SDDL ACL, preshutdown, MSI/NSIS with one UAC prompt. | Same, on Windows. |
| 7 | macOS: LaunchDaemon, `SMAppService`, Developer ID, notarization. | Same, on macOS — **gated on Apple Developer Program enrolment**. |
| 8 | Hardening: janitor + state file, crash recovery, teardown timeouts, off-tunnel probes. (**ConfigGuard moved to Phase 3** — it had to land with the privilege boundary it defends.) | Kill `-9` the daemon mid-tunnel and the next start restores the network. |
| 9 | Desktop UI pass: responsive layout, window chrome, keyboard, tray menu. | It stops looking like a phone. |
| 10 | `bench/B-05`: desktop idle draw and TUN stack comparison. Re-decide `stack` on evidence. | A number exists that may be quoted. |

**Verification at each phase**

- `./core/scripts/check-configs.sh` — needs a desktop tag source and desktop fixtures; today it
  scrapes tags from `build-android.sh` by regex, so desktop configs would be validated against
  the wrong feature set.
- `cd clients/web && npm run typecheck && npm run check-parsers` — must stay green through
  phase 1, since that phase moves every file those checks cover.
- Phase 8 acceptance is adversarial, not a happy path: `kill -9` the daemon while connected,
  reboot during teardown, pull the network cable mid-connect, start a second instance.

### 6.1 Phase 2 status — what is proven and what is not

Built: `core/cmd/nexusd` (`run` / `check` / `version`) and `core/desktop/tunnel`, plus
`core/scripts/build-desktop.sh` and `make desktop` / `make test-desktop`.

**Verified:**

- Compiles for linux/amd64, linux/arm64, darwin/arm64, darwin/amd64, windows/amd64,
  windows/arm64.
- **Links zero libbox packages.** Importing `nexuscore` for its `Version()` string pulled all
  of libbox in and broke the Linux link outright (`oomprofile: invalid reference to
  runtime/pprof.parseProcSelfMaps`, a `//go:linkname` needing `-checklinkname=0`). The fix was
  to drop the import, not to add the flag. That link error is the build system agreeing with
  §1: the two paths share sing-box, not libbox.
- `nexusd check` accepts the desktop TUN config **with `strict_route: true`** and rejects a bad
  one naming the offending type.
- `nexusd run` with a loopback `mixed` inbound: starts sing-box in 27 ms, serves SOCKS5 and
  HTTP proxy traffic (`HTTP 200`, sniffed `example.com:443` → `outbound/direct`), tears down.
- Seven tests in `core/desktop/tunnel/tunnel_test.go`, including **three sequential
  tunnels sharing `cache.db`** — the desktop rehearsal of the Android
  `initialize cache-file: timeout` bug — and a test pinning the `/permission denied/i` wording
  the UI matches on.

**Not verified, and the phase's own acceptance criterion:** *a TUN comes up and traffic flows
through it.* Everything above ran on Windows with no TUN, because bringing one up takes over
the host's default route and there is no crash recovery until Phase 8. **This needs a Linux VM
before Phase 3 depends on it.** The loopback result proves construction, start, routing,
serving and teardown; it does not prove `tun.New` succeeds or that `strict_route` installs
what it should.

**Found on the way, affecting Android too:** sing-box 1.14 warns that `independent_cache` is
deprecated and removed in 1.16. `clients/web/src/core/singboxConfig.ts` sets it, so this is a
live deprecation on the shipped mobile config, not a desktop-only concern.

### 6.2 Phase 3 status

Built: `core/desktop/ipc` (protocol, server, client, log ring, socket), `core/desktop/guard`,
`nexusd serve`, and `core/cmd/nexusctl`.

**Verified on Windows, end to end:**

- `nexusctl verify` — **18 checks, 0 failed**, covering all 8 methods and all 3 events plus the
  hello handshake.
- A real tunnel started **over IPC** (`nexusctl start`), traffic proxied through it
  (`HTTP 200`), the core's log ring pulled back over the wire (R3), and a **switch** — a second
  `start` replacing the first — with traffic still flowing afterwards. That last one is the
  Android `initialize cache-file: timeout` bug not recurring.
- 30 Go tests across `guard`, `ipc` and `tunnel`.

**Three decisions worth recording:**

1. **No `libbox.CommandServer` on desktop.** ipc-boundary.md §3 argues against building a
   parallel channel, but its premise was two processes. Here the daemon *is* the core process,
   so using libbox's gRPC would mean serialising to itself. Framed JSON over the socket
   instead — and per §4.2 the Tauri host forwards opaque bytes, so the contract lives in two
   places (Go and `plugin.ts`) rather than three.
2. **One transport on all three OSes.** AF_UNIX works on Windows 10 1803+ and was verified on
   this toolchain, so there is no named-pipe dependency and one code path to test. §3.1's named
   pipe is still the right end state for Windows, for a reason that is *not* "AF_UNIX doesn't
   work": a Windows AF_UNIX socket cannot report peer identity, so the only access control
   available is the file ACL. The swap is confined to `desktop/ipc/socket.go`.
3. **ConfigGuard landed here, not in Phase 8.** Phase 3 is what opens the privilege boundary —
   an unprivileged client handing a config to a root daemon — and a sing-box config across that
   boundary is closer to a script than to a document. Shipping the boundary without the guard
   would have been the wrong order.

**What the Go guard adds beyond the Kotlin**, because only these matter across a trust
boundary: an inbound-type allow-list; **loopback-only listeners** (a root daemon binding
`0.0.0.0` is an open relay with the user's IP); and file paths confined to the daemon's state
directory. The policy half — health-check floor of 600 s, TUN stack pinning, DNS pre-resolution
with poisoned-answer rejection — is ported faithfully, and `guard_test.go` pins the shared
constants against `ConfigGuard.kt`.

**Re-synced 2026-09-23.** "Ported faithfully" was true of the Kotlin *as it stood on 2026-09-20*.
Android v1.2.0 then changed `resolveOutboundServers`: keep the hostname in `server`, filter
poisoned answers instead of trusting the first, and hand the answers to the core as a `hosts`
DNS server via per-outbound `domain_resolver`. The Go guard now does the same, with one
deliberate difference — without a `dns` block it pins nothing rather than leaving a dangling
`domain_resolver` reference, a case Android never generates but `nexusctl` does. A/B through
real sing-box v1.14.0 with the only DNS server unreachable: without the guard, `lookup failed
... i/o timeout` after 5.0 s and HTTP 502; through it, resolved in under 1 ms and the request
reached the server.

**Two bugs the tests caught in code I had just written**, both silent in normal use:
`AllowPrivilegedInbounds` did nothing (two sequential checks where they should have been
alternatives), and `224.0.0.1` was reported as "link-local" rather than "multicast" because
`IsLinkLocalMulticast()` matches `224.0.0.0/24` and was tested first.

**Known gaps, all deliberate:**

- **`trafficAvailable` is always `false`.** sing-box's traffic manager is not reachable through
  an exported API — `adapter.ClashServer` has no traffic surface, and the daemon's own
  `readStatus` reads an unexported field. The contract's flag carries the meaning, so the UI
  renders `—` rather than a confident `0.00` over a working tunnel. **Wrong premise, fixed
  2026-09-27 (§6.4):** the manager is a public context service.
- **`tcpPing` goes through the tunnel when one is up**, inverting the Android semantics (§3.5).
  The fix needs sing-box's own outbound dialer, which this package has no handle on yet.
  Documented at the call site rather than silently shipping a number that means something else.
- **No race-detector run.** `-race` needs cgo and there is no C compiler on this machine.
  `make test-desktop-race` exists for Linux/CI, and it matters here: the log ring is written
  from sing-box's goroutines on the per-connection path.

### 6.3 Phase 4 status (Windows-testable work done 2026-09-26; exit test open)

Built on Windows: `clients/desktop/src-tauri` (Tauri **2.11** — crates.io's newest `tauri` is a
3.0 alpha, deliberately not used), the opaque forwarder (`nexus_connect` / `nexus_send`, lines
out as `nexus://frame`), `src/port/tauri.ts`, and lazy ports so the simulated core is no longer
in the Tauri path.

**Verified end to end from the real UI in the native window**, driven over WebView2's DevTools
protocol: no stub banner; live status from the daemon (traffic cards read "unavailable", the
daemon's honest `trafficAvailable: false`); a config link imported through the shared parsers;
`tcpPing` round-tripping through the daemon; Connect reaching the guard and sing-box, and the
non-elevated TUN failure rendered in full.

**Three bugs found by running it**, each fixed at its root: the §4.2 error-contract misreading
above; the host reusing its socket across a webview reload, which starved the new page of the
daemon's `hello` (each page now gets its own connection, generation-counted); and Vite's watcher
crashing with `EBUSY` on Cargo's locked build scripts in `src-tauri/target` (now excluded).

**Completed 2026-09-26, and verified on a release build** (`tauri build`, assets served by Tauri,
driven through the native window, the tray and WebView2's DevTools protocol):

- **Tray and single-instance** (§4.3). Close hides to the tray and changes nothing; Quit sends
  `stop` and then exits, leaving `nexusd` running. A second launch exits (132 ms) and restores
  the first window from the tray.
- **R1 on real window visibility.** Hidden or minimised, the page drops its link: no frame
  arrives while hidden, and a fresh `hello` on return proves a new connection. The daemon keeps
  counting.
- **Reconnection.** Killing `nexusd` under the app and starting it again: the page was linked
  1.4 s later, on its own backoff. A reload relinks immediately.
- **Native HTTP for subscription URLs** through the Tauri HTTP plugin, in the host: success,
  redirect, 404, empty body, refused, DNS failure, connect timeout (15 s), a server that never
  answers (30 s), silence after the headers (15 s), a 20 s download that never goes 15 s silent
  (succeeds), malformed links,
  expired and untrusted certificates (both refused by the TLS stack), and the page unable to
  turn validation off. The panel sees `User-Agent: Nexus/0.1 (sing-box)`.
- **A Content-Security-Policy** with no remote origin: zero violations and zero console errors
  across the whole UI; a remote fetch, a remote image and an inline script each blocked.
- **Device network status from the OS** (`src-tauri/src/network.rs`): NCSI through WinRT,
  hardware adapters only — this host's reading of `HardwareInterface` matched `Get-NetAdapter`
  on all 11 adapters of the test machine. It does not touch the daemon protocol, so §4.2 holds.
- **Icons** from `branding/icon-full.svg`.

**Found while testing, not fixed (outside Phase 4):** `ipc.Listen` removes the socket path
unconditionally before binding, so a second `nexusd serve` on the same path *succeeds* and
orphans the first — still serving its old connections, unreachable by path. The comment there
expects the bind to conflict; it cannot, once the path is gone. Reproduced on Windows. The fix
is small (dial first; remove only a path nobody answers on) and matters before Phase 5, when a
manual `nexusd serve` could steal a running service's socket.

**Routing: VPN or Direct (desktop only, 2026-09-26).** Two user-facing choices: VPN (LAN still
direct) and Direct. An unreleased three-mode design with user-maintained lists was replaced by
this before any release; nothing of its list machinery remains. Both modes are compiled into
the config as `clash_mode` rules at connect, and nexusd switches live with the core's own
`ClashServer.SetMode`, so a switch never tears the tunnel down. This implemented two methods the
contract already declared, `setClashMode` and `closeConnections`, and its `clashMode` event; the
status snapshot gained `clashMode` / `clashModes` for reconciliation. Additive, so still
protocol 1 (see protocol.go). The daemon re-applies the config's `default_mode` after start:
sing-box restores the mode saved in cache.db over it, shown by an A/B test in desktop/tunnel.
One DNS rule applies in Direct mode only — non-address queries go to the local resolver —
because their default server is pinned to the proxy; the A/B that proved it is in the same
test file. ConfigGuard is unchanged — no listener is involved.

**Found while testing, not fixed (outside this feature):** when a `start` replaces a running
tunnel and the new config is refused (by the guard, or when sing-box cannot build it), the
daemon broadcasts `stopped` while the previous tunnel keeps running — observed on the wire as
`state: stopped` alongside the old tunnel's start time and routing mode. A server switch to a
node whose config fails would show "Connection failed" with the old tunnel still up. The fix
belongs in `ipc.Server.start`: report the running tunnel's real state when the replacement is
refused before the swap.

**Still open:** the Phase 4 exit test itself (connect/disconnect end to end from the real UI
needs a TUN: Linux, or an elevated daemon). Bundling `nexusd` as `externalBin` is done for
Windows, with an app-managed elevation that stands in for Phase 6's service: §6.4.

### 6.4 Windows 1.3.1: the daemon in the installer (2026-09-27, before Phase 6)

§3.1's target is unchanged — an SCM service, a named pipe with an SDDL ACL, one UAC prompt at
install. This is what ships until it exists, built from what Phases 2–4 already have:

- **Bundled.** `nexusd.exe` is the app's `externalBin` (Windows only:
  `clients/desktop/src-tauri/tauri.windows.conf.json`), built by `core/scripts/build-desktop.sh`
  unchanged — all five tags. `clients/desktop/scripts/build-nexusd.mjs` refuses a binary that
  `go version -m` does not show with every tag, that links sing-tun's gVisor stub, whose
  `nexusd check` rejects a config needing clash_api, uTLS, QUIC and WireGuard, or that reports
  another version.
- **Run by the app** (`src-tauri/src/daemon.rs`): unelevated at launch, on a socket per app
  instance (`%TEMP%\nexusd-<pid>.sock`); on the session's first Connect it is replaced — killed,
  so its graceful socket removal cannot race the successor — by the same binary elevated
  through `ShellExecuteEx("runas")`. The host never runs elevated.
- **Bounded by the app.** New flag `nexusd serve -parent <pid>`: a SYNCHRONIZE handle on the
  app, and the app's exit — any exit — takes the signal path: stop the tunnel, remove the
  socket, exit. This is what makes a crashed or killed GUI unable to strand a tunnel, which
  §4.3's Quit-sends-stop alone could not.
- **Written where users cannot.** The per-machine NSIS installer puts the elevated binary in
  Program Files, and the elevated daemon's working and guard state directory in
  `<install dir>\state`, created by the installer with Program Files' permissions. The guard's
  path check assumes a state dir only the privileged side can write (guard.go, checkPaths); a
  directory under the user's profile would let an unprivileged process plant a link that
  redirects an administrator's write.
- **Protocol unchanged** — v1, same methods and events. The host gained two page-facing
  commands (`nexus_daemon_status`, `nexus_elevate`), outside the daemon contract (§4.2).
- **UI:** the prompt waits as long as the user does, so it is kept out of the 10 s startup
  watchdog: `start()` rejects with `awaitingApproval` (clients/shared plugin.ts) and
  `useNexusCore` stays "connecting" with "Approve the Windows prompt…", cancellable. Declined
  is a `stopped` without a reason — Disconnected, as a declined consent dialog is on Android.
  Nothing reports Connected unless nexusd started a tunnel and said so.

**Verified 2026-09-27, without a UAC answer:** `-parent` by four Go tests, including `serve`
exiting and removing its socket when its parent ends (A/B: without the new `select` case that
test fails, "serve still running 10 s after its parent exited"); the tag proofs by A/B builds,
each missing one tag — all five caught; on the release exe, the unelevated daemon started as
the app's child with the expected arguments, Ping through it from the UI (2 ms to a local
listener), a second launch exiting in 88 ms with no second daemon, the daemon gone ~250 ms after
the app was killed and its socket removed, and tray close / restore / Quit with nothing left
running; `ShellExecuteEx` with `SW_HIDE` — `nexus_elevate`'s call, with the "open" verb —
showing no window on Windows 11 23H2 with Windows Terminal installed; `nexusctl verify` 20/20
against the bundled daemon.

**Not yet verified** — each step needs someone to answer a UAC prompt: installing; the
elevated path end to end (approve, TUN, traffic, DNS, Direct, live switching, disconnect,
reconnect, Quit with a tunnel up); declining the prompt; the elevated daemon's `-parent` exit;
installing over a running daemon; uninstalling.

**Traffic statistics (fixed 2026-09-27, still 1.3.1).** The Windows UI read "— MB/s" and
"Total: unavailable" over a working tunnel because `ipc.Server.status` hard-coded
`trafficAvailable: false` (§6.2's "known gap"). Its premise was wrong for sing-box 1.14: box.New
registers `trafficcontrol.Manager` in the service context (box.go, `service.MustRegisterPtr`) —
where the clash API and sing-box's own daemon get it — and `desktop/tunnel` already keeps that
context. `Tunnel.Traffic` reads `Manager.Total()`; the status tick turns totals into bytes per
second as sing-box's status stream does, over the time actually elapsed. No protocol change:
the fields existed. Totals are per connection — a reconnect or server switch is a new sing-box
instance and counts from zero; VPN ↔ Direct is the same instance and keeps counting. With no
tunnel the daemon reports a known zero, as Android shows while disconnected. A/B: with the
counters unread, `TestTrafficOverTheWire` fails with the reported state (`started`,
`trafficAvailable: false`, all zeros).

**UAC once per app session, as designed.** The only path to the prompt is a Connect when the
app holds no live elevated daemon. In the one session with complete evidence, the elevated
daemon started at the first Connect outlived Disconnect and stayed the one the app talks to; a
second elevated lifetime in the same test window followed an app restart (no crash recorded).

**Limits of the interim:** one UAC prompt per app session. A standard user elevating with an
administrator's password runs the daemon as that administrator, whose handle on the user's app
may be refused — the daemon then exits at once and the connect fails visibly (untested). A
custom install directory that users can write into loses the Program Files protections.
Nothing is code-signed. Two users connected at once on one PC would share `<install dir>\state`.
Windows builds only the NSIS installer — the state directory and the running-daemon handling
are NSIS hooks, and an MSI without them would ship an elevation that cannot start.

---

## 7. Open questions

1. **Wails v3's release maturity** — if it is genuinely stable, the "no Rust" argument is
   strong enough to reopen §2. Nothing else in this ADR changes if it does.
2. **`stack` on desktop.** `gvisor` was chosen on Android for a reason that does not apply
   here, and its CPU cost is still unmeasured on either platform (`bench/B-04` exists, results
   table deliberately empty). Phase 10 decides; until then, no claim.
3. **Apple Developer Program enrolment** is a hard external dependency for macOS and the only
   item here that cannot be solved with code.
4. **`systemd-resolved` DNS takeover** is the most likely source of distro-specific breakage
   and is not yet designed.
5. **Auto-start / connect-on-boot.** Android deliberately chose "leave dead, no UI" after a
   reboot. Desktop users expect the opposite. Decide before phase 5 — it changes the service
   unit.
6. **Update channel.** The GUI and the daemon can be updated independently, especially on
   Linux. §4.2's protocol version makes the mismatch *visible*; it does not make it *rare*.

---

## 8. What this ADR changes elsewhere

- **ADR-0002** decided React + Capacitor "for Android and iOS". Desktop adds a third shell
  behind the same contract. Its §2 (config generation belongs in Go) moves from aspiration to
  partially implemented — in the daemon, for desktop only.
- **`core/docs/ipc-boundary.md`** gains a desktop section: two hops, no `CommandServer`, R1
  rebased from "app backgrounded" to "window hidden".
- **`CONTRIBUTING.md`** gains the workspace layout and the rule that `clients/shared` must not
  import from any shell.
