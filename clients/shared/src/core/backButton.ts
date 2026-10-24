import { useEffect, useRef } from 'react';

/**
 * Escape on desktop: close the sheet on top - the last one opened first (useBackClose). The
 * same module as clients/web's, minus Android's back button: a desktop window has none, and
 * Escape never switches tabs or minimises.
 *
 * ONE keydown listener for the app's lifetime, registered here and never removed. Components
 * only push and pop close handlers.
 */

type Close = () => void;

/** The stack logic, without any platform: what the checks drive. */
export function createBackStack() {
  const stack: Close[] = [];
  let fallback: (() => boolean) | null = null;
  return {
    /** Adds a close handler on top; returns its removal. Removing twice is harmless. */
    push(close: Close): () => void {
      stack.push(close);
      return () => {
        const index = stack.lastIndexOf(close);
        if (index >= 0) stack.splice(index, 1);
      };
    },
    /** What to do with nothing open; true when it handled the press. */
    setFallback(next: (() => boolean) | null): void {
      fallback = next;
    },
    /** One back press. 'closed': a sheet closed; 'fallback': the app handled it; 'none': neither. */
    handle(): 'closed' | 'fallback' | 'none' {
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        top();
        return 'closed';
      }
      return fallback?.() ? 'fallback' : 'none';
    },
    get size(): number {
      return stack.length;
    },
  };
}

const back = createBackStack();
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (event) => {
    // Escape closes sheets only; it never switches tabs or minimises.
    if (event.key === 'Escape' && back.size > 0) {
      event.preventDefault();
      back.handle();
    }
  });
}

/** App's fallback with nothing open: true when it handled the press (e.g. went to Home). */
export function setBackFallback(fallback: (() => boolean) | null): void {
  install();
  back.setFallback(fallback);
}

/**
 * While `open`, back (and Escape) calls `onClose`. The newest open sheet closes first. The
 * handler reads `onClose` through a ref, so a re-render does not move a sheet above one opened
 * over it.
 */
export function useBackClose(open: boolean, onClose: () => void): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!open) return;
    install();
    return back.push(() => latest.current());
  }, [open]);
}
