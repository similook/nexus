import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { awaitingApproval, composeRouting, loadRoutingMode } from '@nexus/shared';
import type {
  NetworkStatusEvent,
  NexusCorePlugin,
  PlatformPort,
  PluginListenerHandle,
  ServiceStateEvent,
  StatusSnapshot,
} from '@nexus/shared';

/**
 * The shipping desktop port: the real UI, driving `nexusd` (ADR-0003 Phase 4).
 *
 * =========================================================================================
 * WHO KNOWS THE PROTOCOL
 *
 * ADR-0003 §4.2: the Rust host forwards OPAQUE BYTES. It reads a line from the daemon and
 * emits it; it writes a line it was handed. It has no structs for any of this, so the contract
 * lives in exactly two places — this file and core/desktop/ipc/protocol.go — instead of three.
 *
 * The wire (protocol.go is the reference):
 *
 *   GUI → daemon   {"id":7,"method":"getStatus","params":{...}}\n
 *   daemon → GUI   {"id":7,"ok":true,"data":{...}}\n        a reply, matched by id
 *                  {"event":"status","data":{...}}\n         a push
 *                  {"event":"hello","data":{"protocol":1}}   always first
 * =========================================================================================
 *
 * WHAT THE DAEMON DOES NOT IMPLEMENT, AND WHY THAT IS FINE
 *
 * protocol.go implements the 12 methods the UI calls. The contract also declares reload,
 * selectOutbound and urlTest, which have zero call sites in clients/shared — a privileged
 * daemon should not grow surface nobody uses. They reject here with a message that says so,
 * rather than resolving and pretending. (setClashMode and closeConnections were on that list
 * until the routing selector gave them a caller.)
 *
 * ROUTING (desktop only)
 *
 * start() composes the user's routing — VPN or Direct, core/routing.ts — onto the node's
 * config, so both modes are compiled in and the daemon can switch between them live with
 * setClashMode. The node's stored config itself is never modified.
 *
 * getNetworkStatus and the networkStatus event never reach the daemon: device network state is a
 * property of the machine the GUI runs on, not of the tunnel. The Rust host reads it from the OS
 * (src-tauri/src/network.rs — Windows' own connectivity verdict, hardware adapters only) and
 * answers 'unknown' wherever it has no source, so the card reads "Network status unavailable"
 * instead of inventing a state.
 *
 * ELEVATION (Windows)
 *
 * The app runs nexusd itself, not elevated (src-tauri/src/daemon.rs). The first start() of a
 * session asks the host to elevate it, which shows Windows' consent prompt, and rejects at once
 * with awaitingApproval: useNexusCore stays 'connecting' with "Approve the Windows prompt…",
 * outside its 10 s watchdog, for as long as the user takes. Approved: this links to the
 * elevated daemon and sends the start, whose outcome is reported like any other. Declined: a
 * 'stopped' without a reason — back to Disconnected, as a declined consent dialog is on Android.
 * Never 'connected' unless nexusd started a tunnel and said so.
 */

/** Must match core/desktop/ipc/protocol.go `Protocol`. */
const PROTOCOL = 1;

/** How long a call waits for its reply. start/stop bring a TUN device up or down. */
const TIMEOUT_MS = 10_000;
const LIFECYCLE_TIMEOUT_MS = 30_000;

/** How long a call made before the link is up waits for it. */
const CONNECT_WAIT_MS = 4_000;

/** Reconnect backoff: 0.5 s doubling to 8 s. The daemon is the source of truth for state. */
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 8_000;

/** Shown while Windows' administrator prompt is up. */
const APPROVE_PROMPT =
  'Approve the Windows prompt to connect. Nexus needs administrator rights to create its network adapter.';

/** The host's answer to nexus_daemon_status (src-tauri/src/daemon.rs). */
interface DaemonStatus {
  /** The app runs this daemon. False for a developer's (NEXUS_SOCKET): nothing to elevate. */
  managed: boolean;
  /** It runs as administrator, so a start can create the TUN. */
  elevated: boolean;
}

type StartParams = { config: string; name?: string };

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WireFrame {
  id?: number;
  ok?: boolean;
  error?: string;
  event?: string;
  data?: unknown;
}

type Listener = (payload: unknown) => void;

class DaemonCore implements NexusCorePlugin {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  /** True once `hello` arrived and its protocol version was accepted. */
  private linked = false;
  /** A connect is in flight: from invoking nexus_connect until `hello`, a failure or a close. */
  private connecting = false;
  /**
   * The window cannot be seen (R1, ADR-0003 §4.1). The link is dropped while this holds and
   * reopened only on demand — a tray Quit while hidden still has to reach the daemon to stop.
   */
  private hidden = false;
  /** Set when the daemon speaks a protocol we do not; nothing is retried after that. */
  private fatal: string | null = null;
  private waiters: Array<() => void> = [];
  private backoff = BACKOFF_START_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConnectError = '';

  /** Elevation (see the header): in flight, the prompt still up, and the start to send after. */
  private elevation: Promise<void> | null = null;
  private awaitingPrompt = false;
  private pendingStart: StartParams | null = null;
  /** The start that follows an approval is in flight. See onFrame. */
  private startingElevated = false;

  /**
   * The Test All probe run this window started and has not seen end. Hiding the window (R1) or
   * losing the daemon ends it here as cancelled - the desktop form of Android cancelling a probe
   * in handleOnPause - so the Servers screen never waits on a run whose events cannot reach it.
   */
  private probeRunId: number | null = null;

  constructor() {
    // Subscribe to the Rust host's two events once, before the first connect, so no frame can
    // arrive with nobody listening.
    void listen<string>('nexus://frame', (event) => this.onFrame(event.payload));
    void listen('nexus://closed', () => this.onClosed());
    // From the host itself, not the daemon; already deduplicated there, and withheld while the
    // window cannot be seen (R1).
    void listen<NetworkStatusEvent>('nexus://network-status', (event) =>
      this.notify('networkStatus', event.payload),
    );
    void this.connect();
  }

  // ---- visibility (R1) ---------------------------------------------------------------------

  /**
   * Follow the window. Hidden or minimised: drop the link, so nothing streams to a window
   * nobody is looking at — the desktop form of Android's handleOnPause disconnect. Visible
   * again: reconnect; the daemon greets us and sends its current state unprompted, and
   * useNexusCore reconciles on the same signal. The tunnel is untouched throughout: it
   * belongs to nexusd.
   */
  setVisible(visible: boolean): void {
    this.hidden = !visible;
    if (visible) {
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.backoff = BACKOFF_START_MS;
      void this.connect();
    } else {
      this.endProbe(true);
      this.suspendIfIdle();
    }
  }

  /** End the open probe run as cancelled: tell the daemon (when asked to) and the UI. */
  private endProbe(tellDaemon: boolean): void {
    const runId = this.probeRunId;
    if (runId === null) return;
    this.probeRunId = null;
    // The daemon cancels a departing client's run on its own as well; asking is the clean path.
    if (tellDaemon) void this.request('cancelProbe', { runId }).catch(() => {});
    this.notify('serverProbeDone', { runId, cancelled: true });
  }

  /** Drop the link if the window is hidden and nothing is waiting on a reply. */
  private suspendIfIdle(): void {
    if (!this.hidden || this.pending.size > 0) return;
    if (!this.linked && !this.connecting) return;
    this.linked = false;
    this.connecting = false;
    void invoke('nexus_disconnect').catch(() => {});
  }

  // ---- transport --------------------------------------------------------------------------

  private async connect(): Promise<void> {
    this.reconnectTimer = null;
    if (this.fatal !== null || this.linked || this.connecting) return;
    this.connecting = true;
    try {
      await invoke('nexus_connect');
      // Linked is set by `hello`, not here: a socket that accepted the connection but never
      // greets us is not a daemon we can drive.
    } catch (error) {
      this.connecting = false;
      this.lastConnectError = String(error);
      // A hidden window does not retry on its own; being shown again, or a request, will.
      if (!this.hidden) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.fatal !== null || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  private onFrame(line: string): void {
    let frame: WireFrame;
    try {
      frame = JSON.parse(line) as WireFrame;
    } catch {
      return; // A line we cannot parse is not a frame; the daemon never sends one.
    }

    if (frame.event === 'hello') {
      const protocol = (frame.data as { protocol?: number } | undefined)?.protocol;
      if (protocol !== PROTOCOL) {
        this.fatal =
          `nexusd speaks protocol ${String(protocol)}, this app speaks ${PROTOCOL}. ` +
          'Update whichever is older.';
        this.failAll(this.fatal);
        return;
      }
      this.connecting = false;
      this.linked = true;
      this.backoff = BACKOFF_START_MS;
      for (const wake of this.waiters.splice(0)) wake();
      // Opened while hidden? Then it was for a request, and the woken request registers its
      // reply only after this returns — so check once that has happened, not now.
      if (this.hidden) setTimeout(() => this.suspendIfIdle(), 0);
      return;
    }

    if (typeof frame.event === 'string') {
      // A daemon elevated for a start greets us with its own state, 'stopped', before that
      // start reaches it. True of the daemon, already superseded for the user, and forwarding
      // it would flash Disconnected between the approval and the start. A stop with a reason
      // is a failure and always goes through.
      if (this.startingElevated && frame.event === 'serviceState') {
        const state = frame.data as ServiceStateEvent | undefined;
        if (state?.state === 'stopped' && !state.reason) return;
      }
      if (frame.event === 'serverProbeDone') {
        const done = frame.data as { runId?: number } | undefined;
        if (done?.runId === this.probeRunId) this.probeRunId = null;
      }
      this.notify(frame.event, frame.data);
      return;
    }

    if (typeof frame.id === 'number') {
      const call = this.pending.get(frame.id);
      if (call === undefined) return;
      this.pending.delete(frame.id);
      clearTimeout(call.timer);
      if (frame.ok === true) call.resolve(frame.data);
      else call.reject(new Error(frame.error || 'nexusd refused the request'));
      this.suspendIfIdle();
    }
  }

  /** The daemon went away (or restarted). Not called for our own R1 disconnect. */
  private onClosed(): void {
    this.linked = false;
    this.connecting = false;
    this.failAll('lost the connection to nexusd');
    this.endProbe(false);
    // "unknown", not "stopped": the tunnel may well still be up — the daemon owns it and keeps
    // running without us. useNexusCore holds its current state for 'unknown', and the daemon
    // sends the real state unprompted the moment we reconnect.
    this.notify('serviceState', { state: 'unknown' } satisfies ServiceStateEvent);
    if (!this.hidden) this.scheduleReconnect();
  }

  private failAll(reason: string): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** Resolve once the link is up, or reject with the reason it is not. */
  private waitForLink(): Promise<void> {
    if (this.fatal !== null) return Promise.reject(new Error(this.fatal));
    if (this.linked) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        reject(
          new Error(
            this.fatal ??
              `nexusd is not running or not reachable${this.lastConnectError ? ` (${this.lastConnectError})` : ''}`,
          ),
        );
      }, CONNECT_WAIT_MS);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }

  private async request<T>(method: string, params?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
    // On demand: while hidden the link is down (R1), but a request — a tray Quit's stop — must
    // still reach the daemon. suspendIfIdle drops it again once nothing is waiting.
    if (!this.linked) void this.connect();
    await this.waitForLink();
    const id = this.nextId++;
    const frame = JSON.stringify(params === undefined ? { id, method } : { id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`nexusd did not answer ${method} within ${timeoutMs / 1000} s`));
        this.suspendIfIdle();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      invoke('nexus_send', { frame }).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(String(error)));
        this.suspendIfIdle();
      });
    });
  }

  // ---- listeners ---------------------------------------------------------------------------

  private notify(eventName: string, payload: unknown): void {
    const set = this.listeners.get(eventName);
    if (set === undefined) return;
    for (const listener of [...set]) listener(payload); // copy: a handler may unsubscribe itself
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addListener(eventName: string, listener: (payload: any) => void): Promise<PluginListenerHandle> {
    let set = this.listeners.get(eventName);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(eventName, set);
    }
    set.add(listener);
    return Promise.resolve({
      remove: () => {
        set.delete(listener);
        return Promise.resolve();
      },
    });
  }

  removeAllListeners(): Promise<void> {
    this.listeners.clear();
    return Promise.resolve();
  }

  // ---- elevation (Windows) -------------------------------------------------------------------

  /** Ask the host for an elevated daemon, then send the start the user asked for. */
  private async elevate(): Promise<void> {
    this.awaitingPrompt = true;
    try {
      await invoke('nexus_elevate');
    } catch (error) {
      // The host has brought the plain daemon back. Declined is the user's choice and ends
      // quietly; anything else is shown. Either way: not connected, and never said to be.
      this.pendingStart = null;
      const message = String(error);
      this.relink();
      this.notify('serviceState', {
        state: 'stopped',
        ...(/^declined/.test(message) ? {} : { reason: message }),
      } satisfies ServiceStateEvent);
      return;
    } finally {
      this.awaitingPrompt = false;
    }

    // The plain daemon's link died with it; the elevated one answers on the same socket now.
    this.relink();
    const params = this.pendingStart;
    this.pendingStart = null;
    if (params === null) return; // cancelled while the prompt was up

    this.notify('serviceState', { state: 'starting' } satisfies ServiceStateEvent);
    this.startingElevated = true;
    try {
      await this.request('start', params, LIFECYCLE_TIMEOUT_MS);
    } catch (error) {
      // nexusd reports its own failures as a 'stopped' with a reason; this is for the ones it
      // cannot report — no link, no answer.
      this.notify('serviceState', {
        state: 'stopped',
        reason: error instanceof Error ? error.message : String(error),
      } satisfies ServiceStateEvent);
    } finally {
      this.startingElevated = false;
    }
  }

  /** Connect now, not on the backoff timer. */
  private relink(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = BACKOFF_START_MS;
    void this.connect();
  }

  // ---- the methods nexusd implements --------------------------------------------------------

  async start(options: StartParams): Promise<void> {
    const params = { ...options, config: composeRouting(options.config, loadRoutingMode()) };

    // A TUN needs the daemon elevated. The prompt that does it waits for the user, so it runs
    // outside this call and the watchdog: reject now with what to do (see the header).
    const daemon = await invoke<DaemonStatus>('nexus_daemon_status');
    if (daemon.managed && !daemon.elevated) {
      this.pendingStart = params;
      if (this.elevation === null) {
        this.elevation = this.elevate().finally(() => {
          this.elevation = null;
        });
      }
      throw awaitingApproval(APPROVE_PROMPT);
    }

    await this.request('start', params, LIFECYCLE_TIMEOUT_MS);
  }

  async stop(): Promise<void> {
    this.startingElevated = false;
    if (this.awaitingPrompt) {
      // Cancel, or Quit, while the prompt is up. Nothing is running to stop - the plain daemon
      // made way for the elevated one - and now nothing will start: the prompt cannot be
      // withdrawn, but its answer no longer leads to a start.
      this.pendingStart = null;
      return;
    }
    await this.request('stop', undefined, LIFECYCLE_TIMEOUT_MS);
  }

  async getStatus(): Promise<StatusSnapshot> {
    // While the link is down the honest answer is "unknown" — the daemon may still hold a
    // running tunnel. useNexusCore has a specific branch for it (see plugin.ts ServiceState).
    if (!this.linked) return { state: 'unknown' };
    return this.request<StatusSnapshot>('getStatus');
  }

  async pingProxy(): Promise<void> {
    await this.request('pingProxy');
  }

  tcpPing(options: {
    targets: Array<{ id: string; server: string; port: number }>;
  }): Promise<{ results: Array<{ id: string; ms: number }> }> {
    return this.request('tcpPing', options);
  }

  /** Test All's per-server Delay. Results arrive as serverProbe / serverProbeDone events. */
  async probeServers(options: {
    runId: number;
    targets: Array<{ id: string; fingerprint: string; config: string }>;
  }): Promise<{ runId: number }> {
    this.probeRunId = options.runId;
    try {
      return await this.request<{ runId: number }>('probeServers', options);
    } catch (error) {
      if (this.probeRunId === options.runId) this.probeRunId = null;
      throw error;
    }
  }

  async cancelProbe(options: { runId: number }): Promise<void> {
    if (this.probeRunId === options.runId) this.probeRunId = null;
    await this.request('cancelProbe', options);
  }

  readLogs(options?: { limit?: number }): Promise<{ lines: string[] }> {
    return this.request('readLogs', options ?? {});
  }

  async clearLogs(): Promise<void> {
    await this.request('clearLogs');
  }

  async setLogStreaming(options: { enabled: boolean }): Promise<void> {
    await this.request('setLogStreaming', options);
  }

  /** Switch routing live. Confirmed by the clashMode event the daemon pushes, not by this. */
  async setClashMode(options: { mode: string }): Promise<void> {
    await this.request('setClashMode', options);
  }

  async closeConnections(): Promise<void> {
    await this.request('closeConnections');
  }

  // ---- answered by the host, not the daemon -------------------------------------------------

  getNetworkStatus(): Promise<NetworkStatusEvent> {
    return invoke<NetworkStatusEvent>('nexus_network_status');
  }

  // ---- declared by the contract, deliberately not implemented by nexusd ---------------------

  reload(_options: { config: string; name?: string }): Promise<void> {
    return notImplemented('reload');
  }
  selectOutbound(_options: { group: string; outbound: string }): Promise<void> {
    return notImplemented('selectOutbound');
  }
  urlTest(_options: { group: string }): Promise<void> {
    return notImplemented('urlTest');
  }
}

function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    new Error(`${method} is not implemented by nexusd — the desktop UI never calls it`),
  );
}

/** Copy through a temporary, off-screen textarea and the legacy copy command. */
function copyWithSelection(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/**
 * How long Quit waits for the daemon to confirm the stop. Bounded, because a daemon that is
 * not running must not turn Quit into a hang; the host has its own, longer, fallback.
 */
const QUIT_STOP_TIMEOUT_MS = 5_000;

/**
 * Subscription fetch timeouts: Android's (CapacitorHttp connectTimeout and readTimeout, 15 s
 * each, in clients/web/src/core/subscription.ts). The read timeout bounds SILENCE, not the whole
 * download, as it does there: a slow link that keeps delivering is never cut off.
 */
const HTTP_CONNECT_TIMEOUT_MS = 15_000;
const HTTP_READ_TIMEOUT_MS = 15_000;

/** The body as UTF-8 text, calling `onProgress` for every chunk that arrives. */
async function readText(response: Response, onProgress: () => void): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    onProgress();
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * The plugin reports every transport failure (DNS, refused, reset, TLS, connect timeout) as
 * reqwest's "error sending request for url (<the URL>)": no cause, and the URL carries the
 * subscription token. Say what is known, and never echo the link into a toast.
 */
function describeHttpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^error sending request/i.test(message)) {
    return 'connection failed (unreachable, refused, or an untrusted certificate)';
  }
  // The webview's URL parser refused it (new Request, inside the plugin): nothing was sent.
  if (/Failed to parse URL/i.test(message)) return 'the link is not a valid URL';
  return message.replace(/https?:\/\/\S+/gi, '<link>');
}

export function createTauriPort(): PlatformPort {
  const core = new DaemonCore();

  // QUIT DISCONNECTS FIRST (ADR-0003 §4.3). The tray asks; the host cannot send `stop` itself
  // because it does not speak the protocol (§4.2). `stop` is idempotent in nexusd, so this is
  // safe whether or not a tunnel is up. A failure is swallowed deliberately - the user asked to
  // quit, and a daemon that cannot be reached has nothing of ours to stop.
  void listen('nexus://quit-requested', async () => {
    try {
      await Promise.race([
        core.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, QUIT_STOP_TIMEOUT_MS)),
      ]);
    } catch {
      // best effort
    }
    await invoke('nexus_quit');
  });

  // R1 (ADR-0003 §4.1): the host reports real window visibility — hidden to the tray or
  // minimised is "not visible" — and the core drops its daemon link until it is visible again.
  void listen<boolean>('nexus://visibility', (event) => core.setVisible(event.payload));

  return {
    core,

    /**
     * Native HTTP through the Tauri HTTP plugin (reqwest + rustls in the host), which is what
     * platform.ts specifies: no CORS, no mixed-content block on http://, and the User-Agent
     * subscription.ts sets goes out as is. The scope (capabilities/default.json) is any http(s)
     * URL, as on Android. Certificates are always verified; there is no switch to turn that off.
     */
    http: {
      async get({ url, headers }) {
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        let allowedMs = 0;
        const allowSilence = (ms: number) => {
          allowedMs = ms;
          clearTimeout(timer);
          timer = setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, ms);
        };

        try {
          // Until the headers arrive: connecting (also bounded in the host) plus the first read.
          allowSilence(HTTP_CONNECT_TIMEOUT_MS + HTTP_READ_TIMEOUT_MS);
          const response = await nativeFetch(url, {
            method: 'GET',
            headers,
            connectTimeout: HTTP_CONNECT_TIMEOUT_MS,
            signal: abort.signal,
          });
          allowSilence(HTTP_READ_TIMEOUT_MS);
          const data = await readText(response, () => allowSilence(HTTP_READ_TIMEOUT_MS));

          const responseHeaders: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            responseHeaders[name] = value;
          });
          return { status: response.status, data, headers: responseHeaders };
        } catch (error) {
          if (timedOut) throw new Error(`no response for ${allowedMs / 1000} s`);
          throw new Error(describeHttpError(error));
        } finally {
          clearTimeout(timer);
        }
      },
    },

    // A desktop webview has neither the secure-context problem nor the user-activation window
    // that forced Android onto a native clipboard (clients/desktop/README.md).
    clipboard: {
      async write(text) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // The async API can be refused (clipboard permission policy). The legacy copy command
          // still works on the same click; if it fails too, the caller shows "Could not copy".
          if (!copyWithSelection(text)) throw new Error('copy refused');
        }
      },
    },

    // Real window visibility from the host: hidden to the tray, minimised and restored all
    // arrive here, which `document.visibilityState` does not reliably report for a desktop
    // window. Drives the shared hooks' R1 behaviour — reconcile on return, stop polling while
    // away — from the same signal the core uses to drop its link.
    appState: {
      subscribe(onVisibilityChange) {
        let unlisten: (() => void) | null = null;
        let cancelled = false;
        void listen<boolean>('nexus://visibility', (event) => onVisibilityChange(event.payload)).then(
          (off) => {
            if (cancelled) off();
            else unlisten = off;
          },
        );
        return () => {
          cancelled = true;
          unlisten?.();
        };
      },
    },

    isStub: false,
    name: 'desktop',
    routing: true,
  };
}
