# Contributing

## Before anything else: never paste a real credential

A `vless://` / `vmess://` / `trojan://` link carries a UUID or password that is a bearer token.
A subscription URL is the credential for every node behind it. Once either is in an issue, a PR,
a commit or a log paste, it is in the edit history and in everyone's notification email —
deleting it afterwards does not help.

Mask them:

```
vless://00000000-0000-0000-0000-000000000000@example.com:443?type=ws&security=tls&sni=a.com#Node
```

The part after `?` is what actually helps anyone debug.

## Running the checks

Three, and they take seconds. Run all of them before opening a PR.

```bash
# Every supported link shape, through the SAME validator that runs on the device
./core/scripts/check-configs.sh

cd clients/web
npm run typecheck      # NOT `npx tsc --noEmit` — see below
npm run check-parsers  # exact-string assertions on the URI scanner
```

**Use `npm run typecheck`.** The root `tsconfig.json` is a solution file with `files: []`, so a
bare `tsc --noEmit` validates *nothing* and exits 0. That silently hid a batch of null-safety
errors once.

**`check-parsers` asserts whole strings, not counts.** A count-only check once passed while
every extracted URI was truncated — a `\s` inside a template literal had its backslash eaten, so
the character class excluded the letter `s` and each URI was cut at its first one. Three found,
three expected, all three corrupt. If you add a case, compare the full string.

## The two validation layers

`check-configs.sh` runs `libbox.CheckConfig` — the exact function `ConfigGuard` calls on the
device. But sing-box accepts combinations that a *server* rejects, and those fail at runtime as
a bare `EOF` three layers from the cause. Two are already known and asserted in
`clients/web/scripts/emit-config-fixtures.mts`:

- **`flow` without TLS.** XTLS Vision operates on TLS records; with no TLS there are none.
  `CheckConfig` returns `nil` for this. Verified.
- **`h2` ALPN on a WebSocket node.** A WS upgrade is an HTTP/1.1 mechanism; if TLS negotiates
  h2 there is no upgrade to perform and the connection dies *after* the handshake.

If you find another rule sing-box does not enforce, add it to `assertSane` there rather than
only fixing the symptom.

## House rules

These come from `CLAUDE.md` and are not negotiable in review:

1. **No performance or battery figure without a `bench/` run behind it.** Cite the run. If a
   number is an estimate, write "estimate" in the same sentence. The project's whole thesis is a
   battery claim; unbacked numbers corrode it.
2. **Core-specific types stay behind `core/` interfaces.** The UI talks to the abstraction.
3. **Core version bumps are a reviewed change.** An upstream performance regression is the main
   threat to the product.
4. **Timers need justification.** There are exactly two in the app — the uptime clock and
   foreground latency polling — and both run only while the screen showing them is visible.
   Anything that wakes the radio on a schedule is a battery cost, and the radio is the whole
   argument.

## Comments

Write down *why*, not *what*. This codebase has a lot of decisions that look wrong until you
know what they cost:

- gVisor overrides ADR-0001 §5.4 because `system` silently dropped TCP.
- `rebuildNodeConfig` regenerates a node's config from its URI on every load, so patching a
  config directly reverts on next launch.
- `QrScanner` deliberately keeps `onResult` in a ref and out of its dependency array; listing it
  reopened the camera once a second.

Each of those was expensive to find. A comment saying "this is deliberate, here is what happened
without it" is worth more than a tidy one-liner.

## Kotlin sources are in two places

`clients/android/nexus-plugin/src/main/java/io/nexus/plugin/` is canonical;
`clients/web/android/app/src/main/java/io/nexus/plugin/` is the copy Gradle builds. Edit one,
copy to the other, and make sure both are in your commit.

## Commits and PRs

- One concern per PR. A config fix and a UI change are two PRs.
- Say what you tested on. "Built and typechecked" and "ran on a Pixel 6 with a REALITY node"
  are very different claims, and the second is the one that matters here.
- If you changed anything in the config pipeline, paste the `check-configs.sh` output.
