# ADR-0002 — Frontend stack

- **Status:** Accepted
- **Date:** 2026-09-13
- **Decision:** **React + TypeScript + Tailwind CSS**, delivered to Android and iOS via
  **Capacitor**.

## Context

ADR-0001 §5.5 put the core in the platform tunnel process behind an RPC boundary, which makes
the frontend choice reversible and therefore low-risk. UI generation and refinement is already
underway on this stack.

## Decision

React + TypeScript + Tailwind in a Capacitor shell. Native code is limited to a thin Capacitor
plugin (`NexusCorePlugin`, Kotlin + Swift) that owns the tunnel service, implements
`libbox.PlatformInterface`, and bridges to `nexuscore`.

## Consequences

1. **The WebView never touches the core.** The full contract is
   [core/docs/ipc-boundary.md](../../core/docs/ipc-boundary.md) — three hops, and hop ① (JS ↔
   native) is a main-thread JSON bridge that must stay under 1 Hz with small payloads.
2. **Config generation is native/Go, not JS.** The UI sends intent ("use this profile"), never
   a synthesised sing-box config. A UI bug must not be able to emit a config that silently
   disables the power policy — e.g. by reintroducing a `url-test` group with a short interval.
3. **The WebView is a battery surface too.** ADR-0001's wakeup discipline applies above the
   bridge as well: no animation loops, timers or polling while backgrounded; fixed-size rings
   for any charted history.
4. **Capacitor plugin owns lifecycle wiring.** Screen state, Doze, network change and
   extension sleep/wake map onto the four `nexuscore.Service` lifecycle calls
   (ipc-boundary.md §6).
5. **Accepted cost:** WebView memory and startup in the app process. Acceptable because it is
   in the *app* process — the ~50 MB ceiling applies to the extension, which the WebView never
   enters. This is the main reason the topology in ADR-0001 §5.5 is worth its complexity.

## Open

- Whether the plugin is hand-written or generated from the TS interface in ipc-boundary.md §5.
- Cold-start time budget for the WebView vs. tunnel-up time — users perceive "connect" latency
  as the app's speed, and the two are independent.
