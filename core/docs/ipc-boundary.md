# The IPC boundary: Capacitor WebView ↔ sing-box core

Implements ADR-0001 §5.5. This document is the contract; violating it is how the 50 MB
extension budget gets blown and how the "idle" state stops being idle.

## 1. The constraint nobody designs around until it bites

**On iOS the core does not run in your app.** It runs in a separate process — the
`NEPacketTunnelProvider` app extension — with its own ~50 MB ceiling. The Capacitor WebView
runs in the app process. They share no memory. Every byte that moves between them is
serialised, copied, and paid for twice.

Android is more forgiving (the `VpnService` can share the app process), but we deliberately
**adopt the iOS topology on both platforms**. A design that only works where the constraints
are loose is a design that will be rewritten.

## 2. Topology

```
┌─ app process ────────────────────────────────┐   ┌─ tunnel process ──────────────────┐
│                                              │   │                                   │
│  React + TS + Tailwind (WebView)             │   │  nexuscore.Service                │
│            ▲                                 │   │    └── libbox service object      │
│            │  ① Capacitor bridge             │   │    └── PowerController            │
│            │     (JSON, main thread)         │   │                                   │
│            ▼                                 │   │  libbox.CommandServer             │
│  NexusPlugin  (Kotlin / Swift)               │   │    (gRPC)                         │
│            ▲                                 │   │           ▲                       │
│            │  ② libbox.CommandClient         │   │           │                       │
│            └───────────────────────────────────────────────┘ │                       │
│                 Android: unix socket           │   │                                 │
│                   {BasePath}/command.sock      │   │  PlatformInterface (native)     │
│                 Apple:   XPC, App Group        │   │    OpenTun, FindConnectionOwner │
│                                                │   │    ReadWIFIState, ...           │
└────────────────────────────────────────────────┘   └───────────────────────────────────┘
```

Three hops, each with a different cost profile:

| Hop | Transport | Cost | Rule |
|---|---|---|---|
| ① JS ↔ native plugin | Capacitor bridge, JSON over the WebView boundary, **main thread** | High per message. Blocks UI. | Low frequency, small payloads. Never a per-packet or per-connection stream. |
| ② native ↔ core | libbox `CommandClient` → gRPC over unix socket (Android) or XPC (Apple) | Moderate. Off the main thread. | Fine for 1 Hz status. Still not free — see §4. |
| ③ core internals | in-process | Free | — |

**JS never speaks to the core.** There is no HTTP listener, no localhost port, no websocket
into the tunnel process. On Android a localhost TCP listener is reachable by every other app
on the device; the unix socket under `BasePath` is not. `CommandServerListenPort: 0` in
`nexuscore.Setup` enforces this — do not change it for convenience.

## 3. Why libbox's own command system, rather than our own gRPC service

sing-box 1.14 already ships exactly the thing we would otherwise build: `CommandServer` in the
core process, `CommandClient` in the host, gRPC between them, authenticated with a shared
secret in an `x-command-secret` header, transported over a unix socket / XPC rather than a
network port. It covers status, logs, outbound groups, URLTest, Clash mode, connection lists
and service reload.

Building a parallel channel would mean a second serialisation path, a second set of buffers
inside the extension's memory budget, and a second thing to keep in sync across core upgrades.
We use theirs. Our own surface is the small lifecycle API on `nexuscore.Service`, which native
calls directly through the gomobile binding — no IPC needed, because on both platforms the
plugin code and the core share a process boundary only on iOS, where lifecycle signals are
forwarded over the same command channel.

## 3b. The stream map — what we subscribe to, and what it costs

`CommandClientOptions.addCommand(int)` (1.14; replaced the single `command` field) lets one
client carry N streams. Confirmed constants from the AAR:

| constant | value | subscribed? | why |
|---|---|---|---|
| `CommandLog` | 0 | on demand | Open only while the Logs screen is mounted (`setLogStreaming`). Never at app start. |
| `CommandStatus` | 1 | **yes**, 1 Hz | The only continuous stream. Throttled in the core via `statusInterval`, deduped in the plugin, disconnected while backgrounded. |
| `CommandGroup` | 2 | on demand | Only while a server-selection screen is mounted. |
| `CommandConnections` | 4 | on demand | R2. Unbounded — thousands of records on a busy device. Debug screens only, unsubscribed on unmount. |
| `CommandOutbounds` | 5 | on demand | Scales with outbound count; a large subscription is a sizeable per-tick payload. |
| `CommandClashMode` | 3 | on demand | Cheap, but no reason to hold it open. |

The rule this table encodes: **exactly one stream is open in the steady state.** Everything else
is opened by a mounted screen and closed when it unmounts. Adding a second always-on stream is a
decision to be argued for in a PR, not a convenience.

## 4. The memory and battery rules

These exist because the obvious implementation of a live VPN dashboard is a wakeup generator.

**R1 — Status streaming stops when the UI is not visible.**
`CommandClientOptions.StatusInterval` at 1 s is fine with a dashboard on screen. With the app
backgrounded it is 86,400 wakeups a day to update a view nobody is looking at. The plugin
calls `Disconnect()` on every command client when the WebView backgrounds, and
`Service.SetUIForeground(false)`. This is the same policy as ADR-0001 §5.2, applied to the UI
channel instead of the network channel.

**R2 — Never subscribe to the connections stream by default.**
`CommandClientHandler.WriteConnections` is unbounded: it grows with the number of live
connections, and on a busy device that is thousands of records, serialised, crossing two
process boundaries, several times a second. Subscribe only while a debug/connections screen is
actually mounted, and unsubscribe on unmount. One `CommandClient` per subscription
(`CommandClientOptions.Command` selects the stream) so a screen can drop its own without
disturbing others.

**R3 — Logs are pulled, not pushed.**
`LogMaxLines: 512` caps the ring buffer inside the core process, which is inside the Apple
budget. The UI reads the buffer when a log screen opens. A live log tail is a debug-build
feature, gated behind a developer flag.

**Implemented as a screen-scoped subscription.** `setLogStreaming(enabled)` opens a second
`CommandClient` with `addCommand(CommandLog)` when the Logs screen mounts and closes it on
unmount. This is consistent with R3 rather than an exception to it: the stream's lifetime is
bounded by a screen the user is actively looking at, and nothing streams across hop ① — lines
land in a bounded native ring and the UI fetches them with `readLogs()`.

Subscribing at app start instead would be a wakeup per log line, forever, to fill a buffer
nobody reads. That is the failure mode this shape avoids.

The log client uses its own handler (`LogHandler`), not the status handler: the status handler
emits `serviceState` on `connected()`/`disconnected()`, and a second client reporting those
would make the UI think the tunnel dropped every time the Logs screen closed.

**R4 — Nothing crosses hop ① at more than 1 Hz.**
Throughput counters, latency, connection counts: aggregate in the plugin, emit at most once a
second, as one message. Ten small messages cost far more than one batched message, because the
cost is dominated by the bridge crossing rather than the payload.

**R5 — The UI holds no unbounded history.**
Sparklines keep a fixed-size ring in JS. A WebView that accumulates an hour of per-second
samples is a memory leak with a chart on top.

## 5. Plugin API surface

The full contract between JS and native. Deliberately small — every addition is a new thing
that can be called at the wrong frequency.

```ts
export interface NexusCorePlugin {
  // lifecycle
  start(options: { config: string }): Promise<void>;
  stop(): Promise<void>;
  reload(options: { config: string }): Promise<void>;
  getState(): Promise<{ state: 'stopped' | 'starting' | 'started'; powerState: number }>;

  // control
  selectOutbound(options: { group: string; outbound: string }): Promise<void>;
  urlTest(options: { group: string }): Promise<void>;
  setClashMode(options: { mode: string }): Promise<void>;
  closeConnections(): Promise<void>;

  // subscriptions — every one of these MUST be torn down on unmount (R1, R2)
  addListener(e: 'status', cb: (s: StatusMessage) => void): Promise<PluginListenerHandle>;
  addListener(e: 'groups', cb: (g: OutboundGroup[]) => void): Promise<PluginListenerHandle>;
  addListener(e: 'serviceState', cb: (s: ServiceState) => void): Promise<PluginListenerHandle>;

  // pulled, never streamed (R3)
  readLogs(options: { limit?: number }): Promise<{ lines: string[] }>;
}
```

`start()` takes the config as a string and the plugin passes it straight to
`nexuscore.NewService`. The UI never parses or rewrites sing-box config JSON in JS — config
generation is a native/Go concern, so that a UI bug cannot produce a config that silently
disables the power policy (e.g. by reintroducing a `url-test` group with a 60 s interval).

## 6. Lifecycle wiring the plugin owns

| Platform signal | Plugin calls |
|---|---|
| `ACTION_SCREEN_ON` / `ACTION_SCREEN_OFF` (Android) | `Service.SetScreenOn(bool)` |
| `PowerManager.isDeviceIdleMode` change (Android Doze) | `Service.SetDeviceIdle(bool)` |
| `ConnectivityManager.NetworkCallback` onAvailable/onLost | `Service.NetworkChanged()` |
| `NEPacketTunnelProvider.sleep(completionHandler:)` | `Service.SetDeviceIdle(true)`, then complete |
| `NEPacketTunnelProvider.wake()` | `Service.SetDeviceIdle(false)` |
| WebView resume / pause | `Service.SetUIForeground(bool)` + connect/disconnect command clients |

iOS gives the extension no screen-state signal. `SetScreenOn` is forwarded from the app
process over the command channel when available and may simply never arrive — `PowerController`
is written so that the `SetDeviceIdle` path alone is correct. Do not add a code path that
assumes both signals exist.

## 7. Open

- ~~Whether the command server is cheap enough to leave running when no UI is attached, or
  should be started on demand.~~ **Closed by the 1.14 API.** `CommandServer` is no longer just
  the UI's status channel — it owns the service lifecycle (`StartOrReloadService`), so it runs
  for exactly as long as the tunnel does. There is nothing to start on demand. What remains
  measurable is the cost of the *client* connections, which R1 already governs.
- Apple XPC handshake cost across extension sleep/wake cycles — unknown, likely small,
  currently unmeasured.
