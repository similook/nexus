import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, PlatformProvider, coreEvents } from '@nexus/shared';
import './fonts';
import '@nexus/shared/index.css';
import { createPort } from './port';

/**
 * The desktop shell's entry point.
 *
 * Compare clients/web/src/main.tsx: same three lines of React, but the app is imported from
 * the shared package rather than defined next door, and it is wrapped in a port.
 *
 * ORDER MATTERS HERE, in a way that fails at runtime rather than at build time:
 *
 *   1. Build the port.
 *   2. `coreEvents.attach(port.core)` BEFORE render. The bridge is a module singleton — it is
 *      constructed at import time and cannot read React context — so a component that
 *      subscribes during its first effect would otherwise find no transport attached. The
 *      symptom is a UI that connects and then sits at 0.00 MB/s forever, which is exactly the
 *      failure coreEvents was written to prevent, arriving by a different route.
 *   3. `<PlatformProvider>` must be ABOVE `<App />`, because App mounts NexusProvider, which
 *      calls useNexusCore, which calls usePlatform.
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// createPort() is async because each port is loaded lazily (see port/index.ts). The order
// below is unchanged: port, then coreEvents.attach, then render.
createPort()
  .then((port) => {
    coreEvents.attach(port.core);

    createRoot(container).render(
      // StrictMode stays ON, for the same reason clients/web keeps it: double-mounted effects
      // are what expose async subscription leaks in development instead of on a user's machine.
      <StrictMode>
        <PlatformProvider value={port}>
          <App />
        </PlatformProvider>
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    // No port means no core. Say so in the window rather than leaving it blank: a VPN client
    // that shows nothing gives the user no way to know it is not protecting them.
    container.textContent = `Nexus could not start: ${String(error)}`;
  });
