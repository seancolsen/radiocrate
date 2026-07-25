import { createSignal, onCleanup } from "solid-js";
import type { AppStore } from "../state/store";

/** Static-friction scale (ORGANIZER_DRAG_FRICTION): small finger movements barely
 * move the drawer, so a vertical scroll inside it isn't read as a close-swipe. */
const FRICTION = 16;
/** Leftward flick velocity (px/s, ORGANIZER_SWIPE_VELOCITY) that closes even on a
 * small drag distance. */
const FLICK_VELOCITY = 400;

/** `dx - friction * tanh(dx / friction)` — near-zero for small |dx|, then tracks
 * 1:1 (offset by a constant). */
function staticFriction(dx: number): number {
  return dx - FRICTION * Math.tanh(dx / FRICTION);
}

/** Hand-rolled Pointer Events swipe-to-close for the mobile drawer (no gesture
 * library). Tracks a leftward drag with static friction; release closes on a
 * fast leftward flick or when dragged past halfway, else snaps back open. */
export function useSwipeToClose(store: AppStore, getWidth: () => number) {
  const [offset, setOffset] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);

  let startX = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0;
  let active = false;
  let pointerId = 0;
  let el: HTMLElement | null = null;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    el = e.currentTarget as HTMLElement;
    pointerId = e.pointerId;
    startX = e.clientX;
    lastX = e.clientX;
    lastT = performance.now();
    velocity = 0;
    active = true;
    setDragging(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onMove(e: PointerEvent) {
    if (!active) return;
    const width = getWidth();
    const o = Math.max(-width, Math.min(0, staticFriction(e.clientX - startX)));
    setOffset(o);
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) velocity = ((e.clientX - lastX) / dt) * 1000;
    lastX = e.clientX;
    lastT = now;
    if (o !== 0) {
      try {
        el?.setPointerCapture(pointerId);
      } catch {
        // best-effort
      }
    }
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (!active) return;
    active = false;
    setDragging(false);
    const width = getWidth();
    const shouldClose = velocity < -FLICK_VELOCITY || offset() < -width / 2;
    setOffset(0);
    if (shouldClose) store.setSidebarOpen(false);
  }

  onCleanup(() => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  });

  return { onPointerDown, offset, dragging };
}
