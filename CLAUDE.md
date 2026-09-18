# Nexus — working agreements

## Domain
VPN/proxy client. Go-based proxy core (sing-box) embedded as a native library, driven by
platform tunnel services (Android `VpnService`, Apple `NEPacketTunnelProvider`).

## Hard constraints
- **Apple `NEPacketTunnelProvider` memory ceiling is ~50 MB for the whole extension process**,
  Go runtime included. Anything that allocates per-packet on the hot path is a bug.
- **Android Doze / power-save** transitions must quiesce the core, not just survive it.
- Idle power draw is the primary metric. See ADR-0001 for why.

## Rules
- Never quote a performance/battery figure that is not backed by a run in `bench/`.
  Cite the run. If a number is an estimate, say "estimate" in the same sentence.
- Core-specific types stay behind `core/` interfaces. The UI talks to our abstraction only.
- Core version bumps are a reviewed change: upstream perf regressions are the main
  threat to the product thesis.
