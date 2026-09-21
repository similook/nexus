# Nexus

[![Licence: GPL v3](https://img.shields.io/badge/Licence-GPLv3-blue.svg)](LICENSE)

**A battery-conscious anti-censorship client for Android, built on sing-box 1.14.**

Nexus is a universal client for reaching the open internet from a restricted network. It is not
built for any one country or any one filtering technique — it speaks the protocols people
already use, everywhere they are used, and the defences it implements (FakeIP, resolver-answer
validation, IPv6 fail-closed) are structural rather than tuned to a particular adversary.

It knows nothing about you, because there is nothing to know: no accounts, no sign-up, no
servers operated by this project, no analytics, no crash reporting. You bring your own server
or subscription, the credentials never leave the device, and there is no operator who could be
asked for data they do not have. See [Security and privacy](#security-and-privacy).

Most proxy clients are judged on throughput. Nexus is built around a different premise: on a
phone, the thing you actually notice is the battery, and the dominant cost is not moving bytes
— it is waking the cellular radio to move a few of them. Nexus is designed so an idle tunnel is
genuinely idle.

> **Status: v1.1.0.** Android only, `arm64-v8a` only. iOS is designed for but not built.
> See [Limitations](#limitations) before you install.

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
- **Prose tolerated.** Banners, adverts, `t.me` links, duplicates and surrounding text in any
  language or script are all filtered out; only the real URIs survive.
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
- **REALITY servers enforcing a minimum client version above `1.8.1`** need a server-side
  adjustment to interoperate with the pinned core. Resolved in testing; see below.

### REALITY compatibility

Nexus pins **sing-box v1.14.0**, whose REALITY client advertises client version **`1.8.1`**.
The value is a compile-time constant in the core, not something Nexus configures.

A REALITY server may enforce a **minimum client version**. Against a server whose minimum is
higher than `1.8.1`, the handshake is not accepted, and the REALITY implementation forwards
the client to its configured destination site instead of rejecting it outright. The client
then completes an ordinary TLS handshake with that site, receives its certificate rather than
a REALITY one, and reports `reality verification failed`.

That symptom is misleading, which is the main reason it is documented here: the address
resolves, TCP connects, the tunnel starts, and only the handshake check fails - so it reads
like bad credentials rather than a version policy.

**This was diagnosed and resolved during testing.** Lowering the server-side minimum client
version to `1.8.1` and **restarting the server-side REALITY service** resolved it - the
restart mattered, because saving the setting alone did not apply it to the running process.
An isolated sing-box v1.14.0 client then passed the REALITY handshake and reached the VLESS
layer, and the Android client connected and carried real traffic over a long continuous
session.

So this is a **client/server version compatibility constraint of the currently pinned
sing-box**, not a fault in REALITY and not a limitation of Nexus's REALITY support, which
works. A minimum client version is a legitimate server-side control; lowering it admits older
REALITY clients generally, so it is a deployment decision rather than a recommendation this
project makes. Updating the core to a sing-box release advertising a newer REALITY client
version is the way to retire the constraint - a reviewed change under `CLAUDE.md`, not yet
done.

---

## Changelog

### v1.3.0

Adds a device-network indicator, and nothing else. Validated on a physical device
(Samsung Android 16, arm64) against a live REALITY node.

- **New "Device network" card on the home screen.** Reports whether the *phone* has a working
  network, using only state Android already maintains: `NET_CAPABILITY_VALIDATED`,
  `NET_CAPABILITY_INTERNET`, captive-portal detection, and the transport type. It reads
  `Network OK`, `Network unverified`, `Sign-in required`, `No network`, or
  `Network status unavailable`, with `Wi-Fi` / `Mobile` / `Ethernet` alongside.
- **It is not a speed test, and deliberately shows no numbers.** No bandwidth estimate, no
  latency, no signal strength, no probe, no timer, no socket, and **no new permission** - the
  permission set is byte-identical to v1.2.0. Android's own bandwidth fields were considered
  and rejected: they report a theoretical first-hop link rate, not throughput, so putting them
  behind a threshold would show a confident number the app cannot stand behind.
- **It describes the underlying link, never the tunnel.** The callback is filtered with
  `NET_CAPABILITY_NOT_VPN`, so the card cannot report `tun0` back to the user, and it stays
  correct when a third-party VPN is active. `Network OK` means Android validated the *link* -
  it is not a claim that the proxy is reachable, and the wording avoids implying otherwise.
- **`Network unverified` is amber, not red, on purpose.** Android decides validation by probing
  a well-known endpoint; where that endpoint is blocked it can report failure while the
  connection works. Red is reserved for "no network at all".
- **Event-driven, registered only while the UI is visible.** It hooks the existing
  resume/pause lifecycle and deduplicates natively, so an unchanged reading costs nothing and
  a backgrounded app observes nothing. Measured at ~0.4% of one CPU core while backgrounded.
- Behaviour on Android 5.1-5.x is reported as `Network status unavailable` rather than guessed,
  since the validation capability only exists from API 23.

All v1.2.0 fixes are unchanged and were re-validated: connect, disconnect, reconnect, real
traffic, and background/resume with no transient connection error.

### v1.2.0

Connection reliability and branding. Every item below was verified on a physical device
(Android 16, arm64) against a live REALITY node unless noted.

- **Transient "Connection failed" on resume is gone.** The status stream is deliberately
  disconnected while the app is backgrounded - a backgrounded 1 Hz subscription is ~86,400
  wakeups a day - and gRPC's cancellation of that stream was being rendered as a connection
  error over a tunnel that never dropped. Only the client-initiated cancellation is filtered;
  `Unavailable`, `DeadlineExceeded`, `EOF`, permission and config-rejection errors all still
  surface. Observed 0 occurrences across 9 background/resume cycles, from ~90% before.
- **Server switching no longer deadlocks the core.** Switching now stops the tunnel fully,
  waits for the teardown to be confirmed, then starts the new one after a short cool-down,
  with a countdown shown while it waits. This removes the `initialize cache-file: timeout`
  that could leave a tunnel with no core behind it.
- **A failed connect can be cancelled.** The connect button stays live while connecting and
  aborts on tap, and a start that never completes now falls back on its own rather than
  leaving the UI stuck.
- **DNS: the proxy server's address no longer depends on a reachable resolver.** Addresses are
  resolved natively, checked against the poisoned-answer guard, and supplied to the core as
  pre-resolved data, so connecting does not require a working DNS path at connect time. The
  hostname is preserved for SNI, which matters for REALITY.
- **Fixed a generated-config error that prevented the core from starting.** A DNS server was
  emitted with a detour to an empty outbound, which sing-box rejects at start - not at parse,
  so config validation had accepted it.
- **Notification status-bar icon** is now the Nexus emblem instead of a generic shield glyph.
- **Quick Settings tile icon** is now the Nexus emblem.
- **Splash screen** uses the Nexus logo instead of the stock placeholder.
- **Servers tab header** no longer shifts its layout when connected.
- **REALITY compatibility** documented above.

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

**GNU General Public License v3.0** — the full text is in [LICENSE](LICENSE).

```
Nexus — a battery-conscious anti-censorship client
Copyright (C) 2026 the Nexus contributors

This program is free software: you can redistribute it and/or modify it under the terms of
the GNU General Public License as published by the Free Software Foundation, either version
3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program.
If not, see <https://www.gnu.org/licenses/>.
```

### Why GPLv3 and not something permissive

Not a preference — a requirement, and one worth understanding before you fork.

Nexus links [sing-box](https://github.com/SagerNet/sing-box), which is **GPL-3.0-or-later**.
Linking GPL code into an application makes the combined work a derivative, so the whole of
Nexus must be distributed under terms no more restrictive than the GPL. There was never a
permissive option available here.

It also suits the threat model. For a tool whose entire value rests on "it does not phone
home", copyleft is what keeps that checkable: anyone distributing a modified build has to
publish the modification too, so a binary that quietly added telemetry could not be handed
out as Nexus without the source that proves it.

**If you distribute a modified build**, GPLv3 requires you to make the corresponding source
available to the people you distribute it to, under the same licence, with your changes
stated. Building it privately for yourself carries no such obligation.

### Third-party components

| Component | Licence | Note |
|---|---|---|
| [sing-box](https://github.com/SagerNet/sing-box) | GPL-3.0-or-later (+ naming term) | The proxy core, embedded via gomobile |
| [Capacitor](https://capacitorjs.com/) | MIT | Native shell and plugin bridge |
| [React](https://react.dev/) | MIT | The UI |
| [jsQR](https://github.com/cozmo/jsQR) | Apache-2.0 | QR decoding |

sing-box carries an **additional term** under GPLv3 §7: no derivative work may use its name
or imply association with it without prior consent. Nexus names sing-box as a factual
statement of what it is built on, nothing more — **this project is not affiliated with,
endorsed by, or supported by SagerNet.** Fork accordingly.
