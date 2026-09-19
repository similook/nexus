# Nexus

**A battery-conscious anti-censorship client for Android, built on sing-box 1.14.**

Most proxy clients are judged on throughput. Nexus is built around a different premise: on a
phone, the thing you actually notice is the battery, and the dominant cost is not moving bytes
— it is waking the cellular radio to move a few of them. Nexus is designed so an idle tunnel is
genuinely idle.

> **Status: v1.0.0, first public release.** Android only, `arm64-v8a` only. iOS is designed for
> but not built. See [Limitations](#limitations) before you install.

---

## Features

### Protocols

| Protocol | Transports | Security |
|---|---|---|
| **VLESS** | TCP, WebSocket, gRPC, HTTPUpgrade, HTTP masquerade | TLS, **REALITY**, XTLS Vision |
| **VMess** | TCP, WebSocket, gRPC, HTTPUpgrade | TLS |
| **Trojan** | TCP, WebSocket, gRPC | TLS |
| **Shadowsocks** | TCP | — |
| **Hysteria2** | QUIC | TLS |
| **TUIC** | QUIC | TLS |

Every one of these is checked on every build against sing-box's own validator — see
[Config validation](#config-validation).

### Import that works with real-world links

- **One field for everything.** Paste a subscription URL or config links into the same box; the
  app works out which it is. No mode switch, because classifying your own clipboard is work the
  machine can do.
- **Delimiter-free batch parsing.** Channel posts lose their newlines on the way through a web
  view, which glues links together: `…#Name1vmess://…#Name2`. Nexus splits these correctly by
  locating each `://` and walking back for the longest known scheme — `vless` wins over `ss` at
  the same colon, so a VLESS link is never mis-split into a bogus Shadowsocks one.
- **Prose tolerated.** Banners, Persian text, adverts, `t.me` links and duplicates are all
  filtered out; only the real URIs survive.
- **Base64 subscription bodies** pasted directly are decoded.
- **QR scanning** for single configs or subscription URLs.

### Measurement

- **Concurrent native TCP ping.** Tests every node in the list at once — 8 in parallel, 3s
  budget each — from a native socket, so a 30-node subscription resolves in a couple of
  seconds.
- **It does not disturb the tunnel.** The probes run in the app process, which is excluded from
  the VPN, so testing works whether or not you are connected and never interrupts an active
  session.
- **Live latency** for the selected node on the home screen, polled only while the app is in
  the foreground.
- **Real proxied latency** (`Live`) asks the core itself, which is the only test that proves
  your credentials work rather than just that the host answers.

### Getting at it quickly

- **Quick Settings tile.** Connect and disconnect from the notification shade without opening
  the app. It replays the last config you connected with — the tile cannot see the server
  highlighted in the app, because that lives in the WebView's storage.
- **Disconnect from the notification works with the app closed.** "Disconnect" on a VPN has to
  work when the UI has been killed, which is exactly when you are least able to do anything
  about it if it does not.
- **Your selection and your session survive.** The chosen server persists across a restart, and
  the connected timer keeps counting through a minimise rather than restarting from zero.

### Editing and sharing

- Per-node details showing address, port, protocol, transport, SNI, ALPN, security mode,
  fingerprint and REALITY parameters — read from the config the core will actually run, not
  from the link, so a parsing mistake is visible rather than hidden.
- Credentials masked until you ask for them.
- Edit remarks, address and port; share any node as a link or a QR code.

---

## Security and privacy

### DNS cannot be used to redirect you

Nexus answers every `A`/`AAAA` query locally from `198.18.0.0/15` (**FakeIP**) without looking
anything up. When an app connects to one of those addresses, the router maps it back to the
hostname and hands the **domain** to the proxy, so the server resolves it — on its network,
where the censor is not.

This is structural, not a filter: no app on the device ever holds a real IP for a hostname, so
a poisoned cache has nothing to poison. It replaced an earlier `sniff` + `resolve` approach that
looked correct in the logs and did nothing.

### Poisoned answers are rejected, not dialled

The proxy server's own hostname is the one lookup that has to happen before the tunnel exists.
Nexus resolves it with the system resolver — the only one reachable on these networks, after
DNS-over-HTTPS to Cloudflare was found to be reset by the ISP — and then checks the answer:

```
DNS returned a private (RFC1918) address for <host> (10.10.34.35).
That is not a reachable server — the local resolver is almost certainly being intercepted.
```

Loopback, wildcard, link-local, multicast and RFC1918 answers are all refused with that message.
Before this guard, the tunnel connected to the blackhole and every flow closed after ~200ms
having moved nothing, while the UI said "connected" the whole time.

### IPv6 cannot leak around the tunnel

The TUN interface claims both `172.19.0.1/30` and `fdfe:dcba:9876::1/126`, so `::/0` is routed
into the tunnel. If the proxy cannot carry IPv6, those connections **fail** rather than going
out over your real address. A connection that does not happen is a bug report; a connection that
silently bypasses the tunnel is a deanonymisation.

### Your credentials do not leave the device

`android:allowBackup="false"`, plus explicit exclusion rules for cloud backup **and**
device-to-device transfer. Your subscription URL and UUIDs are bearer credentials; with backup
enabled, `adb backup` extracts them with no root.

One thing is written to native storage: the **last config you actually connected with**, so the
Quick Settings tile can start it without opening the app. It lives in app-private
`SharedPreferences`, covered by the same `allowBackup="false"`, and it is replaced on each
successful connect rather than accumulating a history. Nothing else about your subscriptions
leaves the WebView's own storage.

### No telemetry

No analytics, no crash reporting, no phone-home. The app makes exactly three kinds of outbound
request: the tunnel itself, subscription fetches you asked for, and latency probes you asked
for.

There is a **promotional slot** in the source, disabled by default (`ENDPOINT = ''` in
`core/ads.ts`) and inert unless configured. If you build with it enabled, understand what it
discloses: the request leaves over your **real IP**, because the app is excluded from its own
VPN. That tells the ad host this address runs a circumvention client. It is documented in full
at the top of that file.

### Permissions

| Permission | Why |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | The tunnel, and detecting network changes |
| `FOREGROUND_SERVICE` (+ `SYSTEM_EXEMPTED`, `SPECIAL_USE`) | Android requires a foreground service for a VPN |
| `POST_NOTIFICATIONS` | The persistent status notification |
| `RECEIVE_BOOT_COMPLETED` | Reserved for always-on VPN |
| `CAMERA` | QR scanning **only**, requested on first use |

No storage, no location, no contacts, no phone state, no advertising ID.

---

## Install

1. Download `app-release.apk` from [Releases](../../releases/latest).
2. Check the device is `arm64-v8a` — nearly all phones from 2017 on are. A 32-bit device will
   install the APK and then fail on connect.
3. Android will warn about installing from an unknown source. Allow it for your browser or
   file manager.
4. Open Nexus → **Servers** → **Add Subscription**.
5. Paste your subscription link, or config links, or tap **Scan** for a QR code.
6. Tap a server to select it, go to **Home**, and press **Connect**.
7. Android shows its VPN consent dialog the first time. Accept it.

**Tip:** press **Test All** on the Servers tab before connecting. Nodes showing `n/a` are
unreachable from your network; pick one with a number.

### Verifying the download

```bash
sha256sum app-release.apk     # compare with the checksum in the release notes
apksigner verify --print-certs app-release.apk
```

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  React 18 + TypeScript + Tailwind            │  UI, import parsing, config assembly
│  (Capacitor WebView)                         │
└───────────────┬──────────────────────────────┘
                │  Capacitor bridge — one-shot calls, no polling
┌───────────────▼──────────────────────────────┐
│  Kotlin: NexusPlugin, NexusVpnService        │  VpnService, foreground service, power signals
│  ConfigGuard, PlatformInterfaceWrapper       │  Validates every config before the core sees it
└───────────────┬──────────────────────────────┘
                │  JNI (gomobile)
┌───────────────▼──────────────────────────────┐
│  sing-box 1.14 via libbox   (:core process)  │  Tunnel, routing, DNS
│  Go, arm64-v8a                               │
└──────────────────────────────────────────────┘
```

**The core runs in its own process.** Killing the UI cannot take the tunnel with it, and a Go
panic cannot take the UI down — which matters, because a panic across a JNI boundary aborts the
process and cannot be caught from Kotlin.

Some deliberate decisions worth knowing about:

- **gVisor TUN stack**, overriding [ADR-0001](docs/adr/ADR-0001-core-engine-selection.md) §5.4.
  The `system` stack carried UDP and silently dropped TCP on device — a browser sat there
  loading nothing while QUIC flowed. A stack that drops TCP is a broken tunnel, not a battery
  trade-off. **The CPU cost of this is not yet measured** — [`bench/B-04`](bench/B-04/) is the
  harness that will settle it, and `mixed` (kernel TCP, gVisor UDP) is the alternative it
  compares against.
- **Process-based routing rules are disabled** (ADR-0001 §5.4) — a documented per-connection CPU
  sink upstream.
- **No live throughput in the notification.** Updating it once a second is a binder transaction
  plus a SystemUI re-layout — a full wakeup, forever, to animate a number nobody is looking at
  while the screen is off.

### Config validation

Every link shape the app can produce is validated against **the same validator that runs on the
device** (`libbox.CheckConfig`), on a laptop, in under a second:

```bash
./core/scripts/check-configs.sh
```

Plus a layer for the rules sing-box accepts but a server rejects — `flow` without TLS, or `h2`
ALPN on a WebSocket node. Both of those shipped once and cost an evening each to trace from a
bare `EOF`.

```bash
cd clients/web
npm run check-parsers   # 13 exact-string assertions on the URI scanner
npm run typecheck
```

---

## Build

Requires Go 1.23+, gomobile, Android SDK 34, NDK, JDK 17.

```bash
# 1. Build the Go core into an AAR (arm64-v8a)
cd core && ./scripts/build-android.sh

# 2. Build the web UI and sync it into the Android project
cd ../clients/web && npm install && npm run build && npx cap sync android

# 3. Assemble
cd android && ./gradlew assembleRelease
```

Release signing reads `clients/web/android/keystore.properties`; see
`keystore.properties.example`. Without it, `assembleRelease` produces an **unsigned** APK — that
is deliberate, so a missing keystore fails loudly at install rather than silently producing a
debug-signed build that cannot be published.

---

## Limitations

Stated plainly, because finding these out after installing is worse:

- **Android only.** The Apple `NEPacketTunnelProvider` layer is designed but not implemented.
- **`arm64-v8a` only.** No 32-bit build.
- **`minSdk 22`** (Android 5.1), `targetSdk 34`.
- **v2ray `headerType` obfuscation** other than `http` (srtp, utp, wechat-video, dtls) has no
  sing-box equivalent; those nodes are refused at import with a reason rather than imported
  broken.
- **gVisor's CPU cost is not yet measured.** The battery thesis this project is built on is a
  design argument, not yet a benchmark result. The harness to settle it exists and is runnable
  ([`bench/B-04`](bench/B-04/)); the results table there is empty. No power figure is claimed
  anywhere in this repo that is not backed by a run in `bench/`, and right now there are none
  for the shipped stack.
- **No split tunnelling UI.** The per-app allow/deny plumbing exists in `NexusVpnService` but
  nothing exposes it.

---

## Changelog

### v1.1.0

- **Quick Settings tile.** Connect and disconnect from the notification shade without opening
  the app. It replays the last config you connected with — not the server currently highlighted
  in the app, which would mean writing credentials to native storage on every scroll.
- **Disconnect from the notification now works with the app closed.** The action was a
  `PendingIntent.getService`, and from Android 12 a service start from the shade with no live
  activity is refused as a background start. The tap did nothing, silently, with the tunnel
  still up. It is a broadcast to a receiver in the core process now, which nothing restricts.
- **Switching servers while connected no longer deadlocks.** The new core opened `cache.db`
  while the old one still held the bbolt flock and died on `initialize cache-file: timeout`,
  leaving a tunnel with no core behind it. The swap is serialised, tries a reload first, and
  falls back to a full restart.
- **Your selected server survives a restart.** Auto-selected nodes were never persisted, so a
  user who had never opened the Servers tab got a fresh lowest-ping pick every launch — which
  looked exactly like "it reset to the first server".
- **Release builds no longer log which server you connect to.** The lines naming the proxy
  host, SNI and transport are debug-only now; see [Security and privacy](#security-and-privacy).
  The in-app Logs tab is unchanged and still shows the core's own output.
- Servers tab count badge is centred.

### v1.0.0

First public release — [v1.0.0](https://github.com/similook/Nexus/releases/tag/v1.0.0).

---

## Contributing

Bug reports are welcome, especially with a filtered logcat — see
[the bug template](.github/ISSUE_TEMPLATE/bug_report.md). Please do not paste a real
subscription link or UUID into an issue; mask them.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## Licence

See [LICENSE](LICENSE).

Nexus embeds [sing-box](https://github.com/SagerNet/sing-box) by SagerNet.
