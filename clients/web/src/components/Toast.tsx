import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { nextUndo, secondsLeft, takeUndo, UNDO_WINDOW_MS, type PendingUndo } from '../core/undoDelete';

interface ToastState {
  icon: string;
  message: string;
}

const ToastContext = createContext<((message: string, icon?: string) => void) | null>(null);
const UndoContext = createContext<((message: string, undo: () => void) => void) | null>(null);

/*
 * The undo bar sits just above BottomNav, whose height is calc(4.25rem + safe-area inset); a toast
 * shown while the bar is up moves above it instead of covering it. Both live here so the two
 * bottom overlays are laid out in one place, and so the bar survives a tab switch (views unmount;
 * this provider does not).
 */
const UNDO_BAR_BOTTOM = 'calc(5rem + env(safe-area-inset-bottom, 0px))';
const TOAST_ABOVE_UNDO_BOTTOM = 'calc(8.5rem + env(safe-area-inset-bottom, 0px))';

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((message: string, icon = '✓') => {
    setToast({ message, icon });
    if (timerRef.current) clearTimeout(timerRef.current);
    // One-shot timeout, re-armed on each toast — not an interval. It clears itself.
    timerRef.current = setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // At most one pending undo; a new deletion replaces it, which makes the earlier one final.
  const [undo, setUndo] = useState<PendingUndo | null>(null);
  const undoRef = useRef<PendingUndo | null>(null);
  const seqRef = useRef(0);
  const showUndo = useCallback((message: string, run: () => void) => {
    const next = nextUndo(seqRef.current, message, run, Date.now());
    seqRef.current = next.seq;
    undoRef.current = next;
    setUndo(next);
  }, []);
  const dismissUndo = useCallback((seq: number) => {
    if (undoRef.current?.seq !== seq) return;
    undoRef.current = null;
    setUndo(null);
  }, []);
  const runUndo = useCallback((seq: number) => {
    const run = takeUndo(undoRef.current, seq, Date.now());
    dismissUndo(seq);
    run?.();
  }, [dismissUndo]);

  return (
    <ToastContext.Provider value={show}>
      <UndoContext.Provider value={showUndo}>
        {children}
      </UndoContext.Provider>
      <div
        role="status"
        aria-live="polite"
        style={undo ? { bottom: TOAST_ABOVE_UNDO_BOTTOM } : undefined}
        className={`absolute bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-brand-surface-card
          border border-brand-orange/60 text-xs font-semibold text-white shadow-glow-orange-sm
          pointer-events-none transition-opacity duration-300 z-50 flex items-center gap-2
          ${toast ? 'opacity-100' : 'opacity-0'}`}
      >
        <span>{toast?.icon ?? '✓'}</span>
        <span>{toast?.message ?? ''}</span>
      </div>
      {undo && <UndoBar key={undo.seq} pending={undo} onUndo={runUndo} onExpire={dismissUndo} />}
    </ToastContext.Provider>
  );
}

/** Ring geometry for the countdown: r = 9 in a 22×22 box. */
const RING_CIRCUMFERENCE = 2 * Math.PI * 9;

/**
 * "<name> deleted", a countdown and Undo. Keyed by the deletion, so a new one starts fresh.
 *
 * The number wakes once a second with a re-armed one-shot timeout, only while the bar is up. The
 * ring is one Web Animations run over the whole window (no timer at all), started on mount;
 * where element.animate is missing it simply stays full and the number still counts down.
 */
function UndoBar({
  pending,
  onUndo,
  onExpire,
}: {
  pending: PendingUndo;
  onUndo: (seq: number) => void;
  onExpire: (seq: number) => void;
}) {
  const [left, setLeft] = useState(() => secondsLeft(pending.deadline, Date.now()));
  const ringRef = useRef<SVGCircleElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const now = Date.now();
      const s = secondsLeft(pending.deadline, now);
      setLeft(s);
      if (s === 0) {
        onExpire(pending.seq);
        return;
      }
      // Wake at the next whole second of the countdown.
      timer = setTimeout(tick, (pending.deadline - now) % 1000 || 1000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [pending, onExpire]);

  useEffect(() => {
    const ring = ringRef.current;
    if (!ring || typeof ring.animate !== 'function') return;
    const remaining = Math.max(0, pending.deadline - Date.now());
    const from = RING_CIRCUMFERENCE * (1 - remaining / UNDO_WINDOW_MS);
    const animation = ring.animate(
      [{ strokeDashoffset: from }, { strokeDashoffset: RING_CIRCUMFERENCE }],
      { duration: remaining, easing: 'linear', fill: 'forwards' },
    );
    return () => animation.cancel();
  }, [pending]);

  return (
    <div
      className="absolute left-4 right-4 z-50 flex items-center gap-3 pl-3 pr-1.5 py-1.5 rounded-xl
        bg-brand-surface-card border border-brand-border text-xs text-white shadow-lg"
      style={{ bottom: UNDO_BAR_BOTTOM }}
    >
      <span className="relative w-[22px] h-[22px] shrink-0" aria-hidden="true">
        <svg className="w-[22px] h-[22px] -rotate-90" viewBox="0 0 22 22">
          <circle cx="11" cy="11" r="9" fill="none" stroke="currentColor" strokeWidth={2} className="text-brand-border" />
          <circle
            ref={ringRef}
            cx="11" cy="11" r="9" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={0}
            className="text-brand-orange"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono font-semibold tabular-nums">
          {left}
        </span>
      </span>
      <span role="status" aria-live="polite" className="flex-1 min-w-0 truncate font-semibold">
        {pending.message}
      </span>
      <button
        type="button"
        onClick={() => onUndo(pending.seq)}
        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold text-brand-orange hover:text-brand-orange-glow
          hover:bg-brand-surface active:scale-95 transition-all"
      >
        Undo
      </button>
    </div>
  );
}

export function useToast() {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}

/**
 * Offer Undo for a deletion that has already happened: `undo` runs if the user taps Undo within
 * UNDO_WINDOW_MS. A later call replaces the bar, which makes the earlier deletion final.
 */
export function useUndo() {
  const show = useContext(UndoContext);
  if (!show) throw new Error('useUndo must be used inside <ToastProvider>');
  return show;
}
