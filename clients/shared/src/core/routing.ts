/**
 * Routing for the DESKTOP client: VPN or Direct.
 *
 * Desktop only. clients/web (Android) neither imports this nor has an equivalent; the desktop
 * port composes it onto a node's config when it connects (clients/desktop/src/port/tauri.ts),
 * and only a port that sets `routing` shows the selector.
 *
 * =========================================================================================
 *   VPN     all traffic uses the VPN. Private and LAN addresses still go direct.
 *   Direct  all traffic uses the normal internet connection; the tunnel can stay connected.
 * =========================================================================================
 *
 * HOW A SWITCH HAPPENS WITHOUT A RECONNECT
 *
 * Both modes are compiled into every config as sing-box `clash_mode` rules, and the daemon moves
 * between them with the core's own ClashServer.SetMode (core/desktop/tunnel). The tunnel stays
 * up, so a switch never sends traffic out unprotected because a tunnel was torn down. The mode
 * names here are also what the daemon reports, so what the UI shows needs no translation.
 *
 * FAKEIP STAYS, IN BOTH MODES. Every A/AAAA query is answered with a fake address
 * (singboxConfig.ts) and the router hands the outbound the DOMAIN. That is what keeps a live
 * switch correct: no app ever holds a real address — let alone a poisoned one — that would
 * follow it into the other mode.
 *
 * DNS FOR DIRECT TRAFFIC. A connection routed direct resolves its real address through the
 * `direct` outbound's resolver, `dns-local`: the DNS servers of the machine's physical adapter.
 * dns-direct (DoH to 1.1.1.1) cannot serve it — it is reset on the networks this client is for.
 *
 * ONE DNS RULE, DIRECT ONLY. Every query that is not an address lookup (HTTPS, SVCB, TXT…) goes
 * to dns-proxy, a DoH server pinned to the proxy outbound — the route rules never see it. So in
 * Direct mode that DNS would still travel through the VPN; core/desktop/tunnel's
 * TestDirectModeDNS showed exactly that before this rule existed. In Direct mode those queries go
 * to dns-local instead. VPN-mode DNS is exactly what it was.
 */

export const ROUTING_MODES = ['VPN', 'Direct'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** One line per mode, shown beside the label. */
export const ROUTING_MODE_HELP: Record<RoutingMode, string> = {
  VPN: 'All traffic uses the VPN.',
  Direct: 'All traffic uses your normal internet connection.',
};

/** First install, or nothing usable stored. */
export const DEFAULT_ROUTING_MODE: RoutingMode = 'VPN';

export function isRoutingMode(value: unknown): value is RoutingMode {
  return typeof value === 'string' && (ROUTING_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------------------

/** The DNS server that resolves destinations routed direct. See the module comment. */
export const LOCAL_DNS_TAG = 'dns-local';

type Json = Record<string, unknown>;

/**
 * Add routing to a node's config: both modes as `clash_mode` rules, the mode to start in, and
 * the resolver direct traffic needs.
 *
 * Everything else is left as the node's config has it — outbounds, the TUN inbound, fakeip,
 * the DNS rules. Composing a composed config gives the same config back.
 */
export function composeRouting(configJSON: string, mode: RoutingMode): string {
  const config = JSON.parse(configJSON) as Json;

  const route = config.route as Json | undefined;
  if (route === undefined || !Array.isArray(route.rules)) {
    throw new Error('Routing: the config has no route rules to extend');
  }
  const outbounds = Array.isArray(config.outbounds) ? (config.outbounds as Json[]) : [];
  const direct = outbounds.find((outbound) => outbound.tag === 'direct');
  if (direct === undefined || !outbounds.some((outbound) => outbound.tag === 'proxy')) {
    throw new Error('Routing: the config needs outbounds tagged "proxy" and "direct"');
  }

  const dns = (config.dns ?? {}) as Json;
  const servers = Array.isArray(dns.servers) ? (dns.servers as Json[]) : [];
  if (!servers.some((server) => server.tag === LOCAL_DNS_TAG)) {
    servers.push({ type: 'local', tag: LOCAL_DNS_TAG });
  }
  dns.servers = servers;
  // After the node's own rules, so address lookups still get their fake IP first.
  dns.rules = [
    ...(Array.isArray(dns.rules) ? (dns.rules as unknown[]) : []).filter((rule) => !isModeRule(rule)),
    { clash_mode: 'Direct', server: LOCAL_DNS_TAG },
  ];
  config.dns = dns;
  direct.domain_resolver = { server: LOCAL_DNS_TAG, strategy: 'prefer_ipv4' };

  route.rules = [
    ...(route.rules as unknown[]).filter((rule) => !isModeRule(rule)),
    // Direct: everything, LAN included, over the normal connection.
    { clash_mode: 'Direct', action: 'route', outbound: 'direct' },
    // VPN: private and LAN addresses stay direct; everything else through the tunnel.
    { clash_mode: 'VPN', ip_is_private: true, action: 'route', outbound: 'direct' },
    { clash_mode: 'VPN', action: 'route', outbound: 'proxy' },
  ];

  // The mode to start in. The daemon re-applies it after start, because the core would
  // otherwise restore the last mode it saved in cache.db (core/desktop/tunnel).
  const experimental = (config.experimental ?? {}) as Json;
  experimental.clash_api = {
    ...((experimental.clash_api as Json | undefined) ?? {}),
    default_mode: mode,
  };
  config.experimental = experimental;

  return JSON.stringify(config);
}

function isModeRule(rule: unknown): boolean {
  return typeof rule === 'object' && rule !== null && 'clash_mode' in rule;
}

// ---------------------------------------------------------------------------------------
// Persistence — the same localStorage pattern as selection.ts
// ---------------------------------------------------------------------------------------

/**
 * v2: just the mode. (v1 held the Whitelist/Blacklist lists of a design that was never
 * released; it is ignored, not reinterpreted.)
 */
const STORAGE_KEY = 'nexus.routing.v2';

export function loadRoutingMode(): RoutingMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ROUTING_MODE;
    const record = JSON.parse(raw) as Json;
    return isRoutingMode(record.mode) ? record.mode : DEFAULT_ROUTING_MODE;
  } catch {
    // Storage unavailable or malformed: VPN is the safe reading of "no preference".
    return DEFAULT_ROUTING_MODE;
  }
}

export function saveRoutingMode(mode: RoutingMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode }));
  } catch {
    // Same reasoning as selection.ts: losing a preference beats throwing mid-render.
  }
}
