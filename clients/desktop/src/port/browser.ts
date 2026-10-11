import { NexusCoreWeb, type PlatformPort } from '@nexus/shared';

/**
 * The development port: real UI, simulated core.
 *
 * This is what `npm run dev` uses, and it is the whole Phase 1 deliverable — proof that the
 * UI runs with no Capacitor anywhere in the graph, driven entirely through `PlatformPort`.
 *
 * Every capability here is implemented with a plain web API, which is exactly why it is not
 * the shipping port:
 *
 *   core       a simulation (NexusCoreWeb). No tunnel exists.
 *   http       window.fetch, which WILL hit CORS on real subscription links (see below).
 *   clipboard  navigator.clipboard.
 *   appState   document.visibilityState.
 *
 * The Tauri port (Phase 4, ADR-0003 §6) replaces `core` with framed JSON to nexusd and `http`
 * with a native client. `clipboard` and `appState` may well survive as-is: a desktop webview
 * has neither the secure-context problem nor the user-activation window that forced Android
 * onto native ClipboardManager.
 */
export function createBrowserPort(): PlatformPort {
  return {
    core: new NexusCoreWeb(),

    /**
     * fetch, and it is a known limitation rather than an oversight.
     *
     * A real subscription server does not send `Access-Control-Allow-Origin` for this page's
     * origin, so any genuine link fails here with a CORS error. That is correct behaviour for
     * a dev stub: it fails loudly and locally instead of appearing to work and then breaking
     * on a packaged build.
     *
     * The User-Agent header is also silently dropped — browsers forbid setting it — and panels
     * serve different payloads without it. Both problems go away in the Tauri port, which is
     * the only reason it is acceptable to leave them here.
     */
    http: {
      async get({ url, headers }) {
        const response = await fetch(url, { headers, redirect: 'follow' });
        const collected: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          collected[key] = value;
        });
        return {
          status: response.status,
          data: await response.text(),
          headers: collected,
        };
      },
    },

    clipboard: {
      async write(text) {
        await navigator.clipboard.writeText(text);
      },
    },

    /**
     * Visibility only.
     *
     * A desktop window that is minimised, fully occluded, or hidden to the tray does not
     * reliably fire `visibilitychange` — that is a document-level signal, not a window-level
     * one. So R1 (stop streaming when nobody is watching) is only approximately honoured here.
     * The Tauri port subscribes to real window events instead, which is the point of this
     * being a port method rather than a `document.addEventListener` buried in a hook.
     */
    appState: {
      subscribe(onVisibilityChange) {
        const handler = () => onVisibilityChange(document.visibilityState === 'visible');
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
      },
    },

    isStub: true,
    name: 'browser',
  };
}
