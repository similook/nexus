/**
 * PlatformPort — the one interface a shell has to implement.
 *
 * =========================================================================================
 * WHY THIS EXISTS
 *
 * This tree is the UI, and it is shared by shells that have nothing in common underneath:
 *
 *   clients/web      Capacitor + Android, talking to NexusPlugin.kt over the JS bridge
 *   clients/desktop  a webview, talking to the privileged nexusd daemon over a pipe
 *   (browser)        neither — the development stub in core/plugin.web.ts
 *
 * Before this interface, five capabilities were reached for directly wherever they happened
 * to be needed. Each was a `@capacitor/*` import sitting in a component or a hook:
 *
 *   core/plugin.ts        registerPlugin('NexusCore')     the tunnel itself
 *   core/subscription.ts  CapacitorHttp.get               fetching a subscription body
 *   views/LogsView.tsx    Clipboard.write                 copy the log
 *   components/NodeSheet  Clipboard.write                 copy a share link
 *   core/useNexusCore.ts  App.addListener('appStateChange')
 *   core/useLivePing.ts   App.addListener('appStateChange')
 *   App.tsx               Capacitor.isNativePlatform()
 *
 * Seven call sites, five capabilities, one hard dependency on a mobile framework. They are
 * gathered here instead, and each shell supplies its own implementation.
 *
 * =========================================================================================
 * THE BUG THAT MADE `isStub` A PORT PROPERTY RATHER THAN A RUNTIME CHECK
 *
 * `App.tsx` decided whether to show the "WEB STUB — synthetic data, no core attached" banner
 * by calling `Capacitor.isNativePlatform()`. Outside Capacitor that returns **false**, so a
 * desktop build would have rendered that banner permanently, on top of a working tunnel.
 *
 * The question the UI is actually asking is "is the thing behind this port real?" — a property
 * of the implementation, not of which framework happens to be loaded. So the implementation
 * answers it. A shell that wires a real core sets `isStub: false` and cannot get it wrong.
 *
 * =========================================================================================
 * THE RULE
 *
 * Nothing under clients/shared may import from a shell, and nothing may import a transport
 * (`@capacitor/*`, a Tauri API, a socket). If a new capability is needed, it goes on this
 * interface and each shell implements it. The moment one file reaches around the port, this
 * tree stops being shared and becomes a third copy of the app.
 * =========================================================================================
 */

import { createContext, useContext } from 'react';
import type { NexusCorePlugin } from './core/plugin';

/** A minimal HTTP response. Deliberately not `Response` — that is a browser type, and the */
/** implementations here are native HTTP clients that never produce one. */
export interface PortHttpResponse {
  status: number;
  /** The body as text. Callers decode/parse; the port does not guess. */
  data: string;
  headers: Record<string, string>;
}

export interface PortHttpRequest {
  url: string;
  headers?: Record<string, string>;
}

/**
 * HTTP that is not `fetch`.
 *
 * Subscription bodies are fetched from arbitrary user-supplied panels, and `fetch` from a
 * custom-scheme origin hits CORS on every shell we ship. Both real implementations go through
 * a native client instead — `CapacitorHttp` on Android, the daemon or the Tauri HTTP plugin on
 * desktop.
 *
 * The custom `User-Agent` matters and must be preserved: panels serve different payloads
 * without it, and some serve nothing at all.
 */
export interface PortHttp {
  get(request: PortHttpRequest): Promise<PortHttpResponse>;
}

export interface PortClipboard {
  write(text: string): Promise<void>;
}

/**
 * "Is the user actually looking at this?"
 *
 * Drives R1 from core/docs/ipc-boundary.md — status streaming and the latency poll stop when
 * nobody is watching. The meaning differs by shell and the UI must not care which:
 *
 *   Android  `appStateChange` from @capacitor/app — the app was backgrounded
 *   Desktop  window hidden / minimised / closed to tray (ADR-0003 §4.1)
 *   Browser  document.visibilityState
 *
 * `subscribe` returns its own unsubscribe rather than a handle object, because every consumer
 * is a React effect whose cleanup wants exactly that shape.
 */
export interface PortAppState {
  subscribe(onVisibilityChange: (visible: boolean) => void): () => void;
}

export interface PlatformPort {
  /** The tunnel. The 8-method + 3-event contract in core/plugin.ts. */
  core: NexusCorePlugin;

  http: PortHttp;
  clipboard: PortClipboard;
  appState: PortAppState;

  /**
   * True when `core` is a simulation rather than a tunnel.
   *
   * Set by the implementation, never inferred. See the note above about why this is not a
   * framework check.
   */
  isStub: boolean;

  /** For the About screen and bug reports: "android" | "desktop" | "browser". */
  name: string;

  /**
   * True when this shell supports the routing selector (VPN / Direct): its
   * core implements setClashMode, closeConnections and the clashMode event, and its start()
   * composes routing onto the config (core/routing.ts). Desktop only; absent means no selector.
   */
  routing?: boolean;
}

const PlatformContext = createContext<PlatformPort | null>(null);

export const PlatformProvider = PlatformContext.Provider;

/**
 * Read the port.
 *
 * Throws rather than returning null when a shell forgot to mount the provider. That failure is
 * total — nothing in the app works without a core — so it should be one loud error at startup
 * naming the cause, not a null dereference several components deep.
 */
export function usePlatform(): PlatformPort {
  const port = useContext(PlatformContext);
  if (port === null) {
    throw new Error(
      'No PlatformPort. The shell must render <PlatformProvider value={port}> above <App />. ' +
        'See clients/desktop/src/main.tsx for an example.',
    );
  }
  return port;
}
