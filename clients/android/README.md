# Nexus Android client

Capacitor plugin + `VpnService` host for the sing-box core. Implements
[ADR-0001](../../docs/adr/ADR-0001-core-engine-selection.md) and
[ADR-0002](../../docs/adr/ADR-0002-frontend-stack.md); the IPC rules it obeys are in
[core/docs/ipc-boundary.md](../../core/docs/ipc-boundary.md).

## Files

| File | Role |
|---|---|
| `NexusVpnService.kt` | Tunnel service. Owns the Go `Service`, implements the VpnService half of `PlatformInterface`, registers `PowerReceiver`. Runs in `:core`. |
| `PlatformInterfaceWrapper.kt` | The rest of `libbox.PlatformInterface` + `DefaultNetworkMonitor`. |
| `PowerReceiver.kt` | Screen / Doze → `SetScreenOn` / `SetDeviceIdle`. No policy, no debounce — that is Go's job. |
| `ConfigGuard.kt` | Enforces `stack: system` and a health-check interval floor. Stopgap; belongs in Go. |
| `TunnelNotification.kt` | Persistent notification. State-only, never timer-updated. |
| `NexusPlugin.kt` | Capacitor plugin. App process. Owns hop ① and the status subscription lifecycle. |
| `BootReceiver.kt` | Opt-in auto-connect. |

## Process split

`NexusVpnService` declares `android:process=":core"`. The core and the WebView never share a
process — the same topology iOS forces on us, adopted here deliberately so an IPC bug cannot
hide on Android and surface only on Apple.

The consequence that matters: **`PowerReceiver` is registered by the service, inside `:core`.**
Screen events fire dozens of times a day; routing them through a binder transaction would mean
a wakeup per event, which is the cost we are trying to remove. In-process, the path is
broadcast → JNI → `PowerController`.

The one signal that does cross is UI foreground/background, because only the app process knows
it. Two events per app session, sent as a service intent.

## Three decisions worth not undoing

**1. `setBlocking(true)` on the TUN fd.** A non-blocking fd means the reader busy-polls or
wakes on a timer. Blocking means the thread parks and the CPU idles until a packet arrives. On
an idle tunnel — most of the day, per ADR-0001 §2.1 — that is the difference between zero
wakeups and a continuous stream.

**2. `protect(fd)` in `autoDetectInterfaceControl`.** Load-bearing for the `system` TUN stack:
the core opens real kernel sockets and our own default route would otherwise capture them. The
failure mode is a tunnel that establishes and passes zero traffic, which reads like a config
bug and is not one.

**3. The notification never shows live throughput.** Each update is a binder transaction plus
a SystemUI re-layout — a full wakeup, at 1 Hz, forever, to animate a number nobody is looking
at while the screen is off. Every competitor does this. It is invisible in a throughput
benchmark and very visible in `bench/B-01`.

## Building

Step-by-step pipeline from source to an APK on a device: **[BUILD.md](BUILD.md)**.

Note the plugin sources live here but are **copied into** the Capacitor app module at
`clients/web/android/app/src/main/java/io/nexus/plugin/` for the build. This directory is the
source of truth; that one is the build location. Keep them in sync by re-copying, or migrate to
a proper Gradle library module (`nexus-plugin/build.gradle.kts` is already written for it).

## Verified against the generated AAR

`javap` on the 1.14 AAR confirmed the bindings. Findings worth keeping:

**`PlatformInterface` grew from ~18 to ~27 methods.** Gained a shell/SSH-server family, a
Tailscale family, a bridge family and a neighbour monitor. **Lost** `packageNameByUid`,
`uidByPackageName`, `writeLog` and `systemCertificates`. `findConnectionOwner` now returns a
`ConnectionOwner` object rather than an int uid.

**`TunOptions.getDNSServerAddress()` changed from a single `StringBox` to a `StringIterator`,
and now declares `throws Exception`.** Kotlin has no checked exceptions, so single-value code
written against the old shape compiles fine and fails at *runtime*. `addDnsServers()` iterates
and guards.

**Call the getters explicitly; do not use Kotlin synthetic properties on `TunOptions`.** Kotlin
only decapitalises a Java getter when the char after `get` is uppercase and the next lowercase,
so `getMTU()` is `.MTU` (not `.mtu`) and `getHTTPProxyServer()` is `.HTTPProxyServer`. More than
half these getters are acronym-led, making property syntax a coin flip per member.

**Three defaults on `PlatformInterface` are load-bearing.** An IDE-generated skeleton, or any
"fill every method with a safe default so it compiles" pass, gets them wrong and yields an app
that builds, installs, reports Connected, and moves zero bytes:

| method | must be | if wrong |
|---|---|---|
| `usePlatformAutoDetectInterfaceControl()` | `true` | `protect(fd)` never runs; with the `system` stack the core's own sockets loop back into the tunnel. Zero traffic, no error. |
| `useProcFS()` | `false` | procfs scan per connection — continuous CPU, i.e. battery. |
| `openTun()` | build the `Builder` | no TUN device (this one at least fails loudly) |

They are marked LOAD-BEARING in `PlatformInterfaceWrapper.kt`. Re-apply them first if that file
is ever regenerated.

**The shell/SSH family is refused deliberately.** sing-box can act as an SSH server exposing a
shell. Acceptable on a server you administer; unacceptable attack surface in a consumer VPN
client, where a malicious subscription config would be the thing enabling it. Refusing at the
platform boundary means no config can switch it on.

**`tailscaleHostname()` confirms 1.14 vendors Tailscale** — which explains the dependency tree,
and means it is compiled into the AAR whether or not we use it. Relevant when reading B-03.

**`RoutePrefix` confirmed** — `address(): String`, `prefix(): int`, exactly as `addRoutes` and
`addAddress` assume. (`mask()` and `string()` also exist; unused.)

### Re-verifying after a core rebuild

```bash
./scripts/verify-aar.sh > /tmp/aar-api.txt
```

Dumps every generated type the Kotlin depends on in one pass, including our own
`io.nexus.nexuscore.*` bindings. Run it after every `build-android.sh` — gomobile regenerates
the Java API from Go on each build, so a Go-side change silently reshapes what Kotlin compiles
against.

### Command channel — confirmed

`CommandClientOptions` lost `command`/`isMainClient` and gained `addCommand(int)`.
`CommandClientHandler` renamed `writeConnections` → `writeConnectionEvents`, changed
`writeLogs` to take a `LogIterator`, dropped `openURL`, and added `setDefaultLogLevel` and
`writeOutbounds`. `StatusMessage` gained `trafficAvailable` — false means the core is not
producing counters at all, which the UI must not render as a genuinely idle 0.00 MB/s.

Constants (all `int`): `CommandLog=0`, `CommandStatus=1`, `CommandGroup=2`,
`CommandClashMode=3`, `CommandConnections=4`, `CommandOutbounds=5`. The subscription policy is
in [ipc-boundary.md §3b](../../core/docs/ipc-boundary.md).

### Still unverified

- `LogEntry.getLevel()`'s integer mapping. `levelName()` in NexusPlugin.kt assumes the
  conventional Go ordering (0=panic … 6=trace). If the Logs screen shows everything as one
  level, or the colours look inverted, that table is the thing to check.
- `TunOptions.getStrictRoute()` is unused. Our configs set `strict_route: true`; the core may
  apply it internally, but confirm the tunnel actually enforces it before relying on it.
- `TunOptions.getHTTPProxyMatchDomain()` cannot be honoured — Android's `ProxyInfo` has an
  exclusion list but no inclusion list. Logged as a warning rather than dropped silently.
- `ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED` eligibility: test on a device at the
  target API. The system throws if it disagrees.
- Play Console justification for `systemExempted` — write it before the first upload.

## Not yet built

- `ConfigGuard` equivalent for Apple — currently Android-only, which means the two clients can
  diverge on the single most important battery setting. Real task, not a TODO.
- Connections screen client (short-lived, `CommandConnections`, closed on unmount).
- Per-app routing UI.
- Always-on VPN / lockdown handling beyond the manifest flag.
