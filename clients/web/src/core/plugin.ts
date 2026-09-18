import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Capacitor plugin definitions for the Nexus core.
 *
 * This is hop ① of core/docs/ipc-boundary.md — the JSON bridge between the WebView and the
 * native plugin, and the expensive hop, because it lands on the main thread. Every signature
 * below is shaped by that: small payloads, low frequency, nothing list-shaped.
 *
 * Mirrors NexusPlugin.kt. When you add a method there, add it here; a mismatch fails at
 * runtime with an unhelpful error, not at build time.
 */

// ---------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------

/** Lifecycle state of the core, as reported by the native layer. */
/**
 * 'unknown' means the native side cannot confirm either way right now - it asked for a tunnel,
 * nothing asked to stop it, and the command stream is still reattaching after a resume.
 *
 * It exists so the UI has somewhere to put "I don't know" other than "disconnected". Treating
 * an unconfirmed reading as a stop is what made the uptime timer restart on every resume.
 */
export type ServiceState = 'stopped' | 'starting' | 'started' | 'unknown';

/**
 * A single status tick.
 *
 * Rates are BYTES PER SECOND and totals are BYTES — the core's native units. Formatting to
 * MB/s happens in the view layer (see format.ts); keeping raw bytes here means a UI change
 * never requires a native change.
 *
 * `memory` and `goroutines` come from the Go runtime. They are genuinely useful — memory is
 * the number bench/B-03 cares about — but they belong on a diagnostics screen, not the home
 * view.
 */
export interface StatusMessage {
  /**
   * When the CORE started, epoch milliseconds, as the core reports it. 0 means unknown.
   *
   * On every tick rather than once, because the UI's resume path reads getStatus() before the
   * command stream has finished reconnecting and would otherwise see 0.
   */
  coreStartedAt?: number;
  /**
   * False when the core is not producing traffic counters at all (it depends on the
   * with_clash_api build tag). The zeros alongside it then mean "unknown", NOT "idle" — render
   * them differently or you are showing the user a confident, permanent, wrong 0.00 MB/s.
   */
  trafficAvailable: boolean;
  uplink: number;
  downlink: number;
  uplinkTotal: number;
  downlinkTotal: number;
  connectionsIn: number;
  connectionsOut: number;
  memory: number;
  goroutines: number;
}

export interface ServiceStateEvent {
  state: ServiceState;
  reason?: string;
}

export interface ClashModeEvent {
  modes?: string[];
  current: string;
}

/** getStatus() returns the service state plus the last known status, if any. */
export type StatusSnapshot = Partial<StatusMessage> & {
  state: ServiceState;
  /**
   * When the CORE started, in epoch milliseconds, as reported by the core itself.
   * 0 means unknown — nothing running, or the RPC failed.
   *
   * The UI anchors its uptime clock to this rather than to when the UI noticed the tunnel,
   * because the UI's lifetime is shorter than the tunnel's.
   */
  coreStartedAt?: number;
};

// ---------------------------------------------------------------------------------------
// Plugin surface
// ---------------------------------------------------------------------------------------

export interface NexusCorePlugin {
  /**
   * Start the tunnel.
   *
   * On Android this may show the system VPN consent dialog on first run; the promise does not
   * resolve until the user answers, and rejects with 'VPN permission denied' if they decline.
   * Treat a rejection as a normal outcome, not an error state.
   *
   * `config` is a complete sing-box configuration. It is passed through untouched — the UI
   * never synthesises or rewrites it (ADR-0002 §2), because ConfigGuard on the native side is
   * what keeps the power policy enforceable.
   */
  start(options: {
    config: string;
    /**
     * Display name of the node, for the foreground notification's body.
     *
     * Passed explicitly because the name lives up here: it comes from the `#fragment` of the
     * subscription link, and the config the core runs has no field for it. When absent the
     * native side derives a fallback from the config (protocol and address) rather than
     * showing a bare "Connected".
     */
    name?: string;
  }): Promise<void>;

  stop(): Promise<void>;

  reload(options: { config: string; name?: string }): Promise<void>;

  /**
   * One-shot snapshot.
   *
   * NOT A POLLING ENDPOINT. Calling this on a timer re-creates above the bridge exactly the
   * wakeup pattern the architecture exists to remove, and does it worse than the stream —
   * each call is a main-thread crossing with no source-side throttle.
   *
   * Two legitimate uses: initial state on mount, and reconciliation on resume (the native
   * layer disconnects the stream while backgrounded, so values go stale). useNexusCore
   * handles both; application code should not need to call this directly.
   */
  getStatus(): Promise<StatusSnapshot>;

  // --- control: one-shot, never streaming ---

  selectOutbound(options: { group: string; outbound: string }): Promise<void>;
  urlTest(options: { group: string }): Promise<void>;

  /**
   * Measure the latency of the RUNNING proxy outbound. Requires the core to be started.
   *
   * Resolves as soon as the test is dispatched, not when it finishes - the number arrives on
   * the "proxyDelay" event. There is exactly one proxy outbound in a generated config, so this
   * measures the selected node and nothing else; it is not a sweep over the server list.
   */
  pingProxy(): Promise<void>;

  /**
   * TCP handshake latency to a batch of proxy endpoints, in milliseconds. `ms: -1` means the
   * handshake did not complete (refused, timed out, or the name did not resolve).
   *
   * Does NOT go through the tunnel and does not disturb it: these sockets run in the app
   * process, which NexusVpnService excludes from the VPN. So this works whether or not a
   * tunnel is up, and measures reachability of the server itself.
   *
   * It does not prove the credentials are valid - a reachable host with a wrong UUID answers
   * the handshake and fails later. Use pingProxy for the node that is actually running.
   */
  tcpPing(options: {
    targets: Array<{ id: string; server: string; port: number }>;
  }): Promise<{ results: Array<{ id: string; ms: number }> }>;
  setClashMode(options: { mode: string }): Promise<void>;
  closeConnections(): Promise<void>;

  /**
   * Pull the bounded log ring (R3). The core keeps 512 lines; there is no live tail by
   * design — a streaming log is a wakeup per line.
   */
  readLogs(options?: { limit?: number }): Promise<{ lines: string[] }>;

  /**
   * Clear the log ring.
   *
   * Clears the HOST-side buffer (LogBuffer in NexusPlugin.kt). libbox's CommandClient exposes
   * no host->core clear, so the core's own ring keeps its contents until it rolls over
   * naturally. In practice this is what a user means by "clear the log view", but do not
   * document it to them as wiping the core's memory, because it does not.
   */
  clearLogs(): Promise<void>;

  /**
   * Open or close the core's log subscription.
   *
   * Call with true when a log screen mounts and false when it unmounts — never at app start.
   * The subscription is what fills the ring that readLogs() reads; leaving it open for the
   * app's lifetime would be a wakeup per log line forever, filling a buffer nobody is looking
   * at. Nothing streams across the bridge either way: lines accumulate natively and the UI
   * fetches them.
   */
  setLogStreaming(options: { enabled: boolean }): Promise<void>;

  // --- subscriptions ---
  //
  // Throttled to 1 Hz IN THE CORE (CommandClientOptions.statusInterval), not here, so an
  // unchanged tick costs nothing rather than being serialised and then discarded. The native
  // layer additionally drops ticks whose values did not change, and disconnects entirely
  // while the WebView is backgrounded.
  //
  // Every handle returned here MUST be removed on unmount.

  addListener(
    eventName: 'status',
    listener: (status: StatusMessage) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'serviceState',
    listener: (event: ServiceStateEvent) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'clashMode',
    listener: (event: ClashModeEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** Result of pingProxy(). `ok: false` with delayMs 0 means the test timed out or failed. */
  addListener(
    eventName: 'proxyDelay',
    listener: (event: { delayMs: number; ok: boolean }) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'openURL',
    listener: (event: { url: string }) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}

/**
 * The web implementation is lazy-loaded so it is never bundled into a native build.
 * Without it, `npm run dev` in a desktop browser throws "not implemented on web" on the
 * first call and the UI is undebuggable outside a device.
 */
export const NexusCore = registerPlugin<NexusCorePlugin>('NexusCore', {
  web: () => import('./plugin.web').then((m) => new m.NexusCoreWeb()),
});
