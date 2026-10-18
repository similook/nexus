import { realityOfUri, rebuildNodeConfig } from './subscription';
import type { ServerNode } from '../data/servers';

/**
 * The per-node REALITY ML-KEM switch. OFF for every node unless the user turns it on.
 *
 * WHY A SWITCH AND NOT THE LINK
 *
 * Xray-core v26.9.8+ REALITY servers refuse a ClientHello without the X25519MLKEM768 key share,
 * and the core strips that share unless the outbound says support_x25519mlkem768
 * (core/patches/sing-box/README.md). Panels that predate the support-x25519mlkem768 link
 * parameter (3x-ui before v3.9.0) never write it, so their nodes fail with "Handshake failed"
 * and the user cannot fix the panel. Editing the link is no answer either: a subscription
 * refresh regenerates it from the server.
 *
 * WHAT IS STORED
 *
 * A set of node keys, separate from the nodes and the links, so that:
 *
 *   - a subscription refresh keeps it. Subscription node ids are list positions, which a panel
 *     reorders, and the link itself changes on every fetch: 3x-ui picks the SNI and the short ID
 *     at random from the inbound's lists each time, and rewrites remarks with traffic and expiry
 *     figures. The key is the node's REALITY identity instead (realityOfUri): its whole
 *     generated outbound except the SNI and short ID. Change anything else - UUID, port,
 *     key pair, fingerprint, flow, transport - and it is a different node, which starts OFF.
 *   - a node without a complete identity (no credential, no well-formed public key) has no
 *     key, so no switch, and can never pick up another node's.
 *   - the links stay exactly as imported. Share and QR hand out what the panel issued.
 *   - a link that opts in by itself ('link') needs nothing here and is never changed.
 *
 * Keys are hashes: the credential and key already sit in storage once and need not sit twice.
 *
 * WHERE IT APPLIES
 *
 * Into node.config, through rebuildNodeConfig - the config Connect starts and the Delay probe
 * tests. Applying it anywhere later would let the two disagree.
 */

// v2: keyed by REALITY identity. v1 keyed by the whole link, which every 3x-ui refresh changes;
// its keys can never match again and are left unread.
const STORAGE_KEY = 'nexus.realityMlkem.v2';

export type RealityMlkemState = 'unsupported' | 'link' | 'off' | 'on';

/** The node's switch key: two independent 32-bit hashes of its REALITY identity. Null when not REALITY. */
export function realityMlkemKey(uri: string): string | null {
  const reality = realityOfUri(uri);
  if (reality === null) return null;
  const base = reality.identity;
  let djb2 = 5381;
  let fnv = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i);
    djb2 = ((djb2 << 5) + djb2 + c) >>> 0;
    fnv = Math.imul(fnv ^ c, 0x01000193) >>> 0;
  }
  return `${djb2.toString(36)}.${fnv.toString(36)}`;
}

export function loadRealityMlkem(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    // Unreadable storage means every node is OFF - the behaviour without the switch.
    return new Set();
  }
}

export function saveRealityMlkem(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Non-fatal; the in-memory set still holds for this session.
  }
}

function switchedOn(node: ServerNode, keys: ReadonlySet<string>): boolean {
  const key = node.uri === undefined ? null : realityMlkemKey(node.uri);
  return key !== null && keys.has(key);
}

export function realityMlkemState(node: ServerNode, keys: ReadonlySet<string>): RealityMlkemState {
  const reality = node.uri === undefined ? null : realityOfUri(node.uri);
  if (reality === null) return 'unsupported';
  if (reality.optIn) return 'link';
  return switchedOn(node, keys) ? 'on' : 'off';
}

/**
 * The node rebuilt from its link with the switch applied. For loading stored nodes, which are
 * rebuilt anyway; a node whose switch is OFF gets exactly what rebuildNodeConfig always gave.
 */
export function rebuildWithRealityMlkem(node: ServerNode, keys: ReadonlySet<string>): ServerNode {
  return rebuildNodeConfig(node, switchedOn(node, keys));
}

/**
 * A freshly parsed node (import, refresh, paste, edit) with the switch applied. Nodes whose
 * switch is OFF come back as the same object, untouched.
 */
export function applyRealityMlkem(node: ServerNode, keys: ReadonlySet<string>): ServerNode {
  return switchedOn(node, keys) ? rebuildNodeConfig(node, true) : node;
}

/**
 * The key set with this node's switch turned on or off, or null when the node has no switch:
 * not REALITY, or its link already opts in.
 */
export function withRealityMlkem(
  keys: ReadonlySet<string>,
  node: ServerNode,
  on: boolean,
): Set<string> | null {
  const state = realityMlkemState(node, keys);
  const key = node.uri === undefined ? null : realityMlkemKey(node.uri);
  if (key === null || (state !== 'on' && state !== 'off')) return null;
  const next = new Set(keys);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

/**
 * Carry the switch across an edit. Changing the address or port changes the identity, and so
 * the key; without this an edit would silently turn ML-KEM off. A rename changes only the
 * #remark and keeps the key by itself.
 */
export function carryRealityMlkem(
  keys: ReadonlySet<string>,
  original: ServerNode,
  updated: ServerNode,
): ReadonlySet<string> {
  const key = updated.uri === undefined ? null : realityMlkemKey(updated.uri);
  if (!switchedOn(original, keys) || key === null || keys.has(key)) return keys;
  return new Set(keys).add(key);
}
