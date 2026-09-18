import { useEffect, useState } from 'react';
import { App } from '@capacitor/app';
import { NexusCore } from './plugin';
import { endpointOf, type ServerNode } from '../data/servers';

/**
 * Live latency of one node, polled while the user is looking at it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THIS IS A TIMER, AND TIMERS ARE THE THING ADR-0001 EXISTS TO REMOVE.
 *
 * It is allowed under exactly the same argument as the uptime clock: it runs ONLY while the
 * tunnel's own screen is visible and the app is in the foreground. The display is already
 * being composited at that point, so the wakeup was happening regardless.
 *
 * The moment the app is backgrounded it stops - not slows, stops - and the in-flight probe is
 * abandoned. A 15s poll left running behind a locked screen is 5,760 radio wakeups a day to
 * refresh a number nobody can see, which is precisely the competitor behaviour the battery
 * thesis is built against.
 *
 * Two independent guards, because either one alone has a hole:
 *   - Capacitor's appStateChange, which fires on background/foreground.
 *   - document visibilitychange, which also fires when the WebView is obscured without the
 *     app being backgrounded (split screen, a system dialog over the top).
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * The probe is the native TCP handshake, so it does not disturb the tunnel and works whether
 * or not one is up. See NexusCorePlugin.tcpPing.
 */

/** Generous on purpose. Latency to a proxy does not meaningfully change every second. */
const POLL_INTERVAL_MS = 15_000;

export function useLivePing(node: ServerNode | null): number | null {
  const [ping, setPing] = useState<number | null>(null);

  useEffect(() => {
    // A measurement belongs to the node it was taken for. Clearing on change stops the
    // previous server's number sitting under the new server's name.
    setPing(null);

    const endpoint = node === null ? null : endpointOf(node);
    if (node === null || endpoint === null) return;

    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const probe = async () => {
      try {
        const { results } = await NexusCore.tcpPing({
          targets: [{ id: node.id, server: endpoint.server, port: endpoint.port }],
        });
        if (stopped) return;
        const ms = results[0]?.ms;
        setPing(typeof ms === 'number' && ms >= 0 ? ms : null);
      } catch {
        // Unreachable is a normal answer here, not an error to surface.
        if (!stopped) setPing(null);
      }
    };

    const start = () => {
      if (timer !== null || stopped) return;
      void probe();
      timer = setInterval(() => void probe(), POLL_INTERVAL_MS);
    };

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    // Only poll when the screen showing this number is actually in front.
    const visible = () => document.visibilityState === 'visible';
    if (visible()) start();

    const onVisibility = () => (visible() ? start() : stop());
    document.addEventListener('visibilitychange', onVisibility);

    const appListener = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive && visible()) start();
      else stop();
    });

    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      // addListener resolves to a handle; removing it is async and the component is already
      // gone, so failures are swallowed rather than surfaced.
      void appListener.then((handle) => handle.remove()).catch(() => {});
    };
  }, [node]);

  return ping;
}
