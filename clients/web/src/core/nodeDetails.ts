import { parseSingleConfig, SubscriptionError } from './subscription';
import type { ServerNode } from '../data/servers';

/**
 * Reading and editing a node's parameters.
 *
 * TWO SOURCES, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   The URI     is what the user pasted and what they can share. It is the only thing that can
 *               be edited, because an edit has to survive a re-import.
 *   The config  is what the core actually runs. It is what detail views should DISPLAY,
 *               because it is the end of the pipeline - if the parser mangled something, the
 *               config shows the mangling and the URI does not.
 *
 * So: display from the config, edit through the URI. A node with no URI (there are none today,
 * but rebuildNodeConfig tolerates it) is display-only, which is the honest outcome.
 */

export interface NodeDetail {
  label: string;
  value: string;
  /** Secrets are masked until the user asks. */
  secret?: boolean;
}

function outboundOf(node: ServerNode): Record<string, unknown> | null {
  try {
    const outbounds = (JSON.parse(node.config) as { outbounds?: Array<Record<string, unknown>> })
      .outbounds;
    return outbounds?.find((o) => o.tag === 'proxy') ?? null;
  } catch {
    return null;
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/**
 * Everything worth showing about a node, read out of the generated config.
 *
 * Empty fields are omitted rather than rendered blank: a list of twelve rows where seven say
 * "-" is harder to read than the five that apply.
 */
export function describeNode(node: ServerNode): NodeDetail[] {
  const outbound = outboundOf(node);
  if (outbound === null) return [{ label: 'Config', value: 'could not be read' }];

  const rows: NodeDetail[] = [];
  const push = (label: string, value: string, secret = false) => {
    if (value.length > 0) rows.push({ label, value, secret });
  };

  push('Remarks', node.name);
  push('Protocol', str(outbound.type).toUpperCase());
  push('Address', str(outbound.server));
  push('Port', typeof outbound.server_port === 'number' ? String(outbound.server_port) : '');

  // VLESS/VMess carry a UUID; Trojan/Shadowsocks/Hysteria2 carry a password.
  push('UUID', str(outbound.uuid), true);
  push('Password', str(outbound.password), true);
  push('Method', str(outbound.method));
  push('Flow', str(outbound.flow));

  const tls = obj(outbound.tls);
  if (tls?.enabled === true) {
    const reality = obj(tls.reality);
    push('Security', reality?.enabled === true ? 'REALITY' : 'TLS');
    push('SNI', str(tls.server_name));
    const alpn = Array.isArray(tls.alpn) ? tls.alpn.filter((a) => typeof a === 'string') : [];
    push('ALPN', alpn.join(', '));
    push('Fingerprint', str(obj(tls.utls)?.fingerprint));
    push('Public key', str(reality?.public_key), true);
    push('Short ID', str(reality?.short_id));
    if (tls.insecure === true) push('Certificate check', 'DISABLED — traffic can be intercepted');
  } else {
    push('Security', 'none');
  }

  const transport = obj(outbound.transport);
  if (transport !== null) {
    push('Transport', str(transport.type).toUpperCase());
    push('Path', str(transport.path));
    push('Service name', str(transport.service_name));
    const host = transport.host ?? obj(transport.headers)?.Host;
    push('Host header', Array.isArray(host) ? host.join(', ') : str(host));
    push('Method', str(transport.method));
  } else {
    push('Transport', 'TCP');
  }

  return rows;
}

export interface EditableFields {
  name: string;
  server: string;
  port: number;
}

/** The three fields an edit may touch, read from the node as it stands. */
export function editableOf(node: ServerNode): EditableFields {
  const outbound = outboundOf(node);
  return {
    name: node.name,
    server: str(outbound?.server),
    port: typeof outbound?.server_port === 'number' ? outbound.server_port : 443,
  };
}

/**
 * Rewrite a node's URI with new values and re-parse it into a node.
 *
 * WHY EDIT THE URI RATHER THAN THE CONFIG
 *
 * The config is derived output. Editing it directly would produce a node whose config and URI
 * disagree, and rebuildNodeConfig regenerates the config from the URI on every load - so the
 * edit would silently revert on next launch. That exact shape of bug already cost this project
 * a debugging session. Round-tripping through the URI means an edit survives.
 *
 * vmess is the awkward one: its URI is base64-encoded JSON rather than a real URL, so the same
 * three fields live under different names and have to be rewritten inside the payload.
 */
export function applyEdit(node: ServerNode, fields: EditableFields): ServerNode {
  const uri = node.uri;
  if (!uri) throw new SubscriptionError('This node has no source link, so it cannot be edited');

  const name = fields.name.trim();
  const server = fields.server.trim();
  const port = fields.port;

  if (server.length === 0) throw new SubscriptionError('Address cannot be empty');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SubscriptionError('Port must be between 1 and 65535');
  }

  const rewritten = uri.toLowerCase().startsWith('vmess://')
    ? rewriteVmess(uri, name, server, port)
    : rewriteUrlLike(uri, name, server, port);

  // Re-parse rather than patching the node: this is the same path an import takes, so an edit
  // that produces something unparseable fails here instead of at connect time.
  const reparsed = parseSingleConfig(rewritten);
  return { ...reparsed, name: name.length > 0 ? name : reparsed.name };
}

function rewriteUrlLike(uri: string, name: string, server: string, port: number): string {
  const url = new URL(uri);
  // An IPv6 literal has to keep its brackets or URL throws on assignment.
  url.hostname = server.includes(':') && !server.startsWith('[') ? `[${server}]` : server;
  url.port = String(port);
  url.hash = name.length > 0 ? `#${encodeURIComponent(name)}` : '';
  return url.toString();
}

function rewriteVmess(uri: string, name: string, server: string, port: number): string {
  const payload = uri.slice('vmess://'.length);
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(atob(payload)) as Record<string, unknown>;
  } catch {
    throw new SubscriptionError('This vmess link could not be decoded, so it cannot be edited');
  }

  decoded.add = server;
  // v2ray writes port as a string in some generators and a number in others. Keeping the
  // original type avoids surprising a parser that only accepts one of them.
  decoded.port = typeof decoded.port === 'number' ? port : String(port);
  if (name.length > 0) decoded.ps = name;

  return `vmess://${btoa(JSON.stringify(decoded))}`;
}
