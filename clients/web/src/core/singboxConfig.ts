/**
 * The single place a sing-box config is assembled.
 *
 * Both the subscription importer and the built-in demo nodes go through here, so protocol
 * support and policy live in one file rather than drifting between two.
 *
 * ADR-0002 §2 still says this belongs in Go. It does. Until it moves, ConfigGuard on the Kotlin
 * side validates everything this produces — including with libbox's own parser — so a mistake
 * here fails loudly at connect time instead of silently costing battery or traffic.
 */

/**
 * TUN stack.
 *
 * ================= THIS CONTRADICTS ADR-0001 SECTION 5.4, DELIBERATELY =================
 *
 * The ADR mandates `system`, on the reasoning that gVisor reassembles TCP in userspace and
 * costs measurable CPU per packet - which is battery, which is the product. That reasoning is
 * still sound and the decision was correct on the evidence available.
 *
 * It is overridden here because the evidence changed. On device with `system`:
 *
 *   - UDP worked. Every QUIC flow reached the proxy with real destinations.
 *   - TCP never appeared AT ALL. Not one `inbound connection` line in a full session log,
 *     while a browser sat there loading nothing.
 *
 * A stack that carries UDP and silently drops TCP is not a battery trade-off, it is a broken
 * tunnel. Correctness outranks the power policy; a client that moves no traffic has no battery
 * profile worth measuring.
 *
 * CONFIRMED ON DEVICE with `gvisor`: TCP flows appear and complete -
 *
 *   inbound/tun[tun-in]: inbound connection from 172.19.0.1:58484
 *   router: sniffed protocol: tls, domain: example.com
 *   connection: connection upload finished
 *
 * plus sniffed `http` and `ssh` flows. The hypothesis held.
 *
 * STILL OWED: this belongs in ADR-0001 as an amendment with a bench/B-04 measurement of what
 * gvisor actually costs in CPU and battery - and `mixed` (system TCP + gvisor UDP) must be
 * tried, since it may recover most of that cost while keeping TCP working. Do not leave this
 * here unmeasured just because traffic now flows.
 *
 * ======================================================================================
 */
const TUN_STACK = 'gvisor';

const tunInbound = {
  type: 'tun',
  tag: 'tun-in',

  /**
   * IPv4 AND IPv6, even though the proxy path is IPv4-only. This closes a leak.
   *
   * With a v4 address only, the core reports no v6 prefixes, NexusVpnService adds no `::/0`
   * route, and Android leaves IPv6 on the underlying network. Any app that reaches a v6
   * literal - or that got an AAAA from a resolver that is not ours - then talks to the
   * internet AROUND the tunnel, from the user's real address, while the UI says "connected".
   * That is the failure a VPN exists to prevent, and it is invisible from inside the app.
   *
   * fakeip hands out v4 only and the DNS strategy is prefer_ipv4, so in practice almost
   * nothing picks v6 by name. This covers what is left: literals and cached AAAA records.
   *
   * Claiming ::/0 means such a connection now enters the tunnel and fails if the proxy cannot
   * carry v6. FAILING CLOSED IS THE POINT. A connection that does not happen is a bug report;
   * a connection that silently bypasses the tunnel is a deanonymisation.
   *
   * fdfe:dcba:9876::1/126 is the sing-box convention - a ULA (fc00::/7), so it cannot collide
   * with a real destination.
   */
  address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
  mtu: 9000,
  auto_route: true,
  // strict_route adds enforcement rules that are a Linux/Windows concept; on Android the
  // VpnService builder already owns routing. Dropped while isolating the TCP failure so there
  // is one less thing in the path.
  strict_route: false,
  stack: TUN_STACK,
};

/**
 * DNS.
 *
 * ===================== WHY THIS BLOCK IS NOT OPTIONAL =====================
 *
 * It was omitted originally to dodge sing-box schema churn. On device that produced:
 *
 *   router: process DNS packet: ...: read udp [::1]:44120->[::1]:53: read: connection refused
 *
 * With no dns block the core falls back to the system resolver. On Android there is no
 * /etc/resolv.conf, so Go's resolver ends up dialling localhost:53, where nothing is listening.
 * Every lookup fails, so no connection is ever attempted, so the tunnel carries nothing while
 * looking perfectly healthy.
 *
 * ==========================================================================
 *
 * THREE SERVERS, EACH WITH ONE JOB:
 *
 *   dns-fake    every A/AAAA query. Answers instantly from 198.18.0.0/15 without looking
 *               anything up, which is what makes destination poisoning structurally impossible.
 *   dns-proxy   the queries fakeip cannot answer (not A/AAAA), through the tunnel, encrypted.
 *   dns-direct  the proxy server's own hostname, outside the tunnel, encrypted.
 *
 * An earlier version of this file had two plaintext resolvers and a comment arguing that the
 * one inside the tunnel did not need encrypting. Both halves of that were wrong on device; the
 * long notes on each server below record what the logs actually showed.
 *
 * prefer_ipv4: mobile carriers hand out IPv6 that frequently cannot reach the proxy. Preferring
 * A records avoids a per-connection timeout before falling back.
 */
function buildDns(serverHost: string) {
  const isIpLiteral = /^[\d.]+$/.test(serverHost) || serverHost.includes(':');

  return {
    servers: [
      // ============ FAKEIP: WHY THE DESTINATION IS NEVER AN IP WE CHOSE ============
      //
      // Every A query is answered instantly with a synthetic address out of 198.18.0.0/15.
      // Nothing is looked up, so nothing can be poisoned, and no app ever holds a real IP for
      // a hostname. When the app then connects to 198.18.x.x, the router maps that address
      // back to the domain it was minted for and sets the destination to the DOMAIN:
      //
      //   route/route.go: metadata.Destination = M.Socksaddr{Fqdn: domain, Port: ...}
      //
      // VLESS carries an FQDN destination natively, so the PROXY SERVER does the resolution,
      // on its own network, where the censor is not. Local DNS stops being able to influence
      // where a connection goes at all.
      //
      // This replaces the sniff+resolve approach, which did not work. `resolve` is a no-op
      // unless the destination is already a domain -
      //
      //   func (r *Router) actionResolve(...) { if metadata.Destination.IsDomain() { ... } }
      //
      // - and sniffing puts the hostname in metadata.Domain, NOT in metadata.Destination.
      // The 1.11-era option that copied one to the other (sniff_override_destination) is
      // deprecated and has no JSON field left in 1.14. So every log line read
      // "match[1] => resolve(prefer_ipv4)" and then dialled the original poisoned address,
      // and no "resolved [...]" line was ever printed. It was decoration.
      //
      // 198.18.0.0/15 is the RFC 2544 benchmarking range: routable-looking, never routed.
      // IPv4 only - an unset inet6_range makes AAAA return an empty success, which suppresses
      // IPv6 without the per-connection timeout that a mobile carrier's dead IPv6 would cost.
      { type: 'fakeip', tag: 'dns-fake', inet4_range: '198.18.0.0/15' },

      // Real resolution for the queries fakeip cannot answer (anything that is not A/AAAA:
      // HTTPS/SVCB records, SRV, PTR). Encrypted, through the tunnel.
      //
      // DoH rather than plain UDP/53. "Inside the tunnel" is NOT "outside the censored
      // network": the exit here is a domestic relay, so a plaintext query addressed to
      // 8.8.8.8 still crosses the same national uplink that does the hijacking, one hop
      // further along. DoH is authenticated, so a forged reply cannot be substituted.
      { type: 'https', tag: 'dns-proxy', server: '8.8.8.8', detour: 'proxy' },

      // The proxy server's own hostname, resolved outside the tunnel - otherwise the core
      // would need the tunnel to find the address of the tunnel. This is the one query that
      // leaves unprotected, so it is DoH to an IP literal: no bootstrap lookup, port 443,
      // authenticated answer.
      //
      // Largely belt-and-braces today because ConfigGuard pre-resolves outbound hostnames
      // with Android's own resolver before the config reaches the core. Kept because that
      // pre-resolution is an Android-side convenience, not a guarantee, and Apple has no
      // equivalent yet.
      { type: 'https', tag: 'dns-direct', server: '1.1.1.1' },
    ],
    rules: [
      // Must come first: the server's own name has to resolve to a REAL address. A fake IP
      // here would be a tunnel pointed at itself.
      ...(isIpLiteral ? [] : [{ domain: [serverHost], server: 'dns-direct' }]),

      // Everything else that is an address lookup gets a fake IP.
      { query_type: ['A', 'AAAA'], server: 'dns-fake' },
    ],
    final: 'dns-proxy',
    strategy: 'prefer_ipv4',
    // Required with fakeip: the fake answers must not share a cache with real ones.
    independent_cache: true,
  };
}

/**
 * Wrap a proxy outbound into a complete, connectable config.
 *
 * `proxyOutbound` must carry tag "proxy" and a `server` field.
 */
export function buildConfig(proxyOutbound: Record<string, unknown>): string {
  const serverHost = String((proxyOutbound as { server?: string }).server ?? '');

  return JSON.stringify({
    log: { level: 'info', timestamp: true },
    dns: buildDns(serverHost),
    inbounds: [tunInbound],
    outbounds: [proxyOutbound, { type: 'direct', tag: 'direct' }],
    route: {
      auto_detect_interface: true,

      /**
       * How the core resolves the PROXY SERVER'S OWN hostname.
       *
       * Required in sing-box 1.12+: an outbound whose `server` is a domain refuses to build
       * without a resolver, because there is no safe default for the one lookup that has to
       * happen before the tunnel exists.
       *
       * MOSTLY UNUSED, ON PURPOSE. ConfigGuard rewrites the outbound's `server` to an IP
       * before the core sees this config, so there is normally no domain left to resolve.
       *
       * It stays for the case where that rewrite could not happen (a platform without the
       * guard, or a lookup that failed), and it points at dns-direct because that is the only
       * resolver reachable without the tunnel.
       *
       * DO NOT make this the primary path. It was, briefly, and every connection failed:
       *
       *   dns: lookup failed for <server>:
       *     read tcp ...->1.1.1.1:443: read: connection reset by peer
       *
       * Cloudflare's DoH endpoint is reset by the ISP on the networks this app is for. An
       * authenticated resolver that cannot be reached is not safer than a plain one - it is
       * just a tunnel that never connects. See the long note in ConfigGuard.enforce.
       */
      default_domain_resolver: { server: 'dns-direct', strategy: 'prefer_ipv4' },

      /**
       * SNIFF ONLY. THE `resolve` ACTION USED TO BE HERE AND IT DID NOTHING.
       *
       * `sniff` reads the real hostname out of the connection itself - TLS SNI, HTTP Host,
       * QUIC ClientHello - and puts it in metadata.Domain. That is worth keeping: it is what
       * makes the logs legible and what any future domain-based routing rule would match on.
       *
       * It was paired with `{ action: 'resolve' }` on the theory that resolve would look the
       * sniffed name up again through our DNS and rewrite a poisoned destination. It does not,
       * because resolve reads the DESTINATION, not the sniffed domain:
       *
       *   func (r *Router) actionResolve(...) error {
       *       if metadata.Destination.IsDomain() { ...lookup and rewrite... }
       *       return nil
       *   }
       *
       * Our destination is always a literal IP (the app dialled one), so the guard was false
       * every time and resolve returned nil immediately. The device logs said exactly this and
       * I misread them: every flow printed "match[1] => resolve(prefer_ipv4)" and then dialled
       * the original address, and not one "resolved [...]" line was ever emitted - which is the
       * line actionResolve prints when it actually rewrites something.
       *
       * The 1.11-era bridge between the two (sniff_override_destination) is deprecated and no
       * longer has a JSON field in 1.14, so there is no way to make that pairing work.
       *
       * Destination correctness is now handled structurally, by fakeip in buildDns: the app is
       * never given a real IP to poison, and the router hands the DOMAIN to the VLESS outbound
       * so the proxy server resolves it remotely. See the long note there.
       *
       * Sniffing costs a peek at the first packet of each connection. That is a real per-flow
       * cost and it is now paid for logging and future routing rather than for correctness; if
       * bench/B-04 shows it mattering, this is removable without breaking the tunnel.
       */
      rules: [{ action: 'sniff' }],

      final: 'proxy',
    },
  });
}
