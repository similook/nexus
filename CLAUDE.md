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
  
## Change Policy — CRITICAL

### 1. Minimal changes only
- Never rewrite, restructure, or refactor the app to fix a bug unless explicitly required.
- Fix the smallest possible root cause.
- Do not modify unrelated files, architecture, APIs, or working features.
- Every changed file must have a direct reason related to the reported bug.

### 2. Protect working functionality
Treat these as protected unless evidence proves they are the cause:
- Native sing-box/core integration
- Android VpnService / tunnel lifecycle
- TUN/routing
- Working VLESS/Reality connections
- DNS behavior that is already verified working
- Quick Settings Tile
- Config parsing
- Existing working server configurations

A working path is evidence. Do not replace it with a new implementation just because another path is broken.

### 3. FACT vs HYPOTHESIS vs ROOT CAUSE
Never present a hypothesis as a confirmed root cause.

Before changing code, classify findings as:
- FACT — directly verified by code, logs, or reproducible behavior.
- HYPOTHESIS — plausible but not yet proven.
- ROOT CAUSE — demonstrated by tracing/reproduction and confirmed by an A/B test or equivalent evidence.

If the root cause is not proven, diagnose first.

### 4. Compare working vs failing paths
When a working configuration, platform, or flow exists, use it as the baseline.

Find the first meaningful divergence between:
WORKING → FAILING

Do not redesign both paths.

### 5. One bug family at a time
Do not combine unrelated fixes into a large rewrite.

For each bug:
1. Reproduce/trace.
2. Identify the smallest root cause.
3. Make the minimum change.
4. Build/test.
5. Verify that previously-working behavior still works.

### 6. Native code protection
Do not change Kotlin/Swift/Go/native core code for a UI/TypeScript issue unless evidence directly proves the native layer is responsible.

Do not redesign DNS, networking, tunnel lifecycle, or core architecture based on assumptions.

### 7. Stop conditions
STOP and ask for confirmation before:
- major architectural changes
- rewriting a subsystem
- changing the native VPN layer without direct evidence
- redesigning DNS/network architecture
- modifying more than 5 unrelated files
- changing behavior globally when the bug affects only one configuration/path
- fixing an unproven hypothesis

### 8. Verification
After every meaningful fix:
- Build the affected target.
- Test the reported failing case.
- Test at least one known-good case.
- Check for regressions in previously-working functionality.

### 9. Final report
Always report:
- Confirmed root cause
- Files changed
- Why each file was changed
- What was intentionally NOT changed
- Tests performed and results
- Any remaining uncertainty

**Default behavior: preserve working code, diagnose before editing, and make the smallest possible change.**