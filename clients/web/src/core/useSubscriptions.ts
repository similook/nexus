import { useCallback, useState } from 'react';
import {
  importSubscription,
  isInsecureUrl,
  parseSingleConfig,
  rebuildNodeConfig,
  SubscriptionError,
  type SubscriptionUserinfo,
} from './subscription';
import type { ServerNode } from '../data/servers';

/**
 * Imported subscriptions, persisted across launches.
 *
 * Storage is localStorage rather than @capacitor/preferences: the WebView's localStorage is
 * already private to the app sandbox, persists across launches, and needs no extra dependency
 * or native round-trip. If we ever need these readable from the native side, Preferences is the
 * upgrade — but nothing needs that today.
 *
 * NOT ENCRYPTED. A subscription body contains server addresses, UUIDs and passwords, so this is
 * credential material sitting in the app's data directory. That is the same exposure every
 * client of this kind has (the config has to be readable to be usable), and it is protected by
 * the Android app sandbox — but it is worth knowing before anyone suggests syncing it anywhere.
 */

// v2: records now carry the source URI per node. v1 records cannot have their configs
// regenerated, so they are dropped rather than replayed with a stale config - which is the
// failure this version exists to end.
const STORAGE_KEY = 'nexus.subscriptions.v2';

export interface SubscriptionRecord {
  id: string;
  url: string;
  name: string;
  /** Epoch millis of the last successful fetch. */
  updatedAt: number;
  nodes: ServerNode[];
  /** True for http:// sources — surfaced in the UI on every render, not just at import. */
  insecure: boolean;
  /** Quota/expiry from the Subscription-Userinfo header. Null when the panel sent none. */
  userinfo: SubscriptionUserinfo | null;
}

/** Manually pasted single configs, kept separately from any subscription. */
const MANUAL_KEY = 'nexus.manualNodes.v2';

function loadManual(): ServerNode[] {
  try {
    const raw = localStorage.getItem(MANUAL_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ServerNode[]).map(rebuildNodeConfig) : [];
  } catch {
    return [];
  }
}

function load(): SubscriptionRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Shape-check rather than trust: this survives an app upgrade that changed the schema, and
    // a half-written record should cost the user one subscription, not a blank screen.
    return parsed
      .filter(
        (r): r is SubscriptionRecord =>
          !!r && typeof r.id === 'string' && typeof r.url === 'string' && Array.isArray(r.nodes),
      )
      // Regenerate every config from its URI on load. Without this, a fix to buildConfig()
      // only reaches nodes imported after the fix - which is how a device ends up running a
      // config that no longer exists anywhere in the source tree.
      .map((r) => ({ ...r, nodes: r.nodes.map(rebuildNodeConfig) }));
  } catch {
    return [];
  }
}

function save(records: SubscriptionRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Quota exceeded, or storage disabled. Non-fatal: the in-memory list still works for this
    // session. Failing the import over a storage error would be worse than forgetting it.
  }
}

export interface UseSubscriptions {
  /**
   * False until the stored lists have been read.
   *
   * Consumers MUST NOT treat an empty `nodes` as "the user has no servers" while this is
   * false. Clearing persisted state on an unhydrated pass is what made the selected server
   * reset on every relaunch.
   */
  hydrated: boolean;
  subscriptions: SubscriptionRecord[];
  /** Manually pasted single configs. */
  manualNodes: ServerNode[];
  /** Every node the user has, from any source. */
  nodes: ServerNode[];
  busy: boolean;
  add: (url: string) => Promise<{ imported: number; failed: number }>;
  addManual: (uri: string) => ServerNode;
  /**
   * Import many pasted configs in one go.
   *
   * Returns what happened rather than throwing on the first bad link: a paste from a channel
   * usually contains a dead or malformed entry, and refusing the whole batch over one of them
   * would be useless. `failures` carries the reasons so the UI can say more than "some failed".
   */
  addManualBatch: (uris: string[]) => {
    imported: number;
    failed: number;
    failures: Array<{ uri: string; reason: string }>;
  };
  refresh: (id: string) => Promise<{ imported: number; failed: number }>;
  remove: (id: string) => void;
  removeManual: (id: string) => void;
  /**
   * Replace one node with an edited version.
   *
   * An edit changes the node's ID, because the ID is a hash of its source URI. So this is a
   * remove plus an add rather than a mutation, and it has to happen in ONE write or the list
   * flickers through a state where neither version exists.
   *
   * Works on subscription nodes as well as manual ones. An edited subscription node is stored
   * as a manual node: the next refresh of that subscription regenerates its list from the
   * server and would silently discard the edit, so promoting it out of the subscription is the
   * only way to make the change survive.
   */
  replaceNode: (id: string, updated: ServerNode) => void;
}

export function useSubscriptions(): UseSubscriptions {
  /*
   * HYDRATED SYNCHRONOUSLY, via the lazy useState initialiser.
   *
   * These used to start as [] and fill in from a useEffect, which gave every cold start one
   * render with an empty node list. Anything reading the list on that pass saw a user with no
   * servers - and App's auto-selection reacted by clearing the persisted choice, so the
   * selection survived the session but was gone by the next launch. The symptom was "it
   * forgets my server when I swipe the app away".
   *
   * localStorage is synchronous. There was never a reason to defer this to an effect, and
   * deferring it created a state the rest of the app had to be careful about.
   */
  const [subscriptions, setSubscriptions] = useState<SubscriptionRecord[]>(load);
  const [manualNodes, setManualNodes] = useState<ServerNode[]>(loadManual);
  const [busy, setBusy] = useState(false);

  /*
   * Belt and braces for whoever makes this asynchronous again.
   *
   * It is `true` from the first render today. It exists so consumers can express "the list is
   * genuinely empty" rather than "the list has not loaded", which is the distinction that was
   * missing - and if storage ever moves to Capacitor Preferences (which IS async), this is the
   * flag that keeps the bug from coming back.
   */
  const hydrated = true;

  const persist = useCallback((next: SubscriptionRecord[]) => {
    setSubscriptions(next);
    save(next);
  }, []);

  const importInto = useCallback(
    async (url: string, existingId?: string) => {
      setBusy(true);
      try {
        const result = await importSubscription({ url });
        const record: SubscriptionRecord = {
          id: existingId ?? `sub-${Date.now().toString(36)}`,
          url,
          name: result.name,
          updatedAt: Date.now(),
          nodes: result.nodes,
          insecure: isInsecureUrl(url),
          userinfo: result.userinfo,
        };

        // Read the current list inside the updater rather than closing over `subscriptions`:
        // an import is async, and the list can change while it is in flight.
        setSubscriptions((prev) => {
          const next = existingId
            ? prev.map((r) => (r.id === existingId ? record : r))
            : [...prev.filter((r) => r.url !== url), record];
          save(next);
          return next;
        });

        return { imported: result.nodes.length, failed: result.failures.length };
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const add = useCallback(
    (url: string) => {
      const trimmed = url.trim();
      if (!trimmed) throw new SubscriptionError('Enter a link first');
      return importInto(trimmed);
    },
    [importInto],
  );

  const refresh = useCallback(
    (id: string) => {
      const record = subscriptions.find((r) => r.id === id);
      if (!record) throw new SubscriptionError('Subscription not found');
      return importInto(record.url, id);
    },
    [subscriptions, importInto],
  );

  const remove = useCallback(
    (id: string) => {
      persist(subscriptions.filter((r) => r.id !== id));
    },
    [subscriptions, persist],
  );

  const addManual = useCallback((uri: string): ServerNode => {
    const node = parseSingleConfig(uri);
    setManualNodes((prev) => {
      // Replace rather than duplicate: the id is a hash of the URI, so pasting the same link
      // twice updates one entry instead of growing the list.
      const next = [...prev.filter((n) => n.id !== node.id), node];
      try {
        localStorage.setItem(MANUAL_KEY, JSON.stringify(next));
      } catch {
        // Non-fatal; see save().
      }
      return next;
    });
    return node;
  }, []);

  const addManualBatch = useCallback((uris: string[]) => {
    const parsed: ServerNode[] = [];
    const failures: Array<{ uri: string; reason: string }> = [];

    for (const uri of uris) {
      try {
        parsed.push(parseSingleConfig(uri));
      } catch (e) {
        failures.push({ uri, reason: e instanceof Error ? e.message : 'could not be parsed' });
      }
    }

    if (parsed.length > 0) {
      setManualNodes((prev) => {
        // One write for the whole batch. Calling addManual in a loop would re-read state per
        // item and persist N times, and with React batching each intermediate write would
        // serialise a list that is already out of date.
        const incoming = new Map(parsed.map((n) => [n.id, n]));
        const kept = prev.filter((n) => !incoming.has(n.id));
        const next = [...kept, ...incoming.values()];
        try {
          localStorage.setItem(MANUAL_KEY, JSON.stringify(next));
        } catch {
          // Non-fatal; see save().
        }
        return next;
      });
    }

    return { imported: parsed.length, failed: failures.length, failures };
  }, []);

  const replaceNode = useCallback((id: string, updated: ServerNode) => {
    setSubscriptions((prev) => {
      if (!prev.some((record) => record.nodes.some((n) => n.id === id))) return prev;
      const next = prev.map((record) => ({
        ...record,
        nodes: record.nodes.filter((n) => n.id !== id),
      }));
      save(next);
      return next;
    });

    setManualNodes((prev) => {
      const next = [...prev.filter((n) => n.id !== id && n.id !== updated.id), updated];
      try {
        localStorage.setItem(MANUAL_KEY, JSON.stringify(next));
      } catch {
        // Non-fatal; see save().
      }
      return next;
    });
  }, []);

  const removeManual = useCallback((id: string) => {
    setManualNodes((prev) => {
      const next = prev.filter((n) => n.id !== id);
      try {
        localStorage.setItem(MANUAL_KEY, JSON.stringify(next));
      } catch {
        // Non-fatal.
      }
      return next;
    });
  }, []);

  const nodes = [...subscriptions.flatMap((r) => r.nodes), ...manualNodes];

  return {
    hydrated,
    subscriptions,
    manualNodes,
    nodes,
    busy,
    add,
    addManual,
    addManualBatch,
    replaceNode,
    refresh,
    remove,
    removeManual,
  };
}
