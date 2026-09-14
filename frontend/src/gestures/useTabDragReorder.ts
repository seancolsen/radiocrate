import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useAppActions } from "../stores/react";

/** Movement (px) before a pointerdown becomes a drag rather than a click. */
const DRAG_THRESHOLD = 5;

/** Hand-rolled Pointer Events tab drag-to-reorder (no DnD library).
 *
 * `onPointerDown(e, id)` starts tracking a handle. Past the threshold it becomes
 * a drag: the handle follows the pointer horizontally (tracking pointer-x minus
 * the grab offset, so it doesn't jump), and when its center crosses a neighbor's
 * midpoint the store reorders. The trailing click (select/close) is swallowed so
 * a drag never also selects. */
export function useTabDragReorder(getContainer: () => HTMLElement | null) {
  const { reorderTab } = useAppActions();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [translate, setTranslate] = useState(0);

  // `getContainer` reads through a ref, synced from an effect (never the
  // render body — an unsafe ref write), so the imperative pointer handlers
  // below always call the latest one without having to be re-created.
  const getContainerRef = useRef(getContainer);
  useEffect(() => {
    getContainerRef.current = getContainer;
  }, [getContainer]);

  // A drag's own mutable state, read and written only from the pointer
  // handlers below — refs, not signals, exactly as the Solid version kept
  // these as plain closure locals (there, the component ran once; here the
  // hook body re-runs on every render, so these have to survive as refs
  // instead, the same shape `useSwipeToClose` uses).
  const handleEl = useRef<HTMLElement | null>(null);
  const currentId = useRef<string | null>(null);
  const pointerId = useRef(0);
  const startX = useRef(0);
  const grabWithinHandle = useRef(0); // pointer x minus handle's left edge, at grab
  const started = useRef(false);
  // Mirrors `translate` state for `onMove`, which needs its current value
  // synchronously (the reorder threshold check) and can't wait for a render.
  const translateRef = useRef(0);
  const setTranslateTracked = (t: number) => {
    translateRef.current = t;
    setTranslate(t);
  };

  function onPointerDown(e: PointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0) return;
    handleEl.current = e.currentTarget;
    currentId.current = id;
    pointerId.current = e.pointerId;
    startX.current = e.clientX;
    grabWithinHandle.current =
      e.clientX - e.currentTarget.getBoundingClientRect().left;
    started.current = false;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onMove(e: globalThis.PointerEvent) {
    const handle = handleEl.current;
    const id = currentId.current;
    if (!handle || !id) return;
    if (!started.current) {
      if (Math.abs(e.clientX - startX.current) < DRAG_THRESHOLD) return;
      started.current = true;
      setDraggingId(id);
      try {
        handle.setPointerCapture(pointerId.current);
      } catch {
        // capture is best-effort
      }
    }

    const container = getContainerRef.current();
    if (!container) return;
    const containerLeft = container.getBoundingClientRect().left;
    // Desired handle-left (relative to container) keeps the grab point under the
    // pointer; translate is the delta from its laid-out position. Recomputed from
    // live offsetLeft each move, so it self-corrects after a reorder.
    const desiredLeft = e.clientX - containerLeft - grabWithinHandle.current;
    setTranslateTracked(desiredLeft - handle.offsetLeft);

    // Reorder: count how many other handles' centers sit left of the dragged one.
    const draggedCenter =
      handle.offsetLeft + translateRef.current + handle.offsetWidth / 2;
    const nodes = Array.from(
      container.querySelectorAll<HTMLElement>("[data-tab-id]"),
    );
    let newIndex = 0;
    for (const n of nodes) {
      if (n.dataset.tabId === id) continue;
      if (draggedCenter > n.offsetLeft + n.offsetWidth / 2) newIndex++;
    }
    reorderTab(id, newIndex);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const handle = handleEl.current;
    if (started.current && handle) {
      try {
        handle.releasePointerCapture(pointerId.current);
      } catch {
        // ignore
      }
      // Swallow the click that follows a real drag, so it doesn't select/close.
      handle.addEventListener(
        "click",
        (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        },
        { capture: true, once: true },
      );
    }
    started.current = false;
    handleEl.current = null;
    currentId.current = null;
    setDraggingId(null);
    setTranslateTracked(0);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { onPointerDown, draggingId, translate };
}
