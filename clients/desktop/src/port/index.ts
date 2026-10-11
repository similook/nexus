import type { PlatformPort } from '@nexus/shared';

/**
 * Choose the port for this run.
 *
 * Two hosts exist:
 *
 *   browser   `npm run dev`, and any build loaded over http. Simulated core.
 *   tauri     the packaged app, talking to nexusd (ADR-0003 Phase 4).
 *
 * Detection is by the Tauri global rather than a build-time flag, because the same bundle is
 * loaded both ways during development — `npm run dev` in a browser tab and the same dev server
 * inside the Tauri window. A compile-time constant cannot be right for both.
 *
 * BOTH PORTS ARE LAZY. `import()` rather than a static import means the simulated core
 * (NexusCoreWeb, via browser.ts) is only ever loaded by the browser branch. A packaged app
 * that statically contained a working simulation of the tunnel would be one bad branch away
 * from running it — which is the failure `isStub` exists to make impossible to hide.
 */
export async function createPort(): Promise<PlatformPort> {
  if (isTauri()) {
    const { createTauriPort } = await import('./tauri');
    return createTauriPort();
  }
  const { createBrowserPort } = await import('./browser');
  return createBrowserPort();
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
