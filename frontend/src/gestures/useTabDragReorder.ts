import { createSignal, onCleanup } from "solid-js";
import type { AppStore } from "../state/store";

/** Movement (px) before a pointerdown becomes a drag rather than a click. */
const DRAG_THRESHOLD = 5;

/** Hand-rolled Pointer Events tab drag-to-reorder (no DnD library).
 *
 * `onPointerDown(e, id)` starts tracking a handle. Past the threshold it becomes
 * a drag: the handle follows the pointer horizontally (tracking pointer-x minus
 * the grab offset, so it doesn't jump), and when its center crosses a neighbor's
 * midpoint the store reorders. The trailing click (select/close) is swallowed so
 * a drag never also selects. */
export function useTabDragReorder(
  store: AppStore,
  getContainer: () => HTMLElement | undefined,
) {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);
  const [translate, setTranslate] = createSignal(0);

  let handleEl: HTMLElement | null = null;
  let currentId: string | null = null;
  let pointerId = 0;
  let startX = 0;
  let grabWithinHandle = 0; // pointer x minus handle's left edge, at grab
  let started = false;

  function onPointerDown(e: PointerEvent, id: string) {
    if (e.button !== 0) return;
    handleEl = e.currentTarget as HTMLElement;
    currentId = id;
    pointerId = e.pointerId;
    startX = e.clientX;
    grabWithinHandle = e.clientX - handleEl.getBoundingClientRect().left;
    started = false;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onMove(e: PointerEvent) {
    if (!handleEl || !currentId) return;
    if (!started) {
      if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
      started = true;
      setDraggingId(currentId);
      try {
        handleEl.setPointerCapture(pointerId);
      } catch {
        // capture is best-effort
      }
    }

    const container = getContainer();
    if (!container) return;
    const containerLeft = container.getBoundingClientRect().left;
    // Desired handle-left (relative to container) keeps the grab point under the
    // pointer; translate is the delta from its laid-out position. Recomputed from
    // live offsetLeft each move, so it self-corrects after a reorder.
    const desiredLeft = e.clientX - containerLeft - grabWithinHandle;
    setTranslate(desiredLeft - handleEl.offsetLeft);

    // Reorder: count how many other handles' centers sit left of the dragged one.
    const draggedCenter =
      handleEl.offsetLeft + translate() + handleEl.offsetWidth / 2;
    const nodes = Array.from(
      container.querySelectorAll<HTMLElement>("[data-tab-id]"),
    );
    let newIndex = 0;
    for (const n of nodes) {
      if (n.dataset.tabId === currentId) continue;
      if (draggedCenter > n.offsetLeft + n.offsetWidth / 2) newIndex++;
    }
    store.reorderTab(currentId, newIndex);
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (started && handleEl) {
      try {
        handleEl.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
      // Swallow the click that follows a real drag, so it doesn't select/close.
      handleEl.addEventListener(
        "click",
        (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        },
        { capture: true, once: true },
      );
    }
    started = false;
    handleEl = null;
    currentId = null;
    setDraggingId(null);
    setTranslate(0);
  }

  onCleanup(() => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  });

  return { onPointerDown, draggingId, translate };
}
