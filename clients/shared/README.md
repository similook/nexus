# @nexus/shared

The Nexus UI, with no platform in it.

Every view, component, hook and parser lives here. What does **not** live here is any way of
actually doing anything: no tunnel, no HTTP client, no clipboard, no window. Those arrive
through [`PlatformPort`](src/platform.ts), which each shell implements.

```
clients/shared     ← this package: the app
clients/web        ← Android shell (Capacitor). Has its own copy — see "The fork" below.
clients/desktop    ← desktop shell (Tauri, ADR-0003)
```

---

## The port

One interface, five capabilities. A shell provides an object; nothing here knows or cares what
is behind it.

| Member | What the shell supplies |
|---|---|
| `core` | The tunnel — the 8-method / 3-event contract in [`src/core/plugin.ts`](src/core/plugin.ts) |
| `http` | A **native** HTTP client. Not `fetch` — see below |
| `clipboard` | Copy text |
| `appState` | "Is the user looking at this?" — drives R1 |
| `isStub` | Whether `core` is a simulation |
| `name` | `"android"` / `"desktop"` / `"browser"` |

Integration is three lines:

```tsx
const port = createPort();
coreEvents.attach(port.core);        // BEFORE render — see below

createRoot(el).render(
  <PlatformProvider value={port}>
    <App />
  </PlatformProvider>,
);
```

See [`clients/desktop/src/main.tsx`](../desktop/src/main.tsx) for the whole thing.

### Three things that bite

**`coreEvents.attach()` must run before the first render.** The event bridge is a module-level
singleton — it has to be, so every component shares one fan-out — so it is constructed at
import time and cannot read React context. A component subscribing in its first effect finds
no transport. The symptom is a UI that connects and then sits at `0.00 MB/s` forever.

**`http` must not be `fetch`.** Subscription servers do not send `Access-Control-Allow-Origin`
for a custom-scheme page origin, so `fetch` fails on virtually every real link, and browsers
silently drop the `User-Agent` header that panels use to decide what to serve. Both shells go
through a native client.

**`isStub` is set by the implementation, never inferred.** This replaced
`Capacitor.isNativePlatform()`, which answers a different question — outside Capacitor it
returns `false`, so a desktop build would have shown "no core attached" permanently on top of a
working tunnel.

---

## The fork

`clients/web` was not changed when this package was created. It still holds its own full copy
of every file here, and Capacitor still reaches straight into it.

That was the explicit condition for Phase 1: the shipped Android app cannot break if nothing in
it changes. The cost is that these are two copies that can drift — the same situation
`CONTRIBUTING.md` describes under *"Kotlin sources are in two places"*.

So drift is tracked rather than hoped about:

```bash
npm run check-drift
```

[`manifest.json`](manifest.json) records the SHA-256 of each Android source **at the moment it
was copied**. The check re-hashes them today and reports anything that has moved on, because a
fix made over there — a parser bug, a protocol change — probably belongs here too.

It deliberately does not diff the two trees against each other. They are *supposed* to differ:
the copies here were rewritten onto `PlatformPort`. Diffing would flag every intentional change
and train everyone to ignore the output.

After porting a change across, re-record:

```bash
node scripts/record-manifest.mjs
```

**The end state is that `clients/web` imports from this package and the fork disappears.** Until
then, `check-drift` is the thing standing between "a known cost" and "a silent one".

---

## Rules

1. **Never import from a shell.** `clients/shared` → `clients/web` or `clients/desktop` is
   always wrong. The dependency runs one way.
2. **Never import a transport.** No `@capacitor/*`, no Tauri API, no socket. If a new
   capability is needed it goes on `PlatformPort` and every shell implements it.
3. **Import from `src/index.ts`.** Deep imports work mechanically and make every internal file
   part of the contract.

Rule 2 is the one that erodes quietly. The moment one file reaches around the port, this stops
being shared code and becomes a third copy of the app.

---

## Known debt

- **`ServerNode.config` is raw sing-box JSON**, generated here and read by five UI files
  (`data/servers.ts`, `core/nodeDetails.ts`, `views/HomeView.tsx`, `App.tsx`). Two backends
  will drift through it. ADR-0002 §2 says config assembly belongs in Go; ADR-0003 §5.1 defers
  that and proposes `buildConfig(outbound, { platform })` as the interim step.
- **The layout is a 448 px phone shell** (`max-w-md`, `body { overflow: hidden }`, no
  breakpoints). It runs on a desktop window and looks like a phone strip in the middle of it.
  ADR-0003 Phase 9.
- **`core/plugin.web.ts` is statically imported** by the desktop shell, so the simulated core
  is in its bundle. Correct for now — it *is* that shell's core — and wrong the moment the
  daemon port lands.

---

## Checks

```bash
npm run typecheck
npm run check-drift
```

Neither needs a shell installed.
