# B-03 — Memory ceiling compliance

Peak memory of the core under the Apple Network Extension runtime policy (ADR-0001 §5.3,
`core/nexuscore/runtime.go`: GOMEMLIMIT 40 MiB, GOGC 100), against Apple's ~50 MB
`NEPacketTunnelProvider` ceiling.

## Two stages

1. **Host proxy — runnable now, no device.** `core/nexuscore/b03_memory_test.go`
   (build tag `nexus_bench`). The core runs alone in a child process with the extension's
   `tuneRuntime(true)`; the parent drives traffic through its SOCKS inbound to a real Xray server
   on 127.0.0.1 and samples the child, so the load generator's buffers never count. CI runs it on
   macOS arm64 (`.github/workflows/ios-phase1.yml`).
2. **Device — needs an iPhone.** The same load inside the real packet-tunnel extension, measured
   with Instruments or the extension's own `os_proc_available_memory()` log. Only this stage
   answers the question; stage 1 decides whether it is worth building.

## What stage 1 is NOT

- **Not the extension.** No TUN and no packet stack (gVisor/system), whose buffers count against
  the real ceiling; no Swift, no NetworkExtension framework.
- **Not iOS.** RSS on the CI host is not iOS `phys_footprint`, and Windows working set (a dev run)
  is not either.
- So every stage-1 figure is an **estimate** and must be cited as "B-03 host proxy, <run>".
  "Go-held" (runtime metrics: mapped minus released) is the most portable of the numbers.

## Arms

| Arm | Outbound |
|---|---|
| `reality-mlkem` | VLESS + REALITY + Vision, ML-KEM key share on |
| `vlessenc-x25519` | VLESS Encryption, X25519 native 0-RTT, raw TCP |
| `reality-vlessenc` | REALITY + Vision + VLESS Encryption |

Load per cycle (env overrides in parentheses): idle 15 s (`B03_IDLE_S`); bulk 4 parallel
streams × 32 MiB echoed (`B03_BULK_STREAMS`, `B03_BULK_MIB`); burst of 300 connections × 16 KiB,
held 10 s (`B03_BURST_CONNS`, `B03_BURST_KIB`, `B03_BURST_HOLD_S`); idle 15 s. `B03_CYCLES`
repeats it (CI: 3). Samples every 250 ms.

## Run

```bash
cd core
B03_OUT=../bench/runs/<date>-B-03-<host> NEXUS_XRAY_BIN=<xray binary> \
  go test -count=1 -tags with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api,nexus_bench \
  -ldflags=-checklinkname=0 ./nexuscore/ -run '^TestB03Memory$' -v -timeout 0
```

Output: `result.md` (host, versions, load, one row per arm) and `samples-<arm>.csv`
(ms, phase, go_held, heap_live, gc_cycles, goroutines, rss).

## Results

**None recorded yet.** A Windows dev run on 2026-10-20 only proved the harness works (short load;
Windows working set) and is deliberately not listed.

| Date | Stage / host | Build | Arm | Peak RSS | Peak Go-held | Idle Go-held | GC/min (load) |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — |
