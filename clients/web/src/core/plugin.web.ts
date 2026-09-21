import { WebPlugin } from '@capacitor/core';
import type {
  ClashModeEvent,
  NetworkStatusEvent,
  NexusCorePlugin,
  ServiceState,
  StatusMessage,
  StatusSnapshot,
} from './plugin';

/**
 * Browser stub, so the UI can be developed and debugged outside a device.
 *
 * It simulates the CONTRACT, not the core: same 1 Hz cadence, same state transitions, same
 * units. Specifically it reproduces the two behaviours that catch people out:
 *
 *   * a delay before 'started' (the real one waits on VPN consent and a handshake), so
 *     "connecting" is a state you can actually see and style rather than a frame that flashes
 *   * status ticks that do not fire when nothing changed, matching the native dedup — if the
 *     UI depends on a tick arriving every second, it will break on device, and it should
 *     break here first
 *
 * It is NOT a mock to build features against. Anything that looks right here and wrong on a
 * device is the device telling the truth.
 */
export class NexusCoreWeb extends WebPlugin implements NexusCorePlugin {
  private state: ServiceState = 'stopped';
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: StatusMessage = emptyStatus();

  async start(_options: { config: string; name?: string }): Promise<void> {
    if (this.state !== 'stopped') return;

    this.setState('starting');
    this.log('info', 'nexus core daemon initialized');
    this.log('info', 'routing rules loaded: bypass private, proxy default');
    await delay(900);
    this.setState('started');
    this.log('info', 'tun interface up, stack=system, mtu=9000');

    this.last = emptyStatus();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  async stop(): Promise<void> {
    this.log('warn', 'tunnel closed by user');
    this.clearTimer();
    this.last = emptyStatus();
    this.setState('stopped');
  }

  async reload(options: { config: string; name?: string }): Promise<void> {
    await this.stop();
    await this.start(options);
  }

  async getStatus(): Promise<StatusSnapshot> {
    return { state: this.state, ...this.last };
  }

  /**
   * Always 'unknown' in the browser, deliberately.
   *
   * navigator.onLine exists but answers a different question - it is true whenever an
   * interface is up, including one that reaches nothing - and navigator.connection is a
   * bandwidth ESTIMATE, which is exactly the kind of invented number this feature refuses to
   * show. There is no browser API for "did the system validate internet access", so the
   * honest stub reports that it does not know.
   */
  async getNetworkStatus(): Promise<NetworkStatusEvent> {
    return { state: 'unknown', transport: 'unknown' };
  }

  async selectOutbound(_options: { group: string; outbound: string }): Promise<void> {}
  async urlTest(_options: { group: string }): Promise<void> {}
  async pingProxy(): Promise<void> {}
  async tcpPing(options: {
    targets: Array<{ id: string; server: string; port: number }>;
  }): Promise<{ results: Array<{ id: string; ms: number }> }> {
    // The browser stub cannot open a TCP socket. Report "untested" rather than inventing a
    // plausible number, which would make the web build lie about something measurable.
    return { results: options.targets.map((t) => ({ id: t.id, ms: -1 })) };
  }
  async closeConnections(): Promise<void> {}

  async setClashMode(options: { mode: string }): Promise<void> {
    const event: ClashModeEvent = { current: options.mode };
    this.notifyListeners('clashMode', event);
  }

  async readLogs(options?: { limit?: number }): Promise<{ lines: string[] }> {
    const limit = options?.limit ?? 200;
    return { lines: this.logs.slice(-limit) };
  }

  async clearLogs(): Promise<void> {
    this.logs = [];
  }

  /** No-op in the stub: the fake core writes into its ring unconditionally. */
  async setLogStreaming(_options: { enabled: boolean }): Promise<void> {}

  /**
   * Bounded log ring, mirroring the real core's LogMaxLines = 512.
   *
   * Lines accumulate while connected, so the Logs view shows more on each fetch — which is
   * what makes a PULL model feel live without a polling timer anywhere.
   */
  private logs: string[] = [];

  private log(level: 'info' | 'warn' | 'debug' | 'error', message: string): void {
    const stamp = new Date().toTimeString().slice(0, 8);
    if (this.logs.length >= 512) this.logs.shift();
    this.logs.push(`${stamp} [${level}] ${message}`);
  }

  private tick(): void {
    // Idle roughly a third of the time, so the dedup path gets exercised in development.
    const idle = Math.random() < 0.3;
    const downlink = idle ? 0 : Math.round(Math.random() * 4_000_000);
    const uplink = idle ? 0 : Math.round(Math.random() * 600_000);

    const next: StatusMessage = {
      trafficAvailable: true,
      uplink,
      downlink,
      uplinkTotal: this.last.uplinkTotal + uplink,
      downlinkTotal: this.last.downlinkTotal + downlink,
      connectionsIn: 0,
      connectionsOut: idle ? this.last.connectionsOut : Math.round(Math.random() * 40),
      memory: 28_000_000,
      goroutines: 120,
    };

    const changed =
      next.uplink !== this.last.uplink ||
      next.downlink !== this.last.downlink ||
      next.connectionsOut !== this.last.connectionsOut;

    this.last = next;
    if (changed) {
      this.notifyListeners('status', next);
      if (!idle && Math.random() < 0.35) {
        this.log('debug', `outbound: ${next.connectionsOut} connections, ${(next.downlink / 1_000_000).toFixed(2)} MB/s down`);
      }
    }
  }

  private setState(state: ServiceState): void {
    this.state = state;
    this.notifyListeners('serviceState', { state });
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function emptyStatus(): StatusMessage {
  return {
    trafficAvailable: true,
    uplink: 0,
    downlink: 0,
    uplinkTotal: 0,
    downlinkTotal: 0,
    connectionsIn: 0,
    connectionsOut: 0,
    memory: 0,
    goroutines: 0,
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
