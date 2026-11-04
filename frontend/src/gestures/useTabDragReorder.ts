import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useAppActions } from "../stores/react";
import { DRAG_THRESHOLD, swallowReleaseClick } from "./press";

/** The drag in progress: which tab is being dragged, and where it would land.
 * `gap` counts the handles left of the drop (0: before the first; the tab
 * count: after the last), and `lineLeft` places the drop line on that gap, in
 * px from the container's left edge. Both are null when the drop would leave
 * the tab where it is. */
export interface TabDragState {
  id: string;
  gap: number | null;
  lineLeft: number;
}

interface Session {
  id: string;
  handle: HTMLElement;
  pointerId: number;
  startX: number;
  x: number;
  started: boolean;
  /** The index the drop would move the tab to (null: nowhere). */
  toIndex: number | null;
  /** Removes the window listeners this session added. */
  detach: () => void;
}

/** Hand-rolled Pointer Events tab drag-to-reorder (no DnD library), the tab
 * bar's take on the explorer tree's `useTreeDrag`.
 *
 * `onPointerDown(e, id)` starts tracking a handle. Past the threshold it becomes
 * a drag. The dragged handle stays where it is; what moves is the drop line the
 * caller draws from {@link TabDragState}, on the gap between the two handles
 * nearest the pointer. Letting go moves the tab there; Escape calls the drag
 * off. The trailing click (select/close) is swallowed so a drag never also
 * selects.
 *
 * `getContainer` returns the element holding the handles (each marked
 * `data-tab-id`, in tab order), which the drop line is positioned within. */
export function useTabDragReorder(getContainer: () => HTMLElement | null) {
  const { reorderTab } = useAppActions();
  const [drag, setDrag] = useState<TabDragState | null>(null);

  // `getContainer` reads through a ref, synced from an effect (never the
  // render body — an unsafe ref write), so the imperative pointer handlers
  // below always call the latest one without having to be re-created.
  const getContainerRef = useRef(getContainer);
  useEffect(() => {
    getContainerRef.current = getContainer;
  }, [getContainer]);

  const session = useRef<Session | null>(null);

  /** Where the pointer would drop the dragged tab, and where to draw the line
   * for it. */
  function locate(s: Session): TabDragState & { toIndex: number | null } {
    const none = { id: s.id, gap: null, lineLeft: 0, toIndex: null };
    const container = getContainerRef.current();
    if (!container) return none;
    const els = Array.from(
      container.querySelectorAll<HTMLElement>("[data-tab-id]"),
    );
    const from = els.findIndex((n) => n.dataset.tabId === s.id);
    if (from === -1) return none;

    let gap = els.length;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (s.x < r.left + r.width / 2) {
        gap = i;
        break;
      }
    }
    // Either side of the dragged tab itself: dropping there moves nothing.
    if (gap === from || gap === from + 1) return none;

    const edge =
      gap < els.length
        ? els[gap].getBoundingClientRect().left
        : els[els.length - 1].getBoundingClientRect().right;
    return {
      id: s.id,
      gap,
      lineLeft: edge - container.getBoundingClientRect().left,
      // `gap` counts the dragged tab itself when it lies to the left of it.
      toIndex: gap > from ? gap - 1 : gap,
    };
  }

  function update() {
    const s = session.current;
    if (!s?.started) return;
    const { toIndex, ...next } = locate(s);
    s.toIndex = toIndex;
    setDrag(next);
  }

  function end(drop: boolean) {
    const s = session.current;
    if (!s) return;
    session.current = null;
    s.detach();
    if (!s.started) return;
    try {
      s.handle.releasePointerCapture(s.pointerId);
    } catch {
      // ignore
    }
    // Swallow the click that follows a real drag, so it doesn't select/close.
    swallowReleaseClick();
    setDrag(null);
    if (drop && s.toIndex !== null) reorderTab(s.id, s.toIndex);
  }

  function onMove(e: globalThis.PointerEvent) {
    const s = session.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.x = e.clientX;
    if (!s.started) {
      if (Math.abs(s.x - s.startX) < DRAG_THRESHOLD) return;
      s.started = true;
      try {
        s.handle.setPointerCapture(s.pointerId);
      } catch {
        // capture is best-effort
      }
    }
    update();
  }

  function onUp(e: globalThis.PointerEvent) {
    if (e.pointerId === session.current?.pointerId) end(true);
  }

  function onCancel(e: globalThis.PointerEvent) {
    if (e.pointerId === session.current?.pointerId) end(false);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !session.current?.started) return;
    e.preventDefault();
    e.stopPropagation();
    end(false);
  }

  function onPointerDown(e: PointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0 || session.current) return;
    session.current = {
      id,
      handle: e.currentTarget,
      pointerId: e.pointerId,
      startX: e.clientX,
      x: e.clientX,
      started: false,
      toIndex: null,
      detach: () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
      },
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }

  // Unmounting mid-drag drops nothing and leaves no listener behind.
  useEffect(() => {
    return () => end(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { onPointerDown, drag };
}
