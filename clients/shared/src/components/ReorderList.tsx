import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

/**
 * A vertical list whose rows move by long-press and drag (Servers tab, core/nodeOrder.ts).
 *
 * Pointer events, so touch and mouse behave the same. A press becomes a drag only after
 * HOLD_MS without moving more than SLOP_PX; moving sooner is a scroll and the list stays out of
 * it. While dragging, page scrolling is blocked (a non-passive touchmove listener - React's own
 * touch listeners are passive), the other rows step aside, and the list scrolls when the row
 * nears its scroll container's edge. The tap that ends a drag does not reach the row: no
 * accidental server switch. No library: one small component.
 */

const HOLD_MS = 450;
const SLOP_PX = 8;
const EDGE_PX = 56;
const EDGE_STEP_PX = 10;

interface Drag {
  key: string;
  from: number;
  to: number;
  dy: number;
}

interface Press {
  key: string;
  index: number;
  startY: number;
  pointerId: number;
  element: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
  // Set when the drag starts.
  rects?: Array<{ top: number; height: number }>;
  scroller?: HTMLElement | null;
  startScroll?: number;
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

export function ReorderList<T>({
  items,
  itemKey,
  onMove,
  className,
  children,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  /** The row at `from` was dropped at `to` (indices into `items`). */
  onMove: (from: number, to: number) => void;
  className?: string;
  children: (item: T) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  // Block page scrolling while a row is being dragged.
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const block = (event: TouchEvent) => {
      if (dragRef.current !== null) event.preventDefault();
    };
    element.addEventListener('touchmove', block, { passive: false });
    return () => element.removeEventListener('touchmove', block);
  }, []);

  const cancelPress = () => {
    if (press.current !== null) clearTimeout(press.current.timer);
    press.current = null;
  };

  const startDrag = () => {
    const current = press.current;
    if (current === null) return;
    current.rects = items.map((item) => {
      const rect = rows.current.get(itemKey(item))?.getBoundingClientRect();
      return { top: rect?.top ?? 0, height: rect?.height ?? 0 };
    });
    current.scroller = scrollParent(current.element);
    current.startScroll = current.scroller?.scrollTop ?? 0;
    try {
      current.element.setPointerCapture(current.pointerId);
    } catch {
      // The pointer is gone already; pointerup/cancel will end it.
    }
    try {
      navigator.vibrate?.(10);
    } catch {
      // No vibration on this device or WebView.
    }
    setDrag({ key: current.key, from: current.index, to: current.index, dy: 0 });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, key: string, index: number) => {
    if (event.button !== 0 || items.length < 2) return;
    cancelPress();
    press.current = {
      key,
      index,
      startY: event.clientY,
      pointerId: event.pointerId,
      element: event.currentTarget,
      timer: setTimeout(startDrag, HOLD_MS),
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = press.current;
    if (current === null || event.pointerId !== current.pointerId) return;
    const active = dragRef.current;
    if (active === null) {
      // Moved before the hold completed: a scroll, not a drag.
      if (Math.abs(event.clientY - current.startY) > SLOP_PX) cancelPress();
      return;
    }
    const scroller = current.scroller ?? null;
    if (scroller !== null) {
      const box = scroller.getBoundingClientRect();
      if (event.clientY < box.top + EDGE_PX) scroller.scrollTop -= EDGE_STEP_PX;
      else if (event.clientY > box.bottom - EDGE_PX) scroller.scrollTop += EDGE_STEP_PX;
    }
    const rects = current.rects ?? [];
    const dy = event.clientY - current.startY + ((scroller?.scrollTop ?? 0) - (current.startScroll ?? 0));
    const from = active.from;
    const center = rects[from].top + rects[from].height / 2 + dy;
    let to = from;
    for (let i = 0; i < rects.length; i++) {
      const mid = rects[i].top + rects[i].height / 2;
      if (i < from && center < mid && i < to) to = i;
      if (i > from && center > mid && i > to) to = i;
    }
    setDrag({ ...active, dy, to });
  };

  const endPress = (commit: boolean) => {
    const active = dragRef.current;
    cancelPress();
    if (active === null) return;
    setDrag(null);
    suppressClick.current = true;
    if (commit && active.to !== active.from) onMove(active.from, active.to);
  };

  // Where each row sits while another is dragged: the rows between from and to step aside.
  const shiftOf = (index: number): number => {
    const current = press.current;
    if (drag === null || current?.rects === undefined || index === drag.from) return 0;
    const rects = current.rects;
    const stride =
      drag.from + 1 < rects.length
        ? rects[drag.from + 1].top - rects[drag.from].top
        : rects[drag.from].top - (rects[drag.from - 1]?.top ?? rects[drag.from].top);
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -stride;
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return stride;
    return 0;
  };

  return (
    <div
      ref={container}
      className={className}
      onClickCapture={(event) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {items.map((item, index) => {
        const key = itemKey(item);
        const dragging = drag?.key === key;
        return (
          <div
            key={key}
            ref={(element) => {
              if (element === null) rows.current.delete(key);
              else rows.current.set(key, element);
            }}
            onPointerDown={(event) => onPointerDown(event, key, index)}
            onPointerMove={onPointerMove}
            onPointerUp={() => endPress(true)}
            onPointerCancel={() => endPress(false)}
            onContextMenu={(event) => event.preventDefault()}
            className={`relative select-none ${dragging ? 'z-10 shadow-xl opacity-95' : 'transition-transform duration-150'}`}
            style={{
              transform: `translateY(${dragging ? drag.dy : shiftOf(index)}px)`,
              WebkitTouchCallout: 'none',
              touchAction: dragging ? 'none' : undefined,
            }}
          >
            {children(item)}
          </div>
        );
      })}
    </div>
  );
}
