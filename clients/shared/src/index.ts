/**
 * The public surface of @nexus/shared.
 *
 * A shell imports from here and from nowhere else inside this package. Deep imports
 * (`@nexus/shared/src/core/useNexusCore`) work mechanically and are still forbidden: they make
 * every internal file part of the contract, and the point of this barrel is that moving a file
 * is not a breaking change for two shells at once.
 *
 * WHAT A SHELL OWES THIS PACKAGE
 *
 *   1. `<PlatformProvider value={port}>` above `<App />`, where `port` is a PlatformPort.
 *   2. `coreEvents.attach(port.core)` once, before the first render.
 *   3. `import '@nexus/shared/index.css'`.
 *
 * That is the whole integration. See clients/desktop/src/main.tsx.
 */

// The app itself.
export { App } from './App';

// The port every shell implements.
export {
  PlatformProvider,
  usePlatform,
  type PlatformPort,
  type PortAppState,
  type PortClipboard,
  type PortHttp,
  type PortHttpRequest,
  type PortHttpResponse,
} from './platform';

// The core contract, as types. No transport.
export type {
  NexusCorePlugin,
  PluginListenerHandle,
  ServiceState,
  ServiceStateEvent,
  StatusMessage,
  StatusSnapshot,
  ClashModeEvent,
  NetworkStatusEvent,
  NetworkStatusState,
  NetworkTransport,
} from './core/plugin';

/** How a port's start() says "waiting for the OS to grant permission" rather than "failed". */
export { awaitingApproval } from './core/plugin';

/**
 * The event fan-out. Exported so a shell can `attach()` it.
 *
 * It is a module-level singleton by necessity — every component must see the same one — which
 * is why it cannot read the port out of React context and has to be handed the core instead.
 */
export { coreEvents } from './core/coreEvents';

/**
 * The development stub.
 *
 * A shell that has a real core MUST reach this through a lazy `import()`, not a static one.
 * Today the desktop shell imports it statically because the stub IS its core, which is correct
 * for Phase 1 and wrong the moment the daemon port lands: a production build that still
 * contains a working simulation of the tunnel is one bad branch away from running it.
 * Tracked as a Phase 4 task in clients/desktop/README.md.
 */
export { NexusCoreWeb } from './core/plugin.web';

// Domain types a shell may need when building its port or its window chrome.
export type { ServerNode, Protocol } from './data/servers';

/**
 * Desktop routing (VPN / Direct). A shell that sets PlatformPort.routing composes the user's
 * choice onto each config in its start(); see core/routing.ts.
 */
export { composeRouting, loadRoutingMode, type RoutingMode } from './core/routing';
