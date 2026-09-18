import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface ToastState {
  icon: string;
  message: string;
}

const ToastContext = createContext<((message: string, icon?: string) => void) | null>(null);

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

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className={`absolute bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-brand-surface-card
          border border-brand-orange/60 text-xs font-semibold text-white shadow-glow-orange-sm
          pointer-events-none transition-opacity duration-300 z-50 flex items-center gap-2
          ${toast ? 'opacity-100' : 'opacity-0'}`}
      >
        <span>{toast?.icon ?? '✓'}</span>
        <span>{toast?.message ?? ''}</span>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}
