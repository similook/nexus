/**
 * The core contract, as types only.
 *
 * This is hop ① of core/docs/ipc-boundary.md — the boundary between the UI and whatever is
 * actually running the tunnel. Every signature below is shaped by that hop being expensive:
 * small payloads, low frequency, nothing list-shaped.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS FILE NO LONGER REGISTERS ANYTHING
 *
 * The Android copy of this file ends with `registerPlugin<NexusCorePlugin>('NexusCore', ...)`,
 * which binds it to Capacitor. That was fine while Capacitor was the only host. It is not fine
 * now: this tree is also compiled into a desktop shell that talks to a privileged daemon over
 * a pipe, and has no Capacitor in it at all.
 *
 * So the contract and the transport are separated. This file declares WHAT the core can do.
 * Each shell provides an object that does it, through `PlatformPort` in ../platform.ts:
 *
 *   Android  → registerPlugin('NexusCore')          (clients/web, unchanged)
 *   Desktop  → framed JSON over a pipe to nexusd    (ADR-0003 §4.2)
 *   Browser  → the stub in ./plugin.web.ts          (development)
 *
 * Nothing here imports a transport, so nothing here can drag one into a bundle that does not
 * want it.
 * ---------------------------------------------------------------------------------------
 *
 * Mirrors NexusPlugin.kt on Android and the IPC server in core/desktop/ipc on desktop. When a
 * method is added there, add it here; a mismatch fails at runtime with an unhelpful error, not
 * at build time. ADR-0003 §4.2 is the plan for closing that gap on the desktop side, where the
 * host forwards opaque bytes and the contract lives in exactly two places rather than three.
 */

/**
 * The handle returned by a subscription.
 *
 * Structurally identical to Capacitor's `PluginListenerHandle`, declared here so this module
 * has no Capacitor import. The Android shell's Capacitor handles satisfy it as-is.
 */
export interface PluginListenerHandle {
  remove: () => Promise<void>;
}

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
  /**
   * Desktop only: the routing mode the running tunnel is applying, and every mode it can switch
   * to without reconnecting — the same values as the last 'clashMode' event, repeated so a page
   * that missed that event reconciles from getStatus(). Absent while no tunnel is running, and
   * always absent on Android.
   */
  clashMode?: string;
  clashModes?: string[];
}

export interface ServiceStateEvent {
  state: ServiceState;
  reason?: string;
}

export interface ClashModeEvent {
  modes?: string[];
  current: string;
}

/**
 * Qualitative state of the DEVICE'S OWN NETWORK, as the platform reports it.
 *
 * Ported from clients/web (v1.3.0). Each shell answers from its own OS:
 *
 *   Android  ConnectivityManager / NetworkCapabilities, filtered NOT_VPN (NexusPlugin.kt)
 *   Desktop  Windows: the OS's own connectivity verdict (NCSI, through WinRT), hardware
 *            adapters only (clients/desktop/src-tauri/src/network.rs); 'unknown' elsewhere
 *   Browser  always 'unknown' (core/plugin.web.ts)
 *
 * READ THIS BEFORE USING IT IN THE UI.
 *
 * This describes the machine's underlying link. It is NOT a measurement of anything, and it is
 * NOT a statement about the tunnel:
 *
 *   * it is not speed, bandwidth, latency, packet loss or signal strength - none of those are
 *     measured and no packet is sent;
 *   * 'ok' means the OS validated the LINK, not that the proxy is reachable. A perfect
 *     connection with a blocked server reports 'ok'. Never label this as VPN health.
 *
 * 'unverified' deserves its name. It means the OS's own connectivity probe did not confirm
 * internet access - which on a censored network can happen while the connection works fine,
 * because the probe endpoint itself may be blocked. Render it as amber and uncertain, never
 * as red, "poor", "slow" or "unstable".
 *
 * 'unknown' is the honest answer before the first reading arrives, when the platform cannot
 * tell (Android below API 23), and wherever a shell has no native source yet.
 */
export type NetworkStatusState =
  | 'ok'
  | 'unverified'
  | 'captive_portal'
  | 'no_network'
  | 'unknown';

export type NetworkTransport = 'wifi' | 'cellular' | 'ethernet' | 'unknown';

export interface NetworkStatusEvent {
  state: NetworkStatusState;
  transport: NetworkTransport;
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
// start() waiting on the OS
// ---------------------------------------------------------------------------------------

/**
 * A start() rejection that means "waiting for the OS to grant permission", not "failed".
 *
 * The desktop port rejects start() this way while Windows asks for administrator rights. That
 * prompt waits as long as the user does, which useNexusCore's 10 s startup watchdog would report
 * as a timeout; rejecting ends the watchdog, and the message says what to do. The outcome arrives
 * later as serviceState: 'starting' then 'started', or 'stopped' - with a reason if something
 * failed, without one if the prompt was declined. Android never produces it.
 */
export function awaitingApproval(message: string): Error {
  return Object.assign(new Error(message), { awaitingApproval: true });
}

export function isAwaitingApproval(error: unknown): boolean {
  return (
    error instanceof Error && (error as { awaitingApproval?: unknown }).awaitingApproval === true
  );
}

/**
 * Outcome of one server's probe (probeServers). Only these categories ever cross the bridge;
 * raw errors name hosts and addresses and stay in the core.
 */
export type ServerProbeStatus =
  | 'ok'
  | 'timeout'
  | 'refused'
  | 'unreachable'
  | 'dns_failed'
  | 'handshake_failed'
  | 'rejected'
  | 'config_invalid'
  | 'cancelled'
  | 'failed';

/** One server's result from probeServers. `delayMs` is meaningful only when status is 'ok'. */
export interface ServerProbeEvent {
  runId: number;
  serverId: string;
  /** Echo of the fingerprint the caller sent with this server's config. */
  fingerprint: string;
  status: ServerProbeStatus;
  delayMs: number;
}

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

  /**
   * One-shot snapshot of the device's network state. See NetworkStatusState.
   *
   * NOT A POLLING ENDPOINT, for the same reason getStatus() is not. Live values arrive on the
   * 'networkStatus' listener, which the platform pushes; there is no timer in this path on
   * either side of the bridge and there must not be one.
   *
   * Two legitimate uses: initial state on mount, and reconciliation when the UI becomes
   * visible again - a shell's native monitor may stop observing while the UI is hidden (R1),
   * so the last value is stale by however long it was away.
   */
  getNetworkStatus(): Promise<NetworkStatusEvent>;

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

  /**
   * Delay for EVERY server: each one's own config gets a full handshake and a URL test in a
   * short-lived core instance beside the tunnel - no inbound, no TUN, no listener; the running
   * tunnel and its server are never touched, so this works connected or not. On desktop the
   * daemon keeps these probes off an active tunnel (core/desktop/ipc/probe.go).
   *
   * Resolves at once. Results stream as "serverProbe" events, one per server, and the run ends
   * with exactly one "serverProbeDone". A new run cancels the previous one. User-initiated only
   * (Test All): never on a timer, on resume or while the UI is hidden.
   */
  probeServers(options: {
    runId: number;
    targets: Array<{ id: string; fingerprint: string; config: string }>;
  }): Promise<{ runId: number }>;

  /** Cancel run `runId`. Its "serverProbeDone" (cancelled: true) follows. */
  cancelProbe(options: { runId: number }): Promise<void>;
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

  /** One server's probeServers result. */
  addListener(
    eventName: 'serverProbe',
    listener: (event: ServerProbeEvent) => void,
  ): Promise<PluginListenerHandle>;

  /** A probeServers run ended: every result it will ever send has been sent. */
  addListener(
    eventName: 'serverProbeDone',
    listener: (event: { runId: number; cancelled: boolean }) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Device network state changed.
   *
   * Push-driven by the platform and deduplicated natively, so this fires on actual change -
   * typically a handful of times a session, not on a cadence. Observed only while the UI is
   * visible.
   */
  addListener(
    eventName: 'networkStatus',
    listener: (event: NetworkStatusEvent) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: 'openURL',
    listener: (event: { url: string }) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
