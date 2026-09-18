# nexus-core

The Nexus façade over sing-box's `libbox`, built by gomobile into an Android AAR and an Apple
XCFramework.

Implements [ADR-0001](../docs/adr/ADR-0001-core-engine-selection.md). Read
[docs/ipc-boundary.md](docs/ipc-boundary.md) before touching anything that talks to the UI.

## Layout

```
core/
├── go.mod                    pinned sing-box 1.14.x — bumps are a reviewed change
├── nexuscore/
│   ├── nexuscore.go          gomobile-bound package API: Setup, Version
│   ├── service.go            Service — wraps libbox's service object, owns lifecycle
│   ├── power.go              PowerController + wakeup coalescer  ← the product thesis
│   └── runtime.go            GOMEMLIMIT / GC policy
├── scripts/
│   ├── build-android.sh      gomobile bind → nexus.aar
│   ├── build-apple.sh        gomobile bind → Nexus.xcframework
│   └── verify-api.sh         fails loudly when the pinned libbox API moves
└── docs/ipc-boundary.md      Capacitor ↔ core contract
```

## What this module is and is not

**Is:** the power policy, the memory policy, and a narrow lifecycle API. These are identical on
Android and iOS, so they are written once in Go rather than twice in Kotlin and Swift where the
copies drift.

**Is not:** an implementation of `libbox.PlatformInterface`. That interface exists to be
implemented *natively* — its job is to return a TUN file descriptor, resolve package names by
UID, read WiFi state and post notifications, all of which are platform calls. Kotlin implements
`io.nekohasekai.libbox.PlatformInterface`; Swift implements `LibboxPlatformInterface`; both get
passed into `nexuscore.NewService` as a parameter. Writing a Go implementation of it would be
building a bridge to nowhere.

## The central design decision

`PowerController` splits the platform's power signals into three states, because libbox's
`Pause()` internally calls `ResetNetwork()` and tears down every TCP
connection ([SagerNet/sing-box#3400](https://github.com/SagerNet/sing-box/issues/3400)).

| State | Trigger | What happens |
|---|---|---|
| Active | screen on | everything runs |
| **Idle** | screen off + 30 s grace | **pollers stop, memory released, tunnel untouched** |
| Suspended | Doze / extension sleep | `Pause()` — connections torn down |

Screen-off is not pause. A glance at a notification must not cost a full reconnect handshake,
because a reconnect promotes the radio and the radio is the battery. The cheap half of the work
— stopping the pollers — is where most of the win is anyway.

All periodic work goes through the `coalescer`: one ticker for the whole process, so N periodic
jobs cause one radio wakeup per period instead of N at unrelated phases.

## Build

Requires Go 1.25+, gomobile, and the platform SDKs.

```bash
go install golang.org/x/mobile/cmd/gomobile@latest
gomobile init
./scripts/build-android.sh
```

Both `libbox` and `nexuscore` are passed to a single `gomobile bind` invocation. They must be
bound together: a bound function may only take parameters whose types come from bound packages,
and `NewService` takes a `libbox.PlatformInterface`.

### gomobile type restrictions

Every exported signature in `nexuscore` is constrained to what gomobile can bind: `bool`,
`int`/`int32`/`int64`, `float32`/`float64`, `string`, `[]byte`, `error`, and named types or
interfaces declared in a bound package. No maps, no slices of structs, no `time.Duration`, no
variadics, no channels. This is why `Service.PowerState()` returns `int32` rather than the
`PowerState` type, and why anything list-shaped crosses as an iterator or as JSON in a string.

## API drift — resolved for 1.14

The first `verify-api.sh` run against the 1.14 pin found exactly what this section predicted,
in exactly the two places it predicted:

1. **`SetupOptions` changed shape.** 1.14 drops `Username`/`IsTVOS` and adds
   `CommandServerListenPort`, `CommandServerSecret`, `LogMaxLines`, `Debug`,
   `CrashReportSource`, `AppVersion`, `AppMarketingVersion`, the three OOM-killer fields and
   `PowerReportEnabled`. `nexuscore.go` is written against the real struct now.
2. **The service lifecycle was restructured — not merely renamed.** `libbox.BoxService` and
   `libbox.NewService` are both *gone*. The lifecycle moved onto **`CommandServer`**, which
   wraps `daemon.StartedService` (the same type `NewOOMReporter(*daemon.StartedService)`
   takes). Config is no longer a constructor argument: you build a `CommandServer` from the
   `PlatformInterface`, `Start()` it, then `StartOrReloadService(configContent, options)`.

Two things follow from (2).

**Reload became first-class.** Under `BoxService` a config change meant destroying and
rebuilding everything. Now the server outlives the config, so a reload keeps the command socket
and the UI's status stream up. `Service.Reload()` uses this.

**The command server is no longer optional.** It used to be just the UI's status channel, which
we could in principle have started on demand — that was an open question in
`docs/ipc-boundary.md`. It now owns the tunnel, so it runs as long as the tunnel does. Question
closed by the API rather than by measurement.

### Why the blast radius stayed small

`power.go` needed **no code change at all** across a change that deleted the type it drives. It
declares a `pauser` interface listing the methods it uses and never names a libbox type, so
when `BoxService` vanished and `CommandServer` took over, the policy code did not care. That
technique is the reason this rewrite touched two files instead of the whole tree, and it is why
Kotlin and Swift saw nothing.

Drift is now confined to `nexuscore.go`'s `SetupOptions` literal and `service.go`'s
`CommandServerHandler` implementation. A changed *method* still breaks the build — correctly —
with an error naming the exact method.

### Still unconfirmed

`ResetNetwork()` and `UpdateWIFIState()` were `BoxService` methods in 1.12. Whether they
survived onto `CommandServer` is unknown, so both are handled by optional type assertion: if
absent, the feature degrades (connections are not torn down on a network change; SSID routing
rules do not refresh) rather than failing the build. `scripts/dump-api.sh` section 8 answers
it — fold them back in unconditionally once confirmed. A silent no-op is a stopgap, not a
resting state.

### Two settings worth understanding before changing them

**OOM killer is off.** libbox can self-terminate above `OomMemoryLimit`, which sounds useful
against Apple's ~50 MB ceiling. It is not: a self-kill drops the tunnel exactly as hard as the
OS kill it pre-empts. `GOMEMLIMIT` (runtime.go) applies GC backpressure instead of killing.
Revisit only if a B-03 run shows we cross the cap anyway.

**`PowerReportEnabled` is off, pending investigation.** New in 1.14, and the name is tantalising
for a project whose primary metric is battery. But we do not know whether it *reports* power
usage (a gift for B-01) or *subscribes to* platform power callbacks (an extra wakeup source —
the opposite of what we want). Read the upstream implementation, then decide, then measure. Do
not enable it because it sounds on-topic.

## Build tags

sing-box gates protocols behind build tags. The set below covers the ADR-0001 §3.1 protocol
matrix; **verify against the pinned tag's `Makefile`**, since the tag list moves between
releases:

```
with_gvisor,with_quic,with_wireguard,with_utls,with_ech,with_clash_api
```

- `with_gvisor` — required to compile the `tun` package at all, including for the `system`
  stack we default to (ADR-0001 §5.4).
- `with_quic` — Hysteria2 and TUIC.
- `with_utls` — REALITY and TLS fingerprinting.
- `with_clash_api` — the traffic statistics the command server serves to the UI.

Do not add tags speculatively. Each one is code in the binary and, on Apple, bytes against the
50 MB ceiling.
