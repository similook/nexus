# ADR-0001 — Proxy core engine selection

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** Nexus architecture
- **Decision:** **sing-box** (SagerNet), embedded via its first-party `experimental/libbox` gomobile bindings, wrapped in a Nexus-owned power-policy layer.

---

## 1. Context

Nexus is a multi-platform client whose differentiating claim is battery life. The core engine choice constrains protocol coverage, memory-ceiling compliance on Apple platforms, and — most importantly — how much control we have over the two things that actually drain a phone battery: **radio wakeups** and **background CPU ticks**.

Candidates evaluated: sing-box, Xray-core, mihomo (Clash.Meta), v2ray-core (v2fly), plus the Rust field (shadowsocks-rust, clash-rs, meow-rs, leaf) and single-protocol cores (hysteria).

---

## 2. The battery model (read this before the comparison)

Most core comparisons benchmark throughput on a VPS. That is the wrong metric for us, and it is why the market leaders lose here. On a phone, energy is dominated by:

### 2.1 Radio state promotion — the single largest term

A cellular modem idles in a low-power RRC state. **Any** transmitted packet promotes it to a high-power state, which then holds for a ~5–20 s tail timer before demoting. A 15-second keepalive therefore keeps the radio in a high-power state approximately 100% of the time, even though it moves a handful of bytes. Screen-off idle drain is almost entirely this term.

Consequences that drive the decision:

- **QUIC-based protocols are structurally expensive at idle.** Hysteria2 and TUIC maintain connection liveness with periodic heartbeats (commonly recommended at 10–20 s for mobile, with `max_idle_timeout` 60–120 s). Public reports put Hysteria2 several percentage points per hour above a WireGuard baseline, with TUIC materially better than Hysteria2 but still carrying a persistent-UDP cost. These protocols are a *performance* feature for bad networks, never an idle default.
- **Health-check pollers are the hidden killer.** Clash-lineage `url-test` / `fallback` groups poll every node on an interval (300 s default). A 100-node subscription = 100 TLS handshakes every 5 minutes, screen off, forever. This — not the data path — is why Clash-based clients have the reputation they do.
- **TCP-based protocols with no application keepalive** (VLESS/REALITY, Trojan, Shadowsocks over TCP) can go genuinely silent at idle. A truly idle TCP proxy session costs ~0 mW.

### 2.2 Userspace TCP/IP stack cost

TUN-mode clients must terminate IP packets. Two strategies:

- **gVisor netstack** — full userspace TCP/IP reassembly. Portable, isolates the host stack, and burns CPU per packet. Documented to cause abnormal CPU usage under global routing (SagerNet/sing-box #3382).
- **system stack** — hand packets to the kernel via a local socket; kernel-grade throughput and far lower CPU per byte.

sing-box exposes `system`, `gvisor` and `mixed` (system TCP + gVisor UDP, the default). Being able to *choose* this per platform is a first-class battery lever. **Nexus policy: `system` on Android, `mixed` only where UDP behaviour requires it.**

### 2.3 Go runtime and GC

All serious cores are Go. The runtime's `sysmon` ticks continuously and the GC is a real background CPU term on a memory-capped process. This is a *shared* liability across sing-box, Xray, mihomo and v2ray — it does not differentiate them, but it does set our tuning obligations (§5.3). Rust cores avoid it and are still not viable (§3.5).

### 2.4 What this means

**The core choice determines the ceiling on battery efficiency; the policy layer we build on top determines whether we reach it.** No core ships a battery-optimal default configuration. We pick the core that gives us the most control hooks, then build the policy layer.

---

## 3. Comparison

### 3.1 Protocol support

| Protocol / transport | sing-box | Xray-core | mihomo | v2ray-core |
|---|---|---|---|---|
| VLESS | yes | yes (origin) | client | yes |
| REALITY | yes | **origin / reference impl** | client | no |
| XTLS Vision | yes | **origin** | partial | no |
| VMess | yes | yes | yes | yes |
| Trojan | yes | yes | yes | no |
| Shadowsocks (+2022) | yes | yes | yes | yes |
| ShadowsocksR | no | no | yes | no |
| Hysteria2 | **yes** | **no** | yes | no |
| TUIC v5 | **yes** | **no** | yes (v4+v5) | no |
| AnyTLS | **yes** | no | yes | no |
| ShadowTLS | yes | no | yes | no |
| WireGuard | yes (endpoint) | limited | yes | no |
| SSH / Tor / NaiveProxy | **yes** | no | partial | no |
| OpenVPN / OpenConnect / Snell | **yes (1.14)** | no | Snell only | no |
| gRPC / WS / HTTPUpgrade / H2 | yes | yes | yes | yes |
| **XHTTP** | **no** | **yes (exclusive)** | no | no |

**Verdict:** sing-box has the widest surface and is the only core covering the full modern set in one binary. Its one real gap is **XHTTP**, which is Xray-exclusive (true uplink/downlink separation — e.g. IPv6 CDN H3 up, IPv4 REALITY H2 down). See §5.6 for how we handle that.

Xray owns REALITY and XTLS Vision as the reference implementation, so Xray-originated features land there first and reach sing-box on a lag. v2ray-core is not deprecated but is feature-frozen relative to the other two — no REALITY, no QUIC-family protocols. **v2ray-core is eliminated on criterion 1.**

### 3.2 Battery and CPU

| Factor | sing-box | Xray-core | mihomo |
|---|---|---|---|
| TUN stack choice (`system`/`mixed`/`gvisor`) | **yes, explicit** | TUN support is recent/immature | yes (gVisor-derived) |
| Platform pause/wake hooks | **yes** — `PlatformInterface` surfaces device pause/wake; core quiesces and resets network state | no | no |
| Interface change / `auto_detect_interface` | yes | manual | yes |
| Default health-check polling | off unless configured | n/a | **on by default in `url-test` groups — worst-case battery profile** |
| DNS | optimistic cache, response-based matching, parallel evaluation (1.14) | basic | cache |
| Known CPU/memory pathologies | gVisor stack CPU (#3382); `process_name` routing rules CPU (#3934) — both avoidable by config | **XHTTP memory growth: ~1 GB unreleased, ~22.5k stale ESTABLISHED sockets after ~7 days (#5344, #5719)** | provider refresh + health-check churn |
| First-party mobile client maintained | **yes (SFA / SFI / SFM)** — the mobile power path has a maintainer | no (third-party clients) | no (third-party) |

**Verdict:** sing-box, decisively. The differentiator is not that its data path is faster — on a VPS these cores are within noise of each other. It is that **sing-box is the only core with a first-party mobile lifecycle contract.** Pause/wake hooks and stack selection are exactly the levers our power policy needs; on Xray or mihomo we would be building them ourselves against a core that has no concept of device idle.

Xray's XHTTP memory behaviour is disqualifying inside an Apple Network Extension regardless of anything else — see §3.3.

sing-box's pause/wake implementation currently tears down all TCP connections on power-save transitions (#3400). That is aggressive and costs reconnect handshakes on wake. It is also *a tunable we control*, which is the point: a hook with the wrong policy is fixable; a missing hook is not.

### 3.3 RAM footprint

The binding constraint is not the desktop. It is **Apple's `NEPacketTunnelProvider` memory ceiling — roughly 50 MB for the entire extension process**, Go runtime included; exceed it and the OS kills the tunnel. (Historical gomobile reports cite far tighter effective limits, ~15 MB on older iOS; treat 50 MB as an upper bound, not a budget.) A gomobile Go runtime starts around 13 MB before the core does any work.

- **sing-box** — designed around this constraint; the first-party iOS client ships within the cap.
- **Xray-core** — v26.2.6 (Feb 2026) reduced peak memory, but the XHTTP reports describe unbounded growth on long-lived connections. Inside a 50 MB extension that is a guaranteed kill, not a degradation.
- **mihomo** — offers a `memconservative` loader for constrained devices, but the rule-provider and geo-database working set is the heaviest of the three.

**Verdict:** sing-box. Note the trap in §5.3: the GC tuning required to fit the cap *costs* battery, so RAM and power are in tension and must be co-tuned.

### 3.4 Multi-platform integration

| | sing-box | Xray-core | mihomo |
|---|---|---|---|
| Official mobile binding | **`experimental/libbox`** — gomobile; AAR (`io.nekohasekai.libbox`) + Apple XCFramework | **`XTLS/libXray`** — gomobile or `c-shared`; good Swift/Kotlin/Dart FFI story | none official |
| Version coupling | binding lives in-tree, moves with the core | libXray is compatible only with the *latest* Xray release — forces us onto upstream's cadence | n/a |
| Remote-control API | **gRPC API service + dashboard (1.14)** | HTTP/gRPC stats API | RESTful API |
| Desktop | official Windows / macOS / Linux clients | CLI | CLI |

Both sing-box and Xray have credible FFI stories; libXray is genuinely good and explicitly targets Swift, Kotlin and Dart. sing-box wins on two counts: the binding is in-tree (so it cannot rot independently of the core), and the 1.14 gRPC API service lets our frontend talk to the core over a defined RPC boundary instead of a bespoke FFI surface.

mihomo has no official binding — every Clash client maintains its own. That is ongoing integration debt we will not take on.

### 3.5 The Rust field

shadowsocks-rust (one protocol), clash-rs and meow-rs (mihomo reimplementations, incomplete), leaf (effectively stalled). Rust would give us roughly **40–60% of Go's steady-state RSS** and no GC ticks — genuinely attractive against both the 50 MB cap and §2.3.

**Rejected anyway.** None covers REALITY + Hysteria2 + TUIC + AnyTLS + XTLS Vision at production quality. Criterion 1 is a hard gate: a core that cannot connect to the user's server is 0% efficient. Revisit when a Rust core reaches protocol parity; the RSS and GC arguments will still hold then.

---

## 4. Decision

**Adopt sing-box.** Embed via the in-tree `libbox` gomobile bindings. Pin to a specific stable release (currently the 1.14.x line; 1.15 is alpha) and treat version bumps as reviewed changes.

Rationale in one line: **sing-box is the only core that covers every modern protocol we need *and* exposes a mobile lifecycle contract we can build a power policy against.** Xray is the better censorship-research core and the worse client core; mihomo's defaults are actively hostile to battery; v2ray is feature-frozen; Rust is premature.

---

## 5. Consequences — the work that actually wins the battery benchmark

The core choice buys us the ceiling. These items are what beat the competition.

### 5.1 Idle-first protocol policy
- Default outbound: **VLESS + REALITY (+XTLS Vision)** or Trojan over TCP — no application keepalive, radio genuinely silent at idle.
- Hysteria2 / TUIC: offered as an explicit **"unstable network" mode**, never the default, with a visible battery-cost indicator in the UI.
- While on QUIC protocols, raise heartbeat interval and `max_idle_timeout` when the screen is off; restore on wake.

### 5.2 Aggressive lifecycle wiring
- Wire Android Doze / power-save and Apple extension sleep into the `PlatformInterface` pause/wake path.
- **Suspend all health-check and subscription-refresh timers while the screen is off.** Coalesce every periodic task onto one aligned wakeup — never N independent tickers.
- Revisit the "reset all TCP on pause" behaviour (#3400): prefer quiescing over tearing down when the network path is unchanged, to avoid paying reconnect handshakes on every wake.

### 5.3 The RAM/power tension — tune deliberately
A tight `GOMEMLIMIT` with low `GOGC` raises GC frequency (reported cycles as short as ~40 ms), a direct background-CPU and therefore battery cost. Set `GOMEMLIMIT` to survive the Apple cap (target ~40–45 MiB, leaving headroom), then buy headroom back by **reducing allocation on the packet path** rather than by turning the GC up. Measure both, in `bench/`.

### 5.4 TUN stack policy
`system` stack on Android by default; `mixed` only where UDP semantics demand it; never full `gvisor` in production. Avoid `process_name` / `find_process` routing rules (#3934).

### 5.5 Frontend boundary
The core runs in the platform tunnel process as a native library. UI talks to it over the gRPC/local-socket API — **never** through the JS/WebView layer. This keeps the frontend choice (Tauri v2 / Capacitor / React Native) a reversible decision and keeps UI work off the tunnel process's memory budget.

### 5.6 Accepted risks

| Risk | Mitigation |
|---|---|
| No XHTTP support | Accept for v1 — it is a server-side censorship-resistance transport, not a client battery feature. If demand appears, run Xray via libXray as a **secondary** outbound core behind the same Nexus interface rather than switching wholesale. |
| REALITY / Vision features land in Xray first | Track Xray releases; accept a lag on bleeding-edge transports. |
| Upstream performance regression | Pin versions; gate every bump on `bench/`. |
| Go runtime floor (~13 MB) | Accepted. Re-evaluate if a Rust core reaches protocol parity. |

---

## 6. Open questions

1. Measured idle drain — Nexus vs NPV vs stock sing-box, screen-off, 8 h, per protocol. **No public data exists for this; we must generate it.** (`bench/` work item.)
2. Real cost of pause/wake TCP teardown vs quiesce, in reconnect handshakes per day.
3. Whether the gRPC API service is cheap enough to leave running, or should be started on demand.

---

## 7. Note on evidence quality

Public, reproducible battery benchmarks comparing these cores **do not exist**. Everything in §2 is derived from documented behaviour (keepalive semantics, health-check defaults, stack architecture, published issues) plus the physics of the cellular radio state machine — not from measured head-to-head runs. The comparison is sound as an engineering argument and is sufficient to select a core. It is **not** sufficient to support a marketing claim. Before Nexus claims a battery advantage publicly, §6.1 must be measured.

---

## 8. Sources

- [sing-box changelog](https://sing-box.sagernet.org/changelog/) · [TUN inbound docs](https://sing-box.sagernet.org/configuration/inbound/tun/) · [Android client](https://sing-box.sagernet.org/clients/android/)
- [sing-box #3382 — gVisor CPU usage](https://github.com/SagerNet/sing-box/issues/3382) · [#3934 — process_name CPU](https://github.com/SagerNet/sing-box/issues/3934) · [#3400 — power-save TCP teardown](https://github.com/SagerNet/sing-box/issues/3400) · [#838 — comparison with xray-core](https://github.com/SagerNet/sing-box/issues/838)
- [Xray-core releases](https://github.com/XTLS/Xray-core/releases) · [v26.2.6](https://newreleases.io/project/github/XTLS/Xray-core/release/v26.2.6) · [XHTTP: Beyond REALITY (#4113)](https://github.com/XTLS/Xray-core/discussions/4113) · [#5344 XHTTP RAM](https://github.com/XTLS/Xray-core/issues/5344) · [#5719 XHTTP CPU/RAM](https://github.com/XTLS/Xray-core/discussions/5719)
- [XTLS/libXray](https://github.com/XTLS/libXray) · [libbox package docs](https://pkg.go.dev/github.com/tim06/sing-box/experimental/libbox)
- [mihomo releases](https://github.com/MetaCubeX/mihomo/releases) · [mihomo general config](https://wiki.metacubex.one/en/config/general/)
- [Hysteria2 full client config](https://v2.hysteria.network/docs/advanced/Full-Client-Config/) · [hysteria #1510 — idle/screen-lock drops](https://github.com/apernet/hysteria/issues/1510) · [Hysteria2 vs AmneziaWG battery/data](https://capvpn.net/blog/hysteria-2-vs-amneziawg-which-stealth-protocol-saves-more-data)
- [Apple forums — NEPacketTunnelProvider memory limits](https://developer.apple.com/forums/thread/106377) · [golang-nuts — iOS NetworkExtension memory limit](https://groups.google.com/g/golang-nuts/c/4OmowR7gjXc) · [golang/go #21489 — gomobile iOS memory](https://github.com/golang/go/issues/21489)
- [Go memory efficiency & GC](https://goperf.dev/01-common-patterns/gc/) · [GOGC / GOMEMLIMIT tuning](https://www.gofaq.org/en/how-to-tune-the-go-garbage-collector-gogc-gomemlimit/)
- [Core Tutorial — choosing a core](https://core-tutorial.argsment.com/compare/) · [sing-box vs Xray 2026 (VPNSmith)](https://www.vpnsmith.com/en/blog/sing-box-vs-xray-2026) · [sing-box vs Xray-core benchmarks (vpn.how)](https://vpn.how/en/pages/sing-box-vs-xray-core-in-2026-benchmarks-dpi-protocols-and-choosing-for-vps.html)
- [shadowsocks-rust](https://github.com/shadowsocks/shadowsocks-rust) · [mihomo-rust (meow-rs)](https://deepwiki.com/madeye/mihomo-rust)
