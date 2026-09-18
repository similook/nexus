import { NexusCore, type ServiceStateEvent, type StatusMessage } from './plugin';

/**
 * One Capacitor listener per event, for the lifetime of the page. React components subscribe
 * to THIS, not to the plugin.
 *
 * WHY THIS EXISTS
 *
 * Capacitor's WebPlugin.removeListener is:
 *
 *     const index = listeners.indexOf(listenerFunc);
 *     this.listeners[eventName].splice(index, 1);
 *
 * There is no guard for `index === -1`, and `splice(-1, 1)` removes the LAST element. A
 * removal that misses therefore does not no-op — it silently deletes a different, live
 * listener.
 *
 * That is a landmine for any React subscriber, because `addListener` is async while effect
 * cleanup is synchronous. StrictMode's double mount and every Fast Refresh interleave
 * registration and removal in an order that is not call order (verified: a run's
 * `serviceState` handle resolved before its own `status` handle). Handles from a discarded
 * mount can then remove entries belonging to the live one. The observed symptom was the
 * `status` listener disappearing entirely — the core streaming traffic while the UI sat at
 * 0.00 MB/s — with `serviceState` surviving, which made it look like a state-machine bug
 * rather than a subscription bug.
 *
 * The fix is to stop using per-handle removal at all. We register once, never unregister, and
 * do our own fan-out through a Set, where add/delete are synchronous and exact.
 *
 * Not unregistering from Capacitor is deliberate and costs nothing: a JS-side listener on an
 * idle event is free, and the expensive half of the subscription — the CommandClient socket to
 * the core — is owned by the native layer, which connects it on handleOnResume and disconnects
 * it on handleOnPause (core/docs/ipc-boundary.md R1). Page teardown collects the rest.
 */

type EventMap = {
  status: StatusMessage;
  serviceState: ServiceStateEvent;
  /** Result of NexusCore.pingProxy(). ok:false means the test failed or timed out. */
  proxyDelay: { delayMs: number; ok: boolean };
};

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

class CoreEventBridge {
  private readonly subscribers: { [K in keyof EventMap]: Set<Handler<K>> } = {
    status: new Set(),
    serviceState: new Set(),
    proxyDelay: new Set(),
  };

  private wiring: Promise<void> | null = null;

  /** Returns an unsubscribe function. Synchronous, exact, safe to call twice. */
  subscribe<K extends keyof EventMap>(event: K, handler: Handler<K>): () => void {
    this.subscribers[event].add(handler);
    void this.ensureWired();

    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subscribers[event].delete(handler);
    };
  }

  private ensureWired(): Promise<void> {
    // Single in-flight promise: concurrent subscribers during the same mount share it, so we
    // never register twice even though addListener is async.
    this.wiring ??= (async () => {
      await NexusCore.addListener('status', (payload) => this.emit('status', payload));
      await NexusCore.addListener('serviceState', (payload) => this.emit('serviceState', payload));
      await NexusCore.addListener('proxyDelay', (payload) => this.emit('proxyDelay', payload));
    })().catch((e) => {
      // Let a later subscriber retry rather than wedging the bridge permanently.
      this.wiring = null;
      throw e;
    });

    return this.wiring;
  }

  private emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    // Copy before iterating: a handler may unsubscribe itself.
    for (const handler of [...this.subscribers[event]]) handler(payload);
  }
}

export const coreEvents = new CoreEventBridge();
