# Nexus benchmark harness

Every performance or battery claim in this repo must cite a run recorded here.
[ADR-0001 §7](../docs/adr/ADR-0001-core-engine-selection.md) explains why: the core selection
rests on documented behaviour and radio physics, **not** on measured head-to-head data, because
no public head-to-head battery data exists. This directory is how we close that gap.

## B-01 — Idle drain (the product metric)

The one that decides whether the thesis is true.

- **Setup:** screen off, airplane-mode-off, cellular only (Wi-Fi materially changes the radio
  term), no foreground traffic, 8 h soak, ≥3 repeats per arm, same physical device per arm.
- **Arms:**
  1. No VPN (floor)
  2. Nexus — VLESS/REALITY over TCP, policy layer on
  3. Nexus — Hysteria2, policy layer on
  4. Nexus — Hysteria2, policy layer **off** (isolates the policy layer's contribution)
  5. sing-box stock client, same server
  6. NPV Tunnel, same server class
- **Instrumentation:** Android `batterystats` / Battery Historian for wakeup counts, wakelock
  time, and mobile-radio active time; iOS via a sysdiagnose power log.
- **Report:** mAh/h *and* wakeups/h. Wakeup count is the leading indicator — it moves before
  mAh does and it is what we can actually optimise against.

## B-02 — Wake-cost of pause policy

Measures ADR-0001 §5.2 / open question 6.2. Reconnect handshakes per day under a realistic
screen-on/off duty cycle, comparing sing-box's default "reset all TCP on pause" against a
quiesce-only patch.

## B-03 — Memory ceiling compliance

Peak RSS of the Apple Network Extension process under a 1 h mixed-traffic soak, across
`GOMEMLIMIT` settings. Must stay under the ~50 MB `NEPacketTunnelProvider` ceiling with
headroom. Record GC cycle frequency alongside — ADR-0001 §5.3 is a trade, and we need both
numbers to make it.

## B-04 — TUN stack CPU

CPU-seconds per GB transferred: `system` vs `mixed` vs `gvisor`, Android and desktop.
Validates the §5.4 policy.

## B-05 — Throughput parity

Not a differentiator, but a regression gate — we must not lose throughput while winning power.
Run on every core version bump.

## Conventions

- One directory per run: `runs/<date>-<bench-id>-<arm>/` containing raw capture, the exact
  config used, device/OS/core versions, and `result.md`.
- Never report a mean without the spread and the repeat count.
- A run with a changed device, OS version or core version is a **new** run, not a repeat.
