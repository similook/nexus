import type {
  ClashModeEvent,
  NexusCorePlugin,
  ServerProbeEvent,
  ServiceStateEvent,
  StatusMessage,
} from './plugin';

/**
 * One listener per event, for the lifetime of the page. React components subscribe to THIS,
 * not to the core.
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
 * Not unregistering is deliberate and costs nothing: a JS-side listener on an idle event is
 * free, and the expensive half of the subscription — the socket to the core — is owned by the
 * host, which connects and disconnects it with visibility (core/docs/ipc-boundary.md R1).
 * Page teardown collects the rest.
 *
 * The bug above is Capacitor's, and the desktop host does not share it. The fan-out stays
 * anyway: it is also what lets this be a singleton that components subscribe to synchronously,
 * and having one subscription model across shells is worth more than shedding ~40 lines on one
 * of them.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THE CORE IS ATTACHED RATHER THAN IMPORTED
 *
 * This bridge is a module-level singleton — it has to be, so that every component sees the
 * same fan-out — which means it is constructed before any React tree exists and cannot read
 * the port out of context. So the shell hands it the core once, at startup, before render.
 *
 * `attach()` is idempotent and refuses a second, different core: swapping the core underneath
 * live subscribers would leave them attached to a dead transport with no error, which is the
 * same class of silent-subscription bug this file exists to prevent.
 * ---------------------------------------------------------------------------------------
 */

type EventMap = {
  status: StatusMessage;
  serviceState: ServiceStateEvent;
  /** Result of NexusCore.pingProxy(). ok:false means the test failed or timed out. */
  proxyDelay: { delayMs: number; ok: boolean };
  /** Desktop routing: the mode the running tunnel is applying. See core/routing.ts. */
  clashMode: ClashModeEvent;
  /** NexusCore.probeServers: one server's result, then one done per run. */
  serverProbe: ServerProbeEvent;
  serverProbeDone: { runId: number; cancelled: boolean };
};

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

class CoreEventBridge {
  private readonly subscribers: { [K in keyof EventMap]: Set<Handler<K>> } = {
    status: new Set(),
    serviceState: new Set(),
    proxyDelay: new Set(),
    clashMode: new Set(),
    serverProbe: new Set(),
    serverProbeDone: new Set(),
  };

  private wiring: Promise<void> | null = null;

  private core: NexusCorePlugin | null = null;

  /**
   * Give the bridge its transport. Called once by the shell, before the first render.
   */
  attach(core: NexusCorePlugin): void {
    if (this.core === core) return;
    if (this.core !== null) {
      throw new Error('coreEvents.attach: a different core is already attached');
    }
    this.core = core;
  }

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
    const core = this.core;
    if (core === null) {
      return Promise.reject(
        new Error('coreEvents: no core attached. The shell must call coreEvents.attach(port.core).'),
      );
    }

    this.wiring ??= (async () => {
      await core.addListener('status', (payload) => this.emit('status', payload));
      await core.addListener('serviceState', (payload) => this.emit('serviceState', payload));
      await core.addListener('proxyDelay', (payload) => this.emit('proxyDelay', payload));
      await core.addListener('clashMode', (payload) => this.emit('clashMode', payload));
      await core.addListener('serverProbe', (payload) => this.emit('serverProbe', payload));
      await core.addListener('serverProbeDone', (payload) => this.emit('serverProbeDone', payload));
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
