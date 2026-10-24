/**
 * Undo for deleting a subscription or a manually added config, the way Telegram does it: the
 * item goes at once, a bar offers Undo for UNDO_WINDOW_MS, and Undo puts it back where it was.
 *
 * The deletion itself is written to storage immediately, exactly as before this existed. Undo is
 * a re-insert, not a delayed delete: if the app is killed during the window, the item stays
 * deleted, which is what the user asked for. "Becoming final" is only the bar going away.
 *
 * Pure, so scripts/check-undo-delete.mts can test it. useSubscriptions.restore/restoreManual put
 * items back with restoreAt; Toast.tsx's undo bar keeps at most one pending undo with nextUndo
 * and takeUndo.
 */

/** How long a deletion can be undone. */
export const UNDO_WINDOW_MS = 10_000;

/**
 * `list` with `item` back at `index`, the position it had when it was deleted, clamped to the
 * list as it is now. Null when an entry that is the same thing is already there (`same`; by
 * default the same id): it was added again meanwhile, and restoring would duplicate it.
 */
export function restoreAt<T extends { id: string }>(
  list: readonly T[],
  item: T,
  index: number,
  same: (a: T, b: T) => boolean = (a, b) => a.id === b.id,
): T[] | null {
  if (list.some((entry) => same(entry, item))) return null;
  const at = Number.isFinite(index) ? Math.max(0, Math.min(Math.trunc(index), list.length)) : list.length;
  return [...list.slice(0, at), item, ...list.slice(at)];
}

/**
 * Two subscriptions are the same thing when they share the id or the URL: adding a URL that is
 * already in the list replaces that record (useSubscriptions.importInto).
 */
export function sameSubscription(a: { id: string; url: string }, b: { id: string; url: string }): boolean {
  return a.id === b.id || a.url === b.url;
}

/** The one deletion that can still be undone. */
export interface PendingUndo {
  /** Increases with every deletion, never reused, so an Undo tap is matched to its own bar. */
  seq: number;
  message: string;
  /** Epoch millis when the deletion becomes final. */
  deadline: number;
  undo: () => void;
}

/**
 * A new deletion, numbered after `lastSeq` (the last one ever offered, pending or not). It
 * replaces whatever is pending: a second delete makes the earlier one final, as in Telegram, so
 * there is never more than one Undo on screen.
 */
export function nextUndo(lastSeq: number, message: string, undo: () => void, now: number): PendingUndo {
  return { seq: lastSeq + 1, message, deadline: now + UNDO_WINDOW_MS, undo };
}

/**
 * The undo to run for a tap on bar `seq`, or null: the bar was replaced by a later deletion, or
 * the window has closed. Running a replaced bar's undo would bring back the wrong item.
 */
export function takeUndo(current: PendingUndo | null, seq: number, now: number): (() => void) | null {
  if (current === null || current.seq !== seq || now >= current.deadline) return null;
  return current.undo;
}

/** Whole seconds left on the countdown, as shown: 10 right after the delete, 0 when final. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
