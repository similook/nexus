/**
 * The user's last chosen server, remembered across launches.
 *
 * Only the ID is stored. The node itself is rebuilt from its subscription on every load
 * (useSubscriptions → rebuildNodeConfig), so persisting a copy here would create a second,
 * staler version of the same node — exactly the bug that made config fixes fail to reach
 * already-imported nodes.
 */

const STORAGE_KEY = 'nexus.selectedNodeId.v1';

export function loadSelectedId(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    // Private-mode or a storage-disabled WebView. Losing the preference is acceptable;
    // throwing on startup is not.
    return null;
  }
}

export function saveSelectedId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Same reasoning as above.
  }
}
