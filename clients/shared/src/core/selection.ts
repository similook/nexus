/**
 * The selected server, remembered across launches.
 *
 * Only the ID is stored. The node itself is rebuilt from its subscription on every load
 * (useSubscriptions → rebuildNodeConfig), so persisting a copy here would create a second,
 * staler version of the same node — the bug that made config fixes fail to reach nodes that
 * were already imported.
 *
 * WHY `manual` IS RECORDED ALONGSIDE IT
 *
 * The first version only wrote on an explicit tap. Auto-selected nodes were never persisted,
 * so a user who had never opened the Servers tab got a fresh lowest-ping pick on every launch
 * — which, on a list sorted the way theirs was, looked exactly like "it reset to the first
 * server".
 *
 * Writing auto-picks too fixes that, but naively it breaks something else: if a restored
 * auto-pick counts as a user choice, the lowest-ping rule fires once on first run and never
 * again, and the app stops improving its own default.
 *
 * So both are stored, and they restore differently:
 *
 *   manual: true    the user chose this. It outranks auto-selection for good.
 *   manual: false   the app chose it last time. Restored so the UI is stable across a
 *                   restart, but auto-selection may still replace it with something better.
 */

const STORAGE_KEY = 'nexus.selectedNode.v2';

export interface StoredSelection {
  id: string;
  manual: boolean;
}

export function loadSelection(): StoredSelection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return migrateV1();

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    if (id.length === 0) return null;

    return { id, manual: record.manual === true };
  } catch {
    // Private-mode, a storage-disabled WebView, or malformed JSON. Losing the preference is
    // acceptable; throwing during the first render is not.
    return null;
  }
}

/**
 * Carry over a v1 selection rather than discarding it.
 *
 * v1 stored a bare id string under a different key, and only ever wrote it on an explicit
 * tap — so anything found there was, by definition, a manual choice. Users upgrading should
 * not silently lose the server they picked.
 */
function migrateV1(): StoredSelection | null {
  try {
    const legacy = localStorage.getItem('nexus.selectedNodeId.v1');
    if (!legacy) return null;
    localStorage.removeItem('nexus.selectedNodeId.v1');
    const migrated: StoredSelection = { id: legacy, manual: true };
    saveSelection(migrated);
    return migrated;
  } catch {
    return null;
  }
}

export function saveSelection(selection: StoredSelection | null): void {
  try {
    if (selection === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Same reasoning as above.
  }
}
