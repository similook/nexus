import { useMemo } from 'react';
import { useNexus } from '../core/NexusProvider';
import { formatSpeedMB, formatTotal, formatUptime } from '../core/format';
import { isQuicProtocol, type ServerNode } from '../data/servers';
import type { RunningServer } from '../core/plugin';
import { AdBanner } from '../components/AdBanner';
import { UpdateBanner } from '../components/UpdateBanner';
import { useLivePing } from '../core/useLivePing';
import { useNetworkStatus } from '../core/useNetworkStatus';
import type { NetworkStatusState, NetworkTransport } from '../core/plugin';
import { pingTone, vpnLatencyTone } from '../data/servers';

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

/**
 * What the card calls the running server: its node name when the start carried one, otherwise
 * protocol and endpoint (boot starts carry no name) - the same fallback as the notification.
 */
function runningLabel(running: RunningServer): string {
  if (running.name) return running.name;
  const protocol = (running.protocol ?? '').toUpperCase();
  return `${protocol ? `${protocol} · ` : ''}${running.server}:${running.port}`;
}

/**
 * A probe target for useLivePing built from the core's running-server identity.
 *
 * useLivePing reads only `id` and the proxy endpoint in `config` (endpointOf); the other fields
 * exist for the type and are never displayed. The id IS the endpoint, so the hook re-probes
 * exactly when the running endpoint changes.
 */
function probeTargetFor(running: RunningServer): ServerNode {
  return {
    id: `running:${running.server}:${running.port}`,
    name: runningLabel(running),
    flag: '🌐',
    country: running.server,
    transport: '',
    protocol: 'VLESS',
    pingMs: null,
    config: JSON.stringify({ outbounds: [{ tag: 'proxy', server: running.server, server_port: running.port }] }),
  };
}

export function HomeView({ node }: { node: ServerNode | null }) {
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
    runningServer,
  } = useNexus();

  const isConnected = connection === 'connected';
  const isBusy = connection === 'connecting';

  /*
   * WHICH SERVER THE CARD DESCRIBES.
   *
   * Connected: the one the CORE says it is running (NexusApi.runningServer) - never the
   * selection. The Quick Settings tile and boot start whatever the core last ran, so "selected"
   * and "running" can be different servers, and showing the selection here put one server's
   * name and latency over a tunnel going through another.
   *
   * Connected but the core has not said: an explicit unknown. Falling back to the selection
   * would be exactly the mislabel this exists to remove.
   *
   * Not connected: the selection - the server Connect will start.
   */
  const running = isConnected ? runningServer : null;
  const runningUnknown = isConnected && runningServer === null;
  const runningProbe = useMemo(() => (running === null ? null : probeTargetFor(running)), [running]);

  // Polled only while this screen is in the foreground - see useLivePing. Connected: "Delay",
  // a URL test through the running proxy, never the direct handshake (that measures only the
  // first hop). Disconnected: "TCP", the direct handshake to the selection.
  const livePing = useLivePing(isConnected ? runningProbe : node, isConnected ? 'vpn' : 'server');

  const cardFlag = running !== null || runningUnknown ? '🌐' : (node?.flag ?? '🌐');
  const cardName = running !== null
    ? runningLabel(running)
    : runningUnknown
      ? 'Running server unknown'
      : (node?.name ?? 'No server selected');
  const cardDetail = running !== null
    ? `${running.server}:${running.port}${running.protocol ? ` • ${running.protocol.toUpperCase()}` : ''}`
    : runningUnknown
      ? 'The core has not reported which server it is running'
      : node === null
        ? 'Servers tab → Add Subscription'
        : `${node.country} • ${node.transport}`;
  const cardQuic = running !== null
    ? running.protocol === 'hysteria2' || running.protocol === 'tuic'
    : !isConnected && node !== null && isQuicProtocol(node.protocol);

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
    (isConnected
      ? running !== null
        ? `Routed via ${runningLabel(running)}`
        : 'Routed via a server the app cannot identify'
      : node === null
        ? 'Add a subscription to get started'
        : 'Tap to establish encrypted tunnel');

  return (
    <section id="view-home" role="tabpanel" className="h-full min-h-0 flex flex-col px-5 pt-3 pb-4 overflow-y-auto custom-scroll">
      {/* Renders nothing unless a signed manifest offers a newer version — see UpdateBanner. */}
      <UpdateBanner />

      {/* Active node card */}
      <div className="shrink-0 flex items-center justify-between gap-2 p-3 rounded-2xl bg-brand-surface border border-brand-border mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-xl leading-none">{cardFlag}</span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-white truncate">
                {cardName}
              </span>
              {cardQuic && (
                <span
                  title="Higher idle battery use — keeps a QUIC connection alive"
                  className="px-1 py-px shrink-0 rounded text-[9px] font-mono font-semibold bg-amber-950/60 border border-amber-800/50 text-amber-400"
                >
                  ⚡
                </span>
              )}
            </span>
            <span className="block text-[10px] text-brand-muted truncate">
              {cardDetail}
            </span>
          </span>
        </div>
        {/* Labelled, because the two numbers measure different paths and must not be compared. */}
        <span className="flex flex-col items-end gap-0.5 shrink-0">
          <span className="text-[9px] font-semibold text-brand-muted tracking-wide">
            {isConnected ? 'Delay' : 'TCP'}
          </span>
          <span
            className={`text-[11px] font-mono font-medium px-2 py-0.5 rounded-md border transition-colors ${(isConnected
              ? vpnLatencyTone
              : pingTone)(typeof livePing === 'number' ? livePing : null)}`}
          >
            {livePing === 'pending'
              ? '…'
              : livePing === 'failed'
                ? 'n/a'
                : livePing === null
                  ? '--'
                  : `${livePing}ms`}
          </span>
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
              <span className="absolute w-52 h-52 rounded-full border-2 border-brand-orange/50 animate-pulse-ring [animation-iteration-count:3]" />
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
              <span className="w-1.5 h-1.5 rounded-full bg-brand-orange animate-pulse [animation-iteration-count:3]" />
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
