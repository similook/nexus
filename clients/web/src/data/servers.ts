/**
 * Mock server data, shaped the way real data will be.
 *
 * ============================== TEST FIXTURE ==============================
 * The `config` strings below are hand-written sing-box configs for bring-up testing on a
 * device. They are NOT the long-term design: ADR-0002 §2 puts config generation on the
 * native/Go side, so that a UI bug cannot emit a config which silently disables the power
 * policy. This whole file collapses to a list of node identities once `nexuscore` grows
 * config generation — delete the builders then, do not extend them.
 *
 * Replace every PLACEHOLDER value before connecting. With placeholders left in, the tunnel
 * establishes and no traffic flows, which looks exactly like the protect(fd) bug and is not.
 * =========================================================================
 */


export type Protocol = 'VLESS' | 'Trojan' | 'Hysteria2' | 'Shadowsocks' | 'VMess' | 'TUIC';

export interface ServerNode {
  id: string;
  name: string;
  flag: string;
  country: string;
  /** Free-text transport detail, e.g. "Reality", "TLS", "UDP Highspeed". */
  transport: string;
  protocol: Protocol;
  /** Last measured latency in ms; null means never tested. */
  pingMs: number | null;
  /** Complete sing-box config, passed to NexusCore.start() untouched. */
  config: string;
  /**
   * The proxy URI this node came from, when there was one.
   *
   * STORED SO CONFIG GENERATION CAN CHANGE. `config` is derived output; persisting only the
   * derived form meant that fixing buildConfig() had no effect on anything already imported.
   * That is exactly how the missing DNS block survived a rebuild: the device kept replaying a
   * config generated before the fix existed.
   *
   * Keep the source, regenerate the output. Built-in demo nodes have no URI.
   */
  uri?: string;
  /**
   * Set when `config` could NOT be regenerated from `uri` and is therefore whatever an older
   * build produced. Such a node may be missing transports, TLS, or DNS that later builds add,
   * and it will fail in ways that look like a server problem rather than a stale-config one.
   *
   * Built-in demo nodes have no `uri` and are not marked - they are generated fresh each run.
   */
  staleReason?: string;
}

export interface Subscription {
  id: string;
  name: string;
  daysLeft: number;
  usedBytes: number;
  quotaBytes: number;
  nodes: ServerNode[];
}

/**
 * Server and port of the node's proxy outbound, for the latency test.
 *
 * Read back out of the generated config rather than stored separately: the config is the one
 * representation that is guaranteed to match what the core will actually dial, so a test that
 * reads it cannot drift from the connection it is meant to predict.
 */
/**
 * Display protocol for a node, read out of the config the core will actually run.
 *
 * WHY NOT node.protocol
 *
 * That field is a label the URI parser wrote at import time. It is normally right, but it is a
 * second source of truth for something the config already states exactly, and it is the one
 * that can be stale - a node imported by an older build carries whatever that build decided.
 * The outbound `type` is what the core dispatches on, so reading it means the badge cannot
 * disagree with the tunnel.
 *
 * Falls back to the stored label if the config cannot be read, and to '--' if there is no node.
 */
export function protocolOf(node: ServerNode | null): string {
  if (node === null) return '--';

  const outboundType = (() => {
    try {
      const outbounds = (JSON.parse(node.config) as { outbounds?: Array<Record<string, unknown>> })
        .outbounds;
      const proxy = outbounds?.find((o) => o.tag === 'proxy');
      return typeof proxy?.type === 'string' ? proxy.type : '';
    } catch {
      return '';
    }
  })();

  // sing-box's own type strings, mapped to how these protocols are written in the wild.
  // Anything unrecognised is upper-cased rather than dropped: a new protocol should show its
  // name, not a blank badge.
  const DISPLAY: Record<string, string> = {
    vless: 'VLESS',
    vmess: 'VMESS',
    trojan: 'TROJAN',
    shadowsocks: 'SHADOWSOCKS',
    hysteria2: 'HYSTERIA2',
    tuic: 'TUIC',
    anytls: 'ANYTLS',
    shadowtls: 'SHADOWTLS',
    socks: 'SOCKS',
    http: 'HTTP',
    wireguard: 'WIREGUARD',
  };

  if (outboundType) return DISPLAY[outboundType] ?? outboundType.toUpperCase();
  return node.protocol.toUpperCase();
}

export function endpointOf(node: ServerNode): { server: string; port: number } | null {
  try {
    const outbounds = (JSON.parse(node.config) as { outbounds?: Array<Record<string, unknown>> })
      .outbounds;
    const proxy = outbounds?.find((o) => o.tag === 'proxy');
    const server = typeof proxy?.server === 'string' ? proxy.server : '';
    const port = typeof proxy?.server_port === 'number' ? proxy.server_port : 0;
    return server && port > 0 ? { server, port } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// No built-in nodes.
// ---------------------------------------------------------------------------------------
//
// This file used to ship five demo nodes - a fake "VIP Premium Subscription" plus two custom
// entries - assembled from PLACEHOLDER credentials so the UI had something to render before
// the importer existed. They are gone.
//
// They were actively harmful once real imports worked:
//   - Every one of them was unconnectable. A user tapping Connect on "London Direct" got a
//     failure with no explanation, because the UUID was literally all zeros.
//   - They made an empty app look populated, which hides the one thing a new user must do.
//   - `allNodes[0]` seeded the selection, so a fresh install started out pointed at a config
//     that could never work.
//
// The list now shows exactly what the user imported: subscriptions, and manually pasted links.
// An empty list is correct and ServersView has an empty state for it.

/**
 * Latency colour thresholds.
 *
 * Note the protocol/battery tension this UI only partly surfaces: Helsinki is the fastest node
 * here and it is Hysteria2, which per ADR-0001 §2.1 is the most expensive protocol at idle.
 * Ranking purely on ping quietly steers every user onto the worst option for battery. The ⚡
 * badge is a stopgap; a real battery-cost indicator is ADR-0001 §5.1 and is not built yet.
 */
export function pingTone(pingMs: number | null): string {
  // Negative is the native probe's failure sentinel, not a latency. Callers render it as text,
  // but colour it as bad in case one forgets.
  if (pingMs === null || pingMs < 0) return 'text-brand-muted bg-brand-navy border-brand-border';
  if (pingMs < 70) return 'text-emerald-400 bg-emerald-950/50 border-emerald-800/40';
  if (pingMs < 150) return 'text-amber-400 bg-amber-950/50 border-amber-800/40';
  return 'text-rose-400 bg-rose-950/50 border-rose-800/40';
}

/** True for protocols that hold a QUIC connection open with periodic heartbeats. */
export function isQuicProtocol(protocol: Protocol): boolean {
  return protocol === 'Hysteria2' || protocol === 'TUIC';
}
