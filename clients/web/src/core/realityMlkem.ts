import { realityOfUri, rebuildNodeConfig } from './subscription';
import type { ServerNode } from '../data/servers';

/**
 * The per-node REALITY ML-KEM switch. OFF for every node unless the user turns it on, or a
 * check finds the server refuses to connect without it (AUTOMATIC DETECTION, at the end).
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

/** 'auto': ON because a check found the server needs it (see AUTOMATIC DETECTION below). */
export type RealityMlkemState = 'unsupported' | 'link' | 'off' | 'on' | 'auto';

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

export function realityMlkemState(
  node: ServerNode,
  keys: ReadonlySet<string>,
  origins: ReadonlyMap<string, RealityMlkemOrigin> = NO_ORIGINS,
): RealityMlkemState {
  const reality = node.uri === undefined ? null : realityOfUri(node.uri);
  if (reality === null) return 'unsupported';
  if (reality.optIn) return 'link';
  if (!switchedOn(node, keys)) return 'off';
  const key = node.uri === undefined ? null : realityMlkemKey(node.uri);
  return key !== null && origins.get(key) === 'auto-on' ? 'auto' : 'on';
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

// ---------------------------------------------------------------------------------------
// AUTOMATIC DETECTION
// ---------------------------------------------------------------------------------------
//
// Measured against real Xray servers (core/nexuscore/vless_encryption_matrix_test.go): a
// v26.9.8+ REALITY server rejects every hello without the X25519MLKEM768 key share
// ("authentication failed"), and an older server accepts it either way. So turning the share
// on can only help - but the user chose to keep it OFF until a server shows it needs it.
//
// A server shows it when a probe of its config without the share ends in "Handshake failed"
// and a probe of the same config with it succeeds. Two places run that check: Test All
// (serverTests.ts retries such a failure with the share) and the first Connect to a server no
// check has looked at yet (realityMlkemCheck.ts). A positive verdict turns the switch on
// through the same key set as the user's switch, so everything that already reads it - the
// config Connect starts, the Delay probe, a refresh, the tile's replay of the last config -
// follows with no change.
//
// Who set the switch is kept beside it, keyed the same way:
//   absent      nobody yet. OFF; the next check may decide.
//   'auto-on'   a check found the server needs the share. ON, shown as "turned on automatically".
//   'auto-off'  a check found the server accepts a hello without it. OFF; a later Test All that
//               sees "Handshake failed" may still turn it on (the server was upgraded).
//   'user'      the user flipped the switch. Never changed by a check again.

export type RealityMlkemOrigin = 'auto-on' | 'auto-off' | 'user';

const ORIGINS_KEY = 'nexus.realityMlkem.origin.v1';
const NO_ORIGINS: ReadonlyMap<string, RealityMlkemOrigin> = new Map();

export function loadRealityMlkemOrigins(): Map<string, RealityMlkemOrigin> {
  try {
    const raw = localStorage.getItem(ORIGINS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const origins = new Map<string, RealityMlkemOrigin>();
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (value === 'auto-on' || value === 'auto-off' || value === 'user') origins.set(key, value);
      }
    }
    return origins;
  } catch {
    // Unreadable: no node has been checked. The switch set itself is untouched.
    return new Map();
  }
}

export function saveRealityMlkemOrigins(origins: ReadonlyMap<string, RealityMlkemOrigin>): void {
  try {
    localStorage.setItem(ORIGINS_KEY, JSON.stringify(Object.fromEntries(origins)));
  } catch {
    // Non-fatal; the in-memory map still holds for this session.
  }
}

/**
 * May a check turn this node's switch on? REALITY with a key, not opted in by its link, OFF,
 * and never set by the user.
 */
export function realityMlkemCheckable(
  node: ServerNode,
  keys: ReadonlySet<string>,
  origins: ReadonlyMap<string, RealityMlkemOrigin>,
): boolean {
  if (realityMlkemState(node, keys) !== 'off') return false;
  const key = node.uri === undefined ? null : realityMlkemKey(node.uri);
  return key !== null && origins.get(key) !== 'user';
}

/** Checkable and never checked: Connect looks at it before starting. */
export function realityMlkemUnchecked(
  node: ServerNode,
  keys: ReadonlySet<string>,
  origins: ReadonlyMap<string, RealityMlkemOrigin>,
): boolean {
  const key = node.uri === undefined ? null : realityMlkemKey(node.uri);
  return key !== null && realityMlkemCheckable(node, keys, origins) && !origins.has(key);
}

/** The node with the share offered: what a check probes beside the node as it is. */
export function realityMlkemVariant(node: ServerNode): ServerNode {
  return rebuildNodeConfig(node, true);
}

/**
 * What two probes of one server say. `without` is the node as it is; `withShare` the same node
 * with the key share (null when it was not probed). True: the server needs the share. False: it
 * accepts the node without it. Null: no verdict - the server failed for some other reason
 * (down, wrong credentials, blocked), and the switch is left alone.
 */
export function realityMlkemVerdict(without: string, withShare: string | null): boolean | null {
  if (without === 'ok') return false;
  if (without === 'handshake_failed' && withShare === 'ok') return true;
  return null;
}

/**
 * The switch set and origins with a check's verdict applied, or null when nothing changes:
 * the node is not checkable, or it already holds that verdict.
 */
export function withRealityMlkemVerdict(
  keys: ReadonlySet<string>,
  origins: ReadonlyMap<string, RealityMlkemOrigin>,
  node: ServerNode,
  needed: boolean,
): { keys: Set<string>; origins: Map<string, RealityMlkemOrigin> } | null {
  const key = node.uri === undefined ? null : realityMlkemKey(node.uri);
  if (key === null || !realityMlkemCheckable(node, keys, origins)) return null;
  if (!needed && origins.get(key) === 'auto-off') return null;
  const nextKeys = new Set(keys);
  const nextOrigins = new Map(origins);
  if (needed) nextKeys.add(key);
  nextOrigins.set(key, needed ? 'auto-on' : 'auto-off');
  return { keys: nextKeys, origins: nextOrigins };
}

/** The origins with the user's own choice recorded for this node: no check touches it again. */
export function withRealityMlkemUserChoice(
  origins: ReadonlyMap<string, RealityMlkemOrigin>,
  node: ServerNode,
): Map<string, RealityMlkemOrigin> {
  const next = new Map(origins);
  const key = node.uri === undefined ? null : realityMlkemKey(node.uri);
  if (key !== null) next.set(key, 'user');
  return next;
}

/** carryRealityMlkem for the origins: an edit that changes the identity keeps who set it. */
export function carryRealityMlkemOrigin(
  origins: ReadonlyMap<string, RealityMlkemOrigin>,
  original: ServerNode,
  updated: ServerNode,
): ReadonlyMap<string, RealityMlkemOrigin> {
  const from = original.uri === undefined ? null : realityMlkemKey(original.uri);
  const to = updated.uri === undefined ? null : realityMlkemKey(updated.uri);
  const origin = from === null ? undefined : origins.get(from);
  if (origin === undefined || to === null || to === from || origins.has(to)) return origins;
  return new Map(origins).set(to, origin);
}
