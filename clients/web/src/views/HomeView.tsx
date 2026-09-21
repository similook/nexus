import { useNexus } from '../core/NexusProvider';
import { formatSpeedMB, formatTotal, formatUptime } from '../core/format';
import { isQuicProtocol, type ServerNode } from '../data/servers';
import { AdBanner } from '../components/AdBanner';
import { useLivePing } from '../core/useLivePing';
import { useNetworkStatus } from '../core/useNetworkStatus';
import type { NetworkStatusState, NetworkTransport } from '../core/plugin';
import { pingTone } from '../data/servers';

/**
 * Home view.
 *
 * Element ids from the mockup map onto this hook as follows:
 *
 *   #connect-btn, #btn-label          -> toggle(), connection
 *   #connection-status-title / -sub   -> connection
 *   #uptime-container / #uptime-text  -> uptimeSeconds
 *   #download-speed-val / -total      -> downlink / downlinkTotal
 *   #upload-speed-val   / -total      -> uplink   / uplinkTotal
 *   #header-status-dot / -text        -> moved to the app Header in App.tsx
 *
 * The mockup's `speedInterval` and `uptimeInterval` must be DELETED, not ported. They exist
 * to fake data; the real values arrive on the 1 Hz status listener, and re-adding a polling
 * timer above the bridge undoes the design (see useNexusCore.ts).
 */

export function HomeView({ node }: { node: ServerNode | null }) {
  // Polled only while this screen is in the foreground - see useLivePing.
  const livePing = useLivePing(node);
  // Push-driven, no timer. Describes the PHONE's link, never the tunnel - see plugin.ts.
  const network = useNetworkStatus();
  const {
    connection,
    error,
    downlink,
    uplink,
    downlinkTotal,
    uplinkTotal,
    uptimeSeconds,
    trafficAvailable,
    toggle,
  } = useNexus();

  const isConnected = connection === 'connected';
  const isBusy = connection === 'connecting';

  // 'CANCEL' while busy, not 'CONNECTING'.
  //
  // The button used to be disabled during a connect, so its label only had to describe a
  // state. It is tappable now and performs an abort, so the label has to describe the ACTION -
  // a button that says CONNECTING reads as "wait", which is the opposite of what it does.
  const label = isConnected ? 'DISCONNECT' : isBusy ? 'CANCEL' : 'CONNECT';

  const title = isConnected
    ? 'Connected'
    : isBusy
      ? 'Establishing tunnel… (tap to cancel)'
      : connection === 'error'
        ? 'Connection failed'
        : 'Disconnected';

  const subtitle =
    error ??
    (node === null
      ? 'Add a subscription to get started'
      : isConnected
        ? `Routed via ${node.name}`
        : 'Tap to establish encrypted tunnel');

  return (
    <section id="view-home" role="tabpanel" className="h-full min-h-0 flex flex-col px-5 pt-3 pb-4 overflow-y-auto custom-scroll">
      {/* Active node card */}
      <div className="shrink-0 flex items-center justify-between gap-2 p-3 rounded-2xl bg-brand-surface border border-brand-border mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-xl leading-none">{node?.flag ?? '🌐'}</span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-white truncate">
                {node?.name ?? 'No server selected'}
              </span>
              {node !== null && isQuicProtocol(node.protocol) && (
                <span
                  title="Higher idle battery use — keeps a QUIC connection alive"
                  className="px-1 py-px shrink-0 rounded text-[9px] font-mono font-semibold bg-amber-950/60 border border-amber-800/50 text-amber-400"
                >
                  ⚡
                </span>
              )}
            </span>
            <span className="block text-[10px] text-brand-muted truncate">
              {node === null ? 'Servers tab → Add Subscription' : `${node.country} • ${node.transport}`}
            </span>
          </span>
        </div>
        <span
          className={`text-[11px] font-mono font-medium px-2 py-0.5 shrink-0 rounded-md border transition-colors ${pingTone(
            livePing,
          )}`}
        >
          {livePing === null ? '--' : `${livePing}ms`}
        </span>
      </div>

      {/*
        Device network.

        The phone's own link, NOT the tunnel and NOT a speed test. Deliberately compact and
        deliberately wordy about uncertainty: a green dot here means Android validated the
        LINK, which is not the same as the proxy being reachable. See NetworkStatusState in
        plugin.ts before changing any of this copy.
      */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 rounded-2xl bg-brand-surface border border-brand-border mb-4">
        <span className="text-[10px] font-semibold text-brand-muted uppercase tracking-wider shrink-0">
          Device network
        </span>
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${networkTone(network.state)}`} />
          <span className="text-[11px] font-medium text-white truncate">
            {networkLabel(network.state)}
          </span>
          {transportLabel(network.transport) !== null && (
            <span className="text-[10px] font-mono text-brand-muted shrink-0">
              {transportLabel(network.transport)}
            </span>
          )}
        </span>
      </div>

      {/* Connection hub */}
      <div className="flex-1 min-h-[16rem] flex flex-col items-center justify-center py-4">
        <div className="relative flex items-center justify-center">
          {/*
            THREE STATES, THREE LOOKS.
            Previously connected and disconnected were both orange and differed only by border
            opacity and a soft glow, which is not a difference anyone notices on a phone in
            daylight. The state a user must be able to read at a glance is whether their
            traffic is protected, so it gets the strongest treatment in the view.
          */}
          {isConnected && (
            <>
              <span className="absolute w-60 h-60 rounded-full bg-brand-orange/10 blur-2xl" />
              <span className="absolute w-52 h-52 rounded-full border-2 border-brand-orange/50 animate-pulse-ring" />
            </>
          )}
          {isBusy && (
            <span className="absolute w-52 h-52 rounded-full border-2 border-dashed border-brand-orange/40 animate-spin-slow" />
          )}

          {/* #connect-btn */}
          <button
            onClick={() => node !== null && void toggle(node.config, node.name)}
            // NOT disabled while connecting.
            //
            // It used to be `disabled={isBusy || node === null}`, and that was half of why a
            // failed connect could only be escaped by force-killing the app: a start that
            // never completed left the UI in 'connecting' forever, and the one control that
            // could have stopped it was the one the state disabled. The tap never reached
            // toggle(), which already routed 'connecting' to disconnect().
            //
            // The other half was in the hook, where disconnect() early-returned on the same
            // in-flight guard. Both had to go; fixing either alone leaves the button dead.
            //
            // Still disabled with no node, which is a genuine nothing-to-do.
            disabled={node === null}
            aria-busy={isBusy}
            aria-label={label}
            className={`relative z-10 w-44 h-44 rounded-full flex flex-col items-center justify-center
              transition-all duration-500 ease-out border-4 active:scale-95
              disabled:cursor-not-allowed
              ${
                isConnected
                  ? // CONNECTED: filled amber, white on orange, hard glow. Unmistakable.
                    'bg-gradient-to-br from-brand-orange to-brand-orange-dark border-brand-orange-glow text-white shadow-glow-orange'
                  : isBusy
                    ? // CONNECTING: orange outline on the dark surface, pulsing. Reads as
                      // "working on it" rather than either end state.
                      'bg-brand-surface border-brand-orange text-brand-orange shadow-glow-orange-sm animate-pulse'
                    : // DISCONNECTED: neutral. No orange at all, so "off" is not one shade
                      // away from "on". Hover hints that it is still the thing to press.
                      'bg-brand-surface border-brand-border text-slate-400 hover:border-slate-500 hover:text-slate-300 disabled:opacity-50'
              }`}
          >
            <svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" d="M12 3v9" />
              <path strokeLinecap="round" d="M6.4 6.4a8 8 0 1 0 11.2 0" />
            </svg>
            {/* #btn-label */}
            <span className="mt-2 text-xs font-extrabold tracking-widest uppercase">{label}</span>
          </button>
        </div>

        <div className="mt-6 text-center">
          {/* #connection-status-title */}
          <div
            className={`text-base font-bold tracking-tight transition-colors duration-500 ${
              isConnected ? 'text-brand-orange' : isBusy ? 'text-slate-200' : 'text-slate-400'
            }`}
          >
            {title}
          </div>
          {/* #connection-status-sub */}
          <p className={`text-xs mt-0.5 ${error ? 'text-rose-400' : 'text-brand-muted'}`}>{subtitle}</p>

          {/* #uptime-container — hidden unless connected, as in the mockup */}
          {isConnected && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-surface-card border border-brand-border text-[11px] font-mono text-brand-orange">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-pulse" />
              <span>{formatUptime(uptimeSeconds)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Renders nothing unless a promo actually loaded — see AdBanner. */}
      <AdBanner connected={isConnected} />

      {/* Traffic cards */}
      <div className="grid grid-cols-2 gap-3 mb-2 mt-3">
        <MetricCard
          label="Download"
          arrow="↓"
          accent="text-brand-orange bg-brand-orange/15"
          value={trafficAvailable ? formatSpeedMB(downlink) : '—'}
          total={trafficAvailable ? formatTotal(downlinkTotal) : 'unavailable'}
        />
        <MetricCard
          label="Upload"
          arrow="↑"
          accent="text-sky-400 bg-sky-500/15"
          value={trafficAvailable ? formatSpeedMB(uplink) : '—'}
          total={trafficAvailable ? formatTotal(uplinkTotal) : 'unavailable'}
        />
      </div>
    </section>
  );
}

function MetricCard(props: {
  label: string;
  arrow: string;
  accent: string;
  value: string;
  total: string;
}) {
  return (
    <div className="bg-brand-surface border border-brand-border rounded-2xl p-3.5 relative overflow-hidden">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-semibold text-brand-muted uppercase tracking-wider">
          {props.label}
        </span>
        <div className={`w-6 h-6 rounded-lg flex items-center justify-center font-bold text-xs ${props.accent}`}>
          {props.arrow}
        </div>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-lg font-mono font-bold text-white tracking-tight">{props.value}</span>
        <span className="text-xs font-mono text-brand-muted">MB/s</span>
      </div>
      <div className="mt-1 text-[10px] text-brand-muted/80 flex items-center gap-1">
        <span>Total:</span>
        <span className="font-mono text-slate-300">{props.total}</span>
      </div>
    </div>
  );
}

/**
 * Copy for the device-network card.
 *
 * Every string names the thing that was actually observed. There is deliberately no "Good",
 * "Excellent", "Poor", "Slow", "Stable" or "Unstable" here, and no number: nothing in this
 * path measures throughput, latency or reliability, so any of those words would be a claim
 * the app cannot support. 'unverified' in particular must not become "poor" - on a censored
 * network Android's validation probe can fail while the connection works.
 */
function networkLabel(state: NetworkStatusState): string {
  switch (state) {
    case 'ok':
      return 'Network OK';
    case 'unverified':
      return 'Network unverified';
    case 'captive_portal':
      return 'Sign-in required';
    case 'no_network':
      return 'No network';
    default:
      return 'Network status unavailable';
  }
}

/** Dot colour only. Amber for both uncertain states; red is reserved for "genuinely none". */
function networkTone(state: NetworkStatusState): string {
  switch (state) {
    case 'ok':
      return 'bg-emerald-400';
    case 'unverified':
    case 'captive_portal':
      return 'bg-amber-400';
    case 'no_network':
      return 'bg-rose-400';
    default:
      return 'bg-brand-muted';
  }
}

/** Null when the transport is unknown, so the card omits it rather than saying "unknown". */
function transportLabel(transport: NetworkTransport): string | null {
  switch (transport) {
    case 'wifi':
      return 'Wi-Fi';
    case 'cellular':
      return 'Mobile';
    case 'ethernet':
      return 'Ethernet';
    default:
      return null;
  }
}
