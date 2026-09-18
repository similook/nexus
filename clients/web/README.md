# Nexus web layer

React + TypeScript + Tailwind in Capacitor ([ADR-0002](../../docs/adr/ADR-0002-frontend-stack.md)).
This directory holds the integration layer between the UI and the native plugin — hop ① of
[core/docs/ipc-boundary.md](../../core/docs/ipc-boundary.md).

## Running it

```bash
npm install
npm run dev      # http://localhost:5173, against the web stub
npm run build    # tsc -b && vite build
```

Verified on Node 24.20 / npm 11.19: `npm run build` passes type-check and builds clean (528 KB).
In the browser, against the stub: connect goes disconnected → connecting → connected, live
throughput and session totals update, uptime runs, all three tabs navigate, node selection
persists across tabs, and the log ring parses and renders. Console clean, no errors.

> npm 11 gates postinstall scripts. `esbuild` needs one, so the first install prints an
> `install-scripts` warning and Vite then fails to build. `npm install-scripts approve esbuild`
> (already recorded in `package.json`'s `allowScripts`) fixes it.

## Files

| File | Role |
|---|---|
| `src/core/plugin.ts` | Capacitor plugin definitions. Mirrors `NexusPlugin.kt`. |
| `src/core/plugin.web.ts` | Browser stub so the UI is debuggable outside a device. Simulates the *contract*, not the core. |
| `src/core/useNexusCore.ts` | The single React entry point. State machine, subscriptions, resume reconciliation. |
| `src/core/format.ts` | Bytes → MB/s and HH:MM:SS, matching the mockup's units. |
| `src/core/coreEvents.ts` | One Capacitor listener per event, fan-out via Set. Read the header comment before changing it. |
| `src/core/NexusProvider.tsx` | Holds the single core connection for the app's lifetime. |
| `src/data/servers.ts` | Mock nodes, shaped the way real subscription data will be. |
| `src/App.tsx` | Shell: header, tab switch, providers. |
| `src/components/BottomNav.tsx` | Three-tab nav with safe-area handling. |
| `src/components/Toast.tsx` | Transient feedback. |
| `src/views/HomeView.tsx` | Connect hub, active node, traffic cards. |
| `src/views/ServersView.tsx` | Subscription card, node list, selection. |
| `src/views/LogsView.tsx` | Terminal log view. Pull-based. |

## Never call `NexusCore.addListener` from a component

Subscribe through `coreEvents` instead. This is not a style preference — it works around a
real defect in `@capacitor/core`.

`WebPlugin.removeListener` is:

```js
const index = listeners.indexOf(listenerFunc);
this.listeners[eventName].splice(index, 1);
```

There is no `index === -1` guard, and `splice(-1, 1)` removes the **last** element. So a removal
that misses does not no-op — it silently deletes a different, live listener.

`addListener` is async while effect cleanup is synchronous, so StrictMode's double mount and
every Fast Refresh interleave registration and removal in an order that is not call order
(observed: a run's `serviceState` handle resolved before its own `status` handle). Handles from
a discarded mount then remove entries belonging to the live one.

The symptom is nasty because it does not look like a subscription bug: the core connects and
streams traffic while the UI sits at 0.00 MB/s, or the button sticks on "Connecting" forever.
`serviceState` and `status` can die independently, so it reads like a state-machine fault.

`coreEvents` registers with Capacitor exactly once per page and never unregisters; React
subscribers are added to and removed from a plain `Set`, which is synchronous and exact. Not
unregistering costs nothing: an idle JS listener is free, and the expensive half — the
CommandClient socket — is owned by the native layer, which connects it on `handleOnResume` and
disconnects on `handleOnPause` (R1).

## Why the core lives in a provider

`useNexusCore` opens the status subscription in an effect. Called inside `HomeView`, every tab
switch would unmount it — tearing down the listener, re-adding it, and firing a reconciliation
`getStatus()` on the way back. Three taps around the nav bar would be six subscription churns
and three extra bridge round-trips to display numbers that were already arriving. Uptime and
session totals would also reset on every visit.

Mounted once at the App root, the subscription's lifetime matches the app's — which is what the
native layer already assumes: `NexusPlugin` connects its `CommandClient` on `handleOnResume` and
disconnects on `handleOnPause`, keyed to WebView visibility, not to which component is mounted.

Views themselves are unmounted rather than hidden. `LogsView` refetches its ring on mount, so
returning to the tab gets fresh output with no polling timer, and an unmounted view cannot hold
a subscription open behind the user's back.

## Dependencies

```bash
npm i @capacitor/core @capacitor/app
```

`@capacitor/app` is required — `appStateChange` is the reliable resume signal on Android;
`document.visibilitychange` alone is not.

## The one rule

**No polling.** Live values arrive on the `status` listener, throttled to 1 Hz *inside the Go
core* and deduped in the native plugin. `getStatus()` is a reconciliation call, not an
endpoint to put on a timer — doing so re-creates above the bridge exactly the wakeup pattern
the architecture exists to remove, and does it worse, because each call is a main-thread
crossing with no source-side throttle.

There is exactly one `setInterval` in this layer: the uptime clock in `useNexusCore`. It is
gated on `connected && !document.hidden`, so it only ticks when the screen is on and the
compositor is already running. It cannot be driven off the status event instead — those are
deduped, so an idle tunnel would freeze the clock.

## Three behaviours that surprise people

1. **`start()` resolving does not mean connected.** It means the service was asked to start.
   The tunnel is up when the `serviceState` event says `started`. The hook deliberately does
   not optimistically flip to connected.
2. **Status ticks do not arrive every second.** The native layer drops ticks whose values did
   not change, so an idle tunnel is silent. Anything that assumes a 1 Hz heartbeat will break
   on device. The web stub reproduces this on purpose.
3. **Values go stale while backgrounded.** The native layer disconnects the stream on pause
   (R1). The hook reconciles once on resume; there is no catch-up replay.

## Porting the Stitch mockup

The export in `stitch_modern_mobile_vpn_client_ui.zip` is a **vanilla HTML/JS prototype**, not
React — one `state` object plus `document.getElementById` mutations. Porting is mechanical,
with one hazard:

**Delete `state.speedInterval` and `state.uptimeInterval`.** They exist to fake data. Porting
them into `useEffect` would add polling timers above the bridge and undo the power policy.
`useNexusCore` already owns both concerns.

Element-id → hook mapping is documented at the top of `HomeView.tsx`.

## Bundle size

496 KB built, 300 KB of it fonts. The first build was 972 KB: the unscoped
`@fontsource/<font>/400.css` entry points pull cyrillic, cyrillic-ext, vietnamese and latin-ext
alongside latin. `src/index.css` imports `latin-*` only — add a subset back when the app ships
that language, not before.

Remaining easy win: roughly half the 300 KB is legacy `.woff` alongside `.woff2`. Every Android
WebView we support reads woff2, so the `.woff` files are never fetched at runtime — they are
pure APK weight. Stripping them needs a small Vite plugin or a patched fontsource CSS; not done.

## Tailwind version

Pinned to **Tailwind 3.4**, which is what `tailwind.config.js` + `postcss.config.js` implies and
what the mockup's inline config is written against, so the theme port is one-to-one. Tailwind 4
is current and is the eventual target; migrating means `@tailwindcss/vite` instead of PostCSS
and the theme moving into a CSS `@theme` block. Worth doing deliberately, not as a side effect.

## Not yet done

- No linter (ESLint) or test runner wired up.
- Config generation: `src/data/servers.ts` carries `config: '{}'` placeholders. Real configs
  come from the native/Go side — the UI sends intent, never synthesised sing-box JSON.
- Clipboard import, subscription update/delete, per-node delete: buttons exist, wired to a
  toast saying so rather than faking success.
- `Ping All` simulates locally. The real call is `NexusCore.urlTest({ group })` — a one-shot
  user action, never a background poller.
- Selecting a node while connected does not reconnect; it toasts "reconnect to apply". Silent
  reconnection on tap is a decision worth making deliberately, not by default.
