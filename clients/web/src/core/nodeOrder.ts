import { useCallback, useState } from 'react';
import type { ServerNode } from '../data/servers';

/**
 * The user's own order of servers within a list (a subscription's nodes, or "Manually added"),
 * set by long-press and drag in the Servers tab (components/ReorderList.tsx).
 *
 * WHAT A POSITION IS ATTACHED TO
 *
 * Not the node id: subscription node ids are list positions, which a refresh renumbers. Not the
 * link either: 3x-ui rewrites remarks with traffic figures and draws the REALITY SNI and short
 * ID at random on every fetch. The key is the node's generated proxy outbound minus exactly
 * those (tls.server_name, tls.reality.short_id, and the ML-KEM flag a switch adds), hashed. The
 * name never enters the config. So a refresh keeps the order; a server whose address, port,
 * credential, key or transport changed is a different server and goes to the end.
 *
 * Nodes the stored order does not know (new from a refresh, just added) keep the list's own
 * order after the ones it does know. Keys of removed nodes are skipped, never an error.
 */

const STORAGE_KEY = 'nexus.nodeOrder.v1';

export type NodeOrders = Record<string, string[]>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(text: string): string {
  let djb2 = 5381;
  let fnv = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    djb2 = ((djb2 << 5) + djb2 + c) >>> 0;
    fnv = Math.imul(fnv ^ c, 0x01000193) >>> 0;
  }
  return `${djb2.toString(36)}.${fnv.toString(36)}`;
}

const keys = new WeakMap<ServerNode, string>();

/** The node's order key; its id when the config has no readable proxy outbound. */
export function nodeOrderKey(node: ServerNode): string {
  const cached = keys.get(node);
  if (cached !== undefined) return cached;
  let key = `id:${node.id}`;
  try {
    const config = JSON.parse(node.config) as { outbounds?: Array<Record<string, unknown>> };
    const proxy = config.outbounds?.find((o) => o.tag === 'proxy');
    if (proxy !== undefined) {
      const tls = proxy.tls as Record<string, unknown> | undefined;
      let stable: Record<string, unknown> = proxy;
      if (tls !== undefined) {
        const { server_name: _sni, reality, ...tlsRest } = tls;
        const realityRest =
          reality !== null && typeof reality === 'object'
            ? (({ short_id: _sid, support_x25519mlkem768: _mlkem, ...rest }) => rest)(reality as Record<string, unknown>)
            : reality;
        stable = { ...proxy, tls: { ...tlsRest, reality: realityRest } };
      }
      key = `o:${hash(canonicalJson(stable))}`;
    }
  } catch {
    // Unreadable config: the id is the only identity there is.
  }
  keys.set(node, key);
  return key;
}

/** `nodes` in the stored order: known keys first, in that order; the rest in list order. */
export function applyNodeOrder<T>(nodes: readonly T[], order: readonly string[] | undefined, keyOf: (node: T) => string): T[] {
  if (order === undefined || order.length === 0) return [...nodes];
  const rank = new Map(order.map((key, index) => [key, index]));
  const known: Array<{ node: T; rank: number }> = [];
  const rest: T[] = [];
  for (const node of nodes) {
    const r = rank.get(keyOf(node));
    if (r === undefined) rest.push(node);
    else known.push({ node, rank: r });
  }
  known.sort((a, b) => a.rank - b.rank);
  return [...known.map((k) => k.node), ...rest];
}

/** A node and its key within one list. */
export interface KeyedNode {
  node: ServerNode;
  key: string;
}

/**
 * The list's nodes with unique keys: nodeOrderKey, plus "~2", "~3"... for the second and later
 * copies of the same server in the list's own order (a subscription may list one twice).
 */
export function keyedNodes(nodes: readonly ServerNode[]): KeyedNode[] {
  const seen = new Map<string, number>();
  return nodes.map((node) => {
    const base = nodeOrderKey(node);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { node, key: count === 1 ? base : `${base}~${count}` };
  });
}

/** The list as the user ordered it. */
export function orderedNodes(nodes: readonly ServerNode[], order: readonly string[] | undefined): KeyedNode[] {
  return applyNodeOrder(keyedNodes(nodes), order, (keyed) => keyed.key);
}

/** The keys of `nodes` (as displayed) with the one at `from` moved to `to`. */
export function movedOrder<T>(nodes: readonly T[], from: number, to: number, keyOf: (node: T) => string): string[] {
  const order = nodes.map(keyOf);
  if (from < 0 || from >= order.length || to < 0 || to >= order.length) return order;
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order;
}

export function loadNodeOrders(): NodeOrders {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const orders: NodeOrders = {};
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [list, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) orders[list] = value.filter((k): k is string => typeof k === 'string');
      }
    }
    return orders;
  } catch {
    // Unreadable: every list in its own order - the behaviour before reordering existed.
    return {};
  }
}

function saveNodeOrders(orders: NodeOrders): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
  } catch {
    // Non-fatal; the order holds for this session.
  }
}

/** The stored orders, and setting one list's order (`list`: a subscription id, or 'manual'). */
export function useNodeOrder() {
  const [orders, setOrders] = useState<NodeOrders>(loadNodeOrders);
  const setOrder = useCallback((list: string, order: string[]) => {
    setOrders((previous) => {
      const next = { ...previous, [list]: order };
      saveNodeOrders(next);
      return next;
    });
  }, []);
  return { orders, setOrder };
}
