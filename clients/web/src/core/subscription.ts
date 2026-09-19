import { CapacitorHttp } from '@capacitor/core';
import type { Protocol, ServerNode } from '../data/servers';
import { buildConfig } from './singboxConfig';

/**
 * Subscription-link support: fetch a URL, decode it, and turn the proxy URIs inside into
 * ServerNodes with complete sing-box configs.
 *
 * ============================ ARCHITECTURAL DEBT — READ THIS ============================
 *
 * ADR-0002 §2 says config generation belongs on the native/Go side, precisely so that a UI bug
 * cannot emit a config which silently disables the power policy. This file violates that. It is
 * here because subscription parsing is what makes the app usable, and porting a six-protocol
 * URI parser into Go is a larger job than the feature is worth today.
 *
 * What makes that survivable rather than reckless: **ConfigGuard still runs on everything this
 * produces.** Every config crosses into Kotlin via NexusCore.start(), where ConfigGuard rejects
 * any tun stack that is not "system" and clamps health-check intervals to the ADR-0001 §5.4
 * floor. So a malicious or malformed subscription cannot turn our battery policy off — it can
 * only fail to connect.
 *
 * That defence is the entire reason ConfigGuard exists. Do not "simplify" it away.
 *
 * When this moves to Go, this file should shrink to a call and a type.
 *
 * =======================================================================================
 *
 * SECURITY NOTE: everything parsed here comes from a remote server the user pasted a link to.
 * Treat it as hostile input — no eval, no dynamic imports, no string-concatenated JSON. We
 * build plain objects and let JSON.stringify do the escaping.
 */

// ---------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------

export interface SubscriptionSource {
  /** User-supplied URL. http:// and https:// both supported — see the cleartext note below. */
  url: string;
  /** Display name; defaults to the URL's host. */
  name?: string;
}

export class SubscriptionError extends Error {}

/**
 * Quota/expiry reported by the panel in the Subscription-Userinfo response header.
 *
 * Format (a de-facto standard, not an RFC):
 *   Subscription-Userinfo: upload=1234; download=5678; total=107374182400; expire=1735689600
 *
 * Every field is optional and panels disagree about which they send, so each is nullable and
 * absence is rendered as "unknown" rather than as zero. Showing "0 GB remaining" because a
 * header was missing would be a lie the user acts on.
 */
export interface SubscriptionUserinfo {
  uploadBytes: number | null;
  downloadBytes: number | null;
  totalBytes: number | null;
  /** Epoch MILLIS (the header carries seconds). */
  expiresAt: number | null;
}

export function parseUserinfo(header: string | null | undefined): SubscriptionUserinfo | null {
  if (!header) return null;

  const fields: Record<string, number> = {};
  for (const part of header.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    if (!rawKey || rawValue === undefined) continue;
    const value = Number(rawValue.trim());
    if (Number.isFinite(value)) fields[rawKey.trim().toLowerCase()] = value;
  }
  if (Object.keys(fields).length === 0) return null;

  return {
    uploadBytes: fields.upload ?? null,
    downloadBytes: fields.download ?? null,
    totalBytes: fields.total ?? null,
    // The header carries seconds; 0 is the common "never expires" sentinel, not 1970.
    expiresAt: fields.expire && fields.expire > 0 ? fields.expire * 1000 : null,
  };
}

/** Case-insensitive header lookup — HTTP header casing is not guaranteed by anyone. */
function findHeader(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return null;
}

/**
 * Fetch a subscription body.
 *
 * Uses CapacitorHttp (native HTTP), NOT window.fetch, for two reasons:
 *
 *   1. CORS. The WebView's origin is capacitor://localhost; a subscription server will not send
 *      Access-Control-Allow-Origin for it, so window.fetch fails on virtually every real
 *      subscription link. Native HTTP is not subject to CORS at all.
 *   2. Cleartext. Plain http:// is blocked by the WebView's mixed-content policy but permitted
 *      natively once the manifest allows it (see android:usesCleartextTraffic).
 *
 * On http:// the subscription — server addresses, UUIDs, passwords — travels unencrypted and is
 * readable and modifiable by anyone on the path. The caller is responsible for warning the user;
 * see isInsecureUrl.
 */
export interface FetchResult {
  body: string;
  userinfo: SubscriptionUserinfo | null;
}

export async function fetchSubscription(url: string): Promise<FetchResult> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new SubscriptionError('Link must start with http:// or https://');
  }

  let response;
  try {
    response = await CapacitorHttp.get({
      url: trimmed,
      headers: {
        // Some panels serve a different (or no) payload without a recognised client UA.
        'User-Agent': 'Nexus/0.1 (sing-box)',
        Accept: '*/*',
      },
      connectTimeout: 15000,
      readTimeout: 15000,
      responseType: 'text',
    });
  } catch (e) {
    throw new SubscriptionError(
      `Could not reach the server: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new SubscriptionError(`Server returned HTTP ${response.status}`);
  }

  const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  if (!body.trim()) throw new SubscriptionError('The subscription is empty');

  return {
    body,
    userinfo: parseUserinfo(findHeader(response.headers, 'subscription-userinfo')),
  };
}

/** True for http:// links, whose contents travel in the clear. */
export function isInsecureUrl(url: string): boolean {
  return /^http:\/\//i.test(url.trim());
}

// ---------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------

/**
 * Subscription bodies are usually base64 of a newline-separated URI list, but plenty of panels
 * serve the plain list. Detect rather than require, because a wrong guess here looks to the
 * user like "the link is broken".
 */
function decodeBody(body: string): string[] {
  const trimmed = body.trim();

  if (/^(vless|vmess|trojan|ss|hysteria2?|hy2|tuic):\/\//im.test(trimmed)) {
    return splitLines(trimmed);
  }

  try {
    const decoded = base64Decode(trimmed.replace(/\s+/g, ''));
    if (/^(vless|vmess|trojan|ss|hysteria2?|hy2|tuic):\/\//im.test(decoded)) {
      return splitLines(decoded);
    }
  } catch {
    // fall through
  }

  return splitLines(trimmed);
}

function splitLines(text: string): string[] {
  return text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** base64 / base64url, tolerant of missing padding. */
function base64Decode(input: string): string {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  const binary = atob(s);
  // Decode as UTF-8: node names are routinely non-ASCII - flags, CJK, and every other
  // script a provider might label a server in.
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

// ---------------------------------------------------------------------------------------
// sing-box config assembly
// ---------------------------------------------------------------------------------------
// Config assembly lives in singboxConfig.ts so the subscription path and the built-in
// demo nodes cannot drift apart. The DNS block in particular is not optional - see there.


// ---------------------------------------------------------------------------------------
// URI parsers
// ---------------------------------------------------------------------------------------

interface ParsedNode {
  name: string;
  protocol: Protocol;
  transport: string;
  outbound: Record<string, unknown>;
}

/** Shared TLS block builder for the URI formats that carry TLS in query params. */
function tlsFromParams(params: URLSearchParams, host: string): Record<string, unknown> | null {
  const security = (params.get('security') ?? '').toLowerCase();
  if (security !== 'tls' && security !== 'reality') return null;

  const tls: Record<string, unknown> = {
    enabled: true,
    server_name: params.get('sni') || params.get('peer') || host,
  };

  const fp = params.get('fp');
  if (fp) tls.utls = { enabled: true, fingerprint: fp };

  if (security === 'reality') {
    const pbk = params.get('pbk');
    if (!pbk) throw new SubscriptionError('reality link is missing its public key (pbk)');
    tls.reality = {
      enabled: true,
      public_key: pbk,
      short_id: params.get('sid') ?? '',
    };
    // REALITY implies uTLS; default to chrome if the link did not say.
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' };
  }

  // ALPN, filtered by what the transport can actually speak.
  //
  // Panels emit a fixed list - "h2,http/1.1,h3" is the common one - regardless of the node's
  // transport, and two of those three are wrong for most nodes:
  //
  //   h3        is HTTP/3, which is QUIC, which is UDP. Offering it in a TLS-over-TCP
  //             handshake advertises a protocol that cannot be spoken on this socket.
  //   h2        breaks a WebSocket node outright. A WS upgrade is an HTTP/1.1 mechanism; if
  //             the TLS handshake negotiates h2, there is no upgrade to perform and the
  //             connection dies after the handshake rather than during it.
  //
  // So intersect the link's list with what this transport can honour, and drop the block
  // entirely if nothing survives - an absent alpn lets the server choose, which is correct.
  const transportType = (params.get('type') ?? 'tcp').toLowerCase();
  const alpn = params.get('alpn');
  if (alpn) {
    const requested = alpn.split(',').map((a) => a.trim()).filter(Boolean);
    // grpc genuinely needs h2. ws and httpupgrade need http/1.1. Plain TCP carries the proxy
    // protocol directly, so either is harmless - keep what was asked for.
    const allowed =
      transportType === 'grpc' ? ['h2']
      : transportType === 'ws' || transportType === 'httpupgrade' ? ['http/1.1']
      : requested.filter((a) => a !== 'h3');

    const usable = transportType === 'grpc' || transportType === 'ws' || transportType === 'httpupgrade'
      ? requested.filter((a) => allowed.includes(a))
      : allowed;

    if (usable.length > 0) tls.alpn = usable;
  }

  if (params.get('allowInsecure') === '1' || params.get('insecure') === '1') {
    // Honoured because some panels genuinely need it, but it disables certificate validation —
    // an on-path attacker can then impersonate the server. Surfaced in the UI, not hidden.
    tls.insecure = true;
  }

  return tls;
}

/** v2ray-style transport params (ws / grpc / httpupgrade / h2). */
function transportFromParams(params: URLSearchParams): Record<string, unknown> | null {
  const type = (params.get('type') ?? 'tcp').toLowerCase();
  switch (type) {
    case 'ws':
      return {
        type: 'ws',
        path: params.get('path') || '/',
        ...(params.get('host') ? { headers: { Host: params.get('host') } } : {}),
      };
    case 'grpc':
      return { type: 'grpc', service_name: params.get('serviceName') || '' };
    case 'httpupgrade':
      return {
        type: 'httpupgrade',
        path: params.get('path') || '/',
        ...(params.get('host') ? { host: params.get('host') } : {}),
      };
    case 'http':
    case 'h2':
      return {
        type: 'http',
        ...(params.get('host') ? { host: [params.get('host')] } : {}),
        path: params.get('path') || '/',
      };
    default: {
      // tcp.
      //
      // Plain TCP needs no transport block - EXCEPT when the link asks for v2ray's HTTP
      // header masquerade (`headerType=http`), which is widely used where plain TLS to an
      // unfamiliar host draws attention and traffic has to look like ordinary web browsing.
      //
      // I first rejected this combination, having read that
      // option/v2ray_transport.go accepts only http/ws/quic/grpc/httpupgrade and concluded
      // the masquerade was unsupported. That was wrong: sing-box's `http` transport WITHOUT
      // TLS is exactly this wire format. From transport/v2rayhttp/conn.go:
      //
      //   writer.Write(method + " " + uri + " HTTP/1.1" + CRLF)
      //   ...headers...
      //   writer.Write(CRLF)
      //   writer.Write(payload)        // raw, NOT chunked
      //
      // and Read parses exactly one response header, requires status 200, then reads raw.
      // That is the masquerade, byte for byte. (The chunked framing I assumed would corrupt
      // the stream only appears on the HTTP/2 path, which is taken when TLS is configured.)
      //
      // The symptom of getting this wrong is not a parse error, it is:
      //
      //   connection: connection download closed: unknown version: 72
      //
      // 72 is 0x48, ASCII 'H'. Sending raw VLESS to a masquerading server makes it answer
      // with its fake "HTTP/1.1 ..." header, which the VLESS client reads as a version byte.
      //
      // method: GET is explicit because sing-box defaults to PUT when unset, while v2ray's
      // header template defaults to GET and some servers check it.
      const header = (params.get('headerType') ?? 'none').toLowerCase();
      if (header === 'http') {
        const host = params.get('host');
        return {
          type: 'http',
          method: 'GET',
          ...(host
            ? { host: host.split(',').map((h) => h.trim()).filter(Boolean) }
            : {}),
          path: params.get('path') || '/',
        };
      }
      if (header !== 'none' && header !== '') {
        // srtp/utp/wechat-video/dtls/wireguard headers have no sing-box equivalent. Refuse the
        // node rather than run a config that cannot work; the importer counts it as skipped.
        throw new SubscriptionError(
          `transport "tcp" with headerType="${header}" is not supported by sing-box`,
        );
      }
      return null;
    }
  }
}

function describeTransport(params: URLSearchParams): string {
  const security = (params.get('security') ?? '').toLowerCase();
  const type = (params.get('type') ?? 'tcp').toLowerCase();
  if (security === 'reality') return 'Reality';
  if (security === 'tls') return type === 'tcp' ? 'TLS' : `TLS / ${type}`;
  // Name the masquerade rather than calling it plain TCP - it is the difference between a
  // node that works and one that dies with "unknown version: 72".
  const header = (params.get('headerType') ?? 'none').toLowerCase();
  if (type === 'tcp' && header === 'http') return 'TCP / HTTP';
  return type.toUpperCase();
}

function parseVless(uri: string): ParsedNode {
  const u = new URL(uri);
  const params = u.searchParams;
  const host = u.hostname;

  const outbound: Record<string, unknown> = {
    type: 'vless',
    tag: 'proxy',
    server: host,
    server_port: Number(u.port) || 443,
    uuid: decodeURIComponent(u.username),
  };

  const tls = tlsFromParams(params, host);
  if (tls) outbound.tls = tls;

  // FLOW ONLY EXISTS IF TLS DOES.
  //
  // xtls-rprx-vision is an operation on the TLS record layer - it splices and pads TLS records
  // to hide the proxy's traffic shape. With no TLS there are no records, so there is nothing
  // for it to do, and the server rejects a client that announces it anyway.
  //
  // Panels stamp flow onto EVERY node in a subscription, plain-TCP ones included, and correct
  // clients drop it when the node has no TLS. We passed it through, and the whole
  // subscription's TCP nodes died identically:
  //
  //   connection: open connection to ... using outbound/vless[proxy]: EOF
  //
  // sing-box does not catch this. libbox.CheckConfig accepts flow-without-TLS and returns nil,
  // so it is a wire-level failure with no config-level warning - which is exactly why the
  // fixture emitter asserts it separately (scripts/emit-config-fixtures.mts).
  const flow = params.get('flow');
  if (flow && tls) outbound.flow = flow;

  const transport = transportFromParams(params);
  if (transport) outbound.transport = transport;

  return {
    name: decodeURIComponent(u.hash.slice(1)) || host,
    protocol: 'VLESS',
    transport: describeTransport(params),
    outbound,
  };
}

function parseTrojan(uri: string): ParsedNode {
  const u = new URL(uri);
  const params = u.searchParams;
  const host = u.hostname;

  const outbound: Record<string, unknown> = {
    type: 'trojan',
    tag: 'proxy',
    server: host,
    server_port: Number(u.port) || 443,
    password: decodeURIComponent(u.username),
  };

  // Trojan is TLS by definition; build a block even when the link omits security=tls.
  outbound.tls = tlsFromParams(params, host) ?? {
    enabled: true,
    server_name: params.get('sni') || host,
    utls: { enabled: true, fingerprint: 'chrome' },
  };

  const transport = transportFromParams(params);
  if (transport) outbound.transport = transport;

  return {
    name: decodeURIComponent(u.hash.slice(1)) || host,
    protocol: 'Trojan',
    transport: describeTransport(params),
    outbound,
  };
}

/** vmess:// is base64 of a JSON blob rather than a real URI. */
function parseVmess(uri: string): ParsedNode {
  const raw = uri.slice('vmess://'.length);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(base64Decode(raw));
  } catch {
    throw new SubscriptionError('vmess link is not valid base64 JSON');
  }

  const host = String(json.add ?? '');
  const net = String(json.net ?? 'tcp').toLowerCase();

  const outbound: Record<string, unknown> = {
    type: 'vmess',
    tag: 'proxy',
    server: host,
    server_port: Number(json.port) || 443,
    uuid: String(json.id ?? ''),
    security: 'auto',
    alter_id: Number(json.aid) || 0,
  };

  if (String(json.tls ?? '').toLowerCase() === 'tls') {
    outbound.tls = {
      enabled: true,
      server_name: String(json.sni || json.host || host),
      utls: { enabled: true, fingerprint: 'chrome' },
    };
  }

  if (net === 'ws') {
    outbound.transport = {
      type: 'ws',
      path: String(json.path || '/'),
      ...(json.host ? { headers: { Host: String(json.host) } } : {}),
    };
  } else if (net === 'grpc') {
    outbound.transport = { type: 'grpc', service_name: String(json.path || '') };
  }

  return {
    name: String(json.ps || host),
    protocol: 'VMess',
    transport: net === 'tcp' ? (outbound.tls ? 'TLS' : 'TCP') : net.toUpperCase(),
    outbound,
  };
}

/** ss:// — SIP002 (base64 userinfo) and the older fully-base64 form. */
function parseShadowsocks(uri: string): ParsedNode {
  let body = uri.slice('ss://'.length);
  let tag = '';
  const hashIndex = body.indexOf('#');
  if (hashIndex >= 0) {
    tag = decodeURIComponent(body.slice(hashIndex + 1));
    body = body.slice(0, hashIndex);
  }
  body = body.split('?')[0];

  let method: string;
  let password: string;
  let host: string;
  let port: number;

  if (body.includes('@')) {
    const at = body.lastIndexOf('@');
    const userinfo = body.slice(0, at);
    const hostport = body.slice(at + 1);
    const decoded = userinfo.includes(':') ? userinfo : base64Decode(userinfo);
    const colon = decoded.indexOf(':');
    if (colon < 0) throw new SubscriptionError('ss link has malformed credentials');
    method = decoded.slice(0, colon);
    password = decoded.slice(colon + 1);
    const portColon = hostport.lastIndexOf(':');
    host = hostport.slice(0, portColon);
    port = Number(hostport.slice(portColon + 1));
  } else {
    const decoded = base64Decode(body);
    const at = decoded.lastIndexOf('@');
    const creds = decoded.slice(0, at);
    const hostport = decoded.slice(at + 1);
    const colon = creds.indexOf(':');
    method = creds.slice(0, colon);
    password = creds.slice(colon + 1);
    const portColon = hostport.lastIndexOf(':');
    host = hostport.slice(0, portColon);
    port = Number(hostport.slice(portColon + 1));
  }

  return {
    name: tag || host,
    protocol: 'Shadowsocks',
    transport: method,
    outbound: {
      type: 'shadowsocks',
      tag: 'proxy',
      server: host,
      server_port: port || 8388,
      method,
      password,
    },
  };
}

function parseHysteria2(uri: string): ParsedNode {
  const u = new URL(uri);
  const params = u.searchParams;
  const host = u.hostname;

  const outbound: Record<string, unknown> = {
    type: 'hysteria2',
    tag: 'proxy',
    server: host,
    server_port: Number(u.port) || 443,
    password: decodeURIComponent(u.username || u.password || ''),
    tls: {
      enabled: true,
      server_name: params.get('sni') || host,
      ...(params.get('insecure') === '1' ? { insecure: true } : {}),
    },
  };

  const obfs = params.get('obfs');
  if (obfs === 'salamander' && params.get('obfs-password')) {
    outbound.obfs = { type: 'salamander', password: params.get('obfs-password') };
  }

  return {
    name: decodeURIComponent(u.hash.slice(1)) || host,
    protocol: 'Hysteria2',
    transport: 'QUIC',
    outbound,
  };
}

function parseTuic(uri: string): ParsedNode {
  const u = new URL(uri);
  const params = u.searchParams;
  const host = u.hostname;

  return {
    name: decodeURIComponent(u.hash.slice(1)) || host,
    protocol: 'TUIC',
    transport: 'QUIC',
    outbound: {
      type: 'tuic',
      tag: 'proxy',
      server: host,
      server_port: Number(u.port) || 443,
      uuid: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password || ''),
      congestion_control: params.get('congestion_control') || 'bbr',
      tls: {
        enabled: true,
        server_name: params.get('sni') || host,
        ...(params.get('allow_insecure') === '1' ? { insecure: true } : {}),
        ...(params.get('alpn') ? { alpn: params.get('alpn')!.split(',') } : {}),
      },
    },
  };
}

function parseUri(uri: string): ParsedNode {
  const scheme = uri.slice(0, uri.indexOf(':')).toLowerCase();
  switch (scheme) {
    case 'vless':
      return parseVless(uri);
    case 'trojan':
      return parseTrojan(uri);
    case 'vmess':
      return parseVmess(uri);
    case 'ss':
      return parseShadowsocks(uri);
    case 'hysteria2':
    case 'hy2':
      return parseHysteria2(uri);
    case 'tuic':
      return parseTuic(uri);
    default:
      throw new SubscriptionError(`Unsupported protocol: ${scheme}`);
  }
}

// ---------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------

export interface ParseResult {
  nodes: ServerNode[];
  /** URIs we could not parse, with the reason. Surfaced, never swallowed. */
  failures: Array<{ uri: string; reason: string }>;
}

/**
 * Parse a subscription body into nodes.
 *
 * Partial success is the normal case: subscriptions routinely mix protocols, and a link we
 * cannot parse should cost the user that one node, not the whole subscription. Failures are
 * returned rather than logged away, so the UI can say "18 of 20 imported" honestly instead of
 * quietly dropping two.
 */
export function parseSubscription(body: string, sourceId: string): ParseResult {
  const uris = decodeBody(body);
  const nodes: ServerNode[] = [];
  const failures: Array<{ uri: string; reason: string }> = [];

  uris.forEach((uri, index) => {
    try {
      const parsed = parseUri(uri);
      nodes.push({
        id: `${sourceId}-${index}`,
        name: parsed.name,
        flag: '🌐',
        country: String((parsed.outbound as { server?: string }).server ?? ''),
        transport: parsed.transport,
        protocol: parsed.protocol,
        pingMs: null,
        uri,
        config: buildConfig(parsed.outbound),
      });
    } catch (e) {
      failures.push({
        uri: uri.slice(0, 60),
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return { nodes, failures };
}

/**
 * Import one pasted proxy URI, with no network involved.
 *
 * Shares every parser with the subscription path, so a link that works in a subscription works
 * here and vice versa — and there is exactly one place where a protocol is implemented.
 */
/**
 * Pull every proxy URI out of arbitrary pasted text.
 *
 * Users do not paste clean lists. They paste a Telegram message with a channel banner, three
 * lines of prose in whatever language the channel is written in, five links and an advert -
 * and expect the links to be found. So this
 * scans rather than splits: a URI cannot contain whitespace or a quote, which makes the run of
 * non-space characters after a known scheme an exact match.
 *
 * Handles the base64 case too, because a subscription body pasted directly into the box is a
 * single opaque blob with no visible scheme. That is tried only when scanning finds nothing,
 * so ordinary text is never mangled by a speculative decode.
 *
 * Duplicates are collapsed. Pasting an overlapping list twice is normal, and the importer
 * hashes the URI into the node id anyway, so keeping both would be a list with two identical
 * rows rather than two servers.
 */
/**
 * Every scheme the parsers understand, LONGEST FIRST.
 *
 * Order is load-bearing in two places: alternation in a regex is first-match rather than
 * longest-match, and the boundary scanner below relies on finding the longest scheme that ends
 * at a given "://". With `hysteria` ahead of `hysteria2`, a hysteria2 link would be recognised
 * as `hysteria` and the stray `2` would corrupt the URI before it.
 */
const URI_SCHEMES = [
  'hysteria2',
  'hysteria',
  'vless',
  'vmess',
  'trojan',
  'anytls',
  'ssr',
  'hy2',
  'tuic',
  'ss',
] as const;

/**
 * Byte offsets in `run` where a proxy URI begins.
 *
 * WHY THIS IS NOT A LOOKAHEAD SPLIT
 *
 * The obvious implementation is `run.split(/(?=(?:vless|vmess|ss|…):\/\/)/)`, and it is wrong
 * in a way that only shows up on real input: SEVERAL SCHEME NAMES CONTAIN OTHERS. `vless://`
 * ends in `ss://`, and so does `vmess://`. A lookahead therefore fires inside them and splits
 * `vless://host` into `vle` + `ss://host` — turning every VLESS and VMess link in the paste
 * into a bogus Shadowsocks one. (Caught by the glued-paste test, which reported three `ss://`
 * URIs for a vless/vmess/trojan input.)
 *
 * A lookbehind (`(?<![a-z0-9])`) does not fix it either: it cannot tell `vless://` (one URI)
 * from `#Name1vmess://` (two), because both have an alphanumeric in front of the inner match.
 *
 * So: locate every `://`, then walk BACKWARDS to find the longest known scheme ending there.
 * That is the actual rule — `vless` wins over `ss` at the same colon — and it needs no
 * lookbehind, which keeps this working on older WebViews.
 */
function uriStartOffsets(run: string): number[] {
  const offsets: number[] = [];
  const lower = run.toLowerCase();

  for (let colon = lower.indexOf('://'); colon !== -1; colon = lower.indexOf('://', colon + 1)) {
    for (const scheme of URI_SCHEMES) {
      const startsAt = colon - scheme.length;
      if (startsAt >= 0 && lower.startsWith(scheme, startsAt)) {
        offsets.push(startsAt);
        // URI_SCHEMES is longest-first, so the first hit is the longest. Stop, or `ss` would
        // also match at this same colon and add a spurious boundary inside `vless://`.
        break;
      }
    }
  }
  return offsets;
}

/**
 * Characters that cannot appear in a proxy URI, so the first one ends it.
 *
 * A REGEX LITERAL, DELIBERATELY. This was `new RegExp(`[^\s<>"'\`]+`)` built from a template
 * literal, and inside a template literal `\s` is just the letter `s` - the backslash is eaten
 * by the string and never reaches the regex engine. The character class therefore excluded
 * **s**, so every URI was truncated at its first `s`: `?type=ws` became `?type=w`, and a vmess
 * base64 payload was cut to its first `s`. Counts still looked right, so a test that only
 * checked how many URIs were found reported success on corrupted output.
 *
 * Nothing here needs interpolation, so nothing here gets a template literal.
 */
const URI_TERMINATOR = /[\s<>"'`]/;

export function extractConfigUris(text: string): string[] {
  /**
   * Cut the input into URIs at scheme boundaries.
   *
   * Boundary-driven rather than match-driven: uriStartOffsets already knows where every URI
   * begins, so a URI runs from its own offset to whichever comes first - the next offset, or a
   * character that cannot be in a URI. That handles both shapes of paste with one rule:
   *
   *   whitespace-separated   the terminator ends each one
   *   glued, zero whitespace the next offset ends it
   *
   * Nothing in a proxy URI's syntax terminates it - the `#name` fragment runs to the next
   * whitespace - so `…#Name1vmess://…` really is one unbroken run, and people paste exactly
   * that: channel posts whose newlines were eaten on the way through a web view.
   */
  const scan = (input: string): string[] => {
    const offsets = uriStartOffsets(input);

    return offsets
      .map((from, i) => {
        const candidate = input.slice(from, offsets[i + 1] ?? input.length);
        const terminator = candidate.search(URI_TERMINATOR);
        return terminator === -1 ? candidate : candidate.slice(0, terminator);
      })
      // Trailing punctuation from prose - "use vless://…, it is fast" - is not part of the
      // URI. A '#' fragment is, so only strip what cannot legally end one.
      .map((uri) => uri.replace(/[),.;'"]+$/, ''))
      // Every offset came from a known scheme, so the only thing left to check is that there
      // is something after the separator.
      .filter((uri) => {
        const body = uri.slice(uri.indexOf('://') + 3);
        return body.length > 0;
      });
  };

  const direct = scan(text);
  if (direct.length > 0) return [...new Set(direct)];

  // No scheme in sight: it may be a base64 subscription body.
  const decoded = (() => {
    try {
      return base64Decode(text.trim());
    } catch {
      return '';
    }
  })();

  return decoded ? [...new Set(scan(decoded))] : [];
}

export function parseSingleConfig(uri: string): ServerNode {
  const trimmed = uri.trim();
  if (!trimmed) throw new SubscriptionError('Paste a config link first');

  const parsed = parseUri(trimmed);
  return {
    id: `manual-${hashString(trimmed)}`,
    name: parsed.name,
    flag: '📋',
    country: String((parsed.outbound as { server?: string }).server ?? ''),
    transport: parsed.transport,
    protocol: parsed.protocol,
    pingMs: null,
    uri: trimmed,
    config: buildConfig(parsed.outbound),
  };
}

/**
 * Rebuild a node's config from the URI it was imported from.
 *
 * Used on load so that a change to buildConfig() reaches data already in storage. Returns the
 * node unchanged when it has no URI (the built-in demo nodes) or when the URI no longer parses,
 * because a node that still works with a stale config beats a node that vanishes.
 */
export function rebuildNodeConfig(node: ServerNode): ServerNode {
  // Only stored nodes reach this function (useSubscriptions rehydrates through it); the
  // built-in demo nodes are generated fresh each run and never persisted. So a stored node
  // with no URI was imported by a build that did not keep one, and its config can never be
  // regenerated - it is frozen at whatever that build produced.
  if (!node.uri) {
    return { ...node, staleReason: 'imported before the source link was kept; re-import it' };
  }

  try {
    const parsed = parseUri(node.uri);
    const { staleReason: _dropped, ...rest } = node;
    return { ...rest, config: buildConfig(parsed.outbound) };
  } catch (e) {
    // DO NOT SWALLOW THIS.
    //
    // The old code returned the node unchanged on any parse error, which meant a node kept
    // running a config generated by whatever build imported it - forever, invisibly. Every
    // later fix to buildConfig or to the URI parsers simply did not reach it, and the
    // resulting failure looks like a dead server rather than a stale config.
    //
    // It also swallows deliberate rejections. The `headerType` guard in transportFromParams
    // throws precisely so an unsupported node is not run; landing here silently would have
    // kept running the very config that guard exists to stop.
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[nexus] cannot rebuild "${node.name}" from its URI: ${reason}`);
    return { ...node, staleReason: reason };
  }
}

/** Fetch + parse in one call. */
export async function importSubscription(
  source: SubscriptionSource,
): Promise<ParseResult & { name: string; userinfo: SubscriptionUserinfo | null }> {
  const { body, userinfo } = await fetchSubscription(source.url);
  const sourceId = `sub-${hashString(source.url)}`;
  const result = parseSubscription(body, sourceId);

  if (result.nodes.length === 0) {
    throw new SubscriptionError(
      result.failures.length > 0
        ? `No usable nodes. First problem: ${result.failures[0].reason}`
        : 'No proxy links found in the subscription',
    );
  }

  let name = source.name;
  if (!name) {
    try {
      name = new URL(source.url).hostname;
    } catch {
      name = 'Subscription';
    }
  }

  return { ...result, name, userinfo };
}

/** Small non-cryptographic hash, only for generating stable node ids from a URL. */
function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
