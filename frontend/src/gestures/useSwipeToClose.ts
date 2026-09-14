import { useEffect, useRef, useState, type PointerEvent } from "react";

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
export function useSwipeToClose(onClose: () => void, getWidth: () => number) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Refs, not state — nothing needs to re-render off them: a drag's own
  // mutable state, read and written only from the pointer handlers below.
  const startX = useRef(0);
  const lastX = useRef(0);
  const lastT = useRef(0);
  const velocity = useRef(0);
  const active = useRef(false);
  const pointerId = useRef(0);
  const el = useRef<HTMLElement | null>(null);
  // Mirrors `offset` state for the native pointer handlers below, which need
  // its current value synchronously (`onUp`'s halfway check) and can't wait
  // for a render. Written only from those handlers, alongside `setOffset`
  // itself — never from the render body, which would be an unsafe ref write.
  const offsetRef = useRef(0);
  const setOffsetTracked = (o: number) => {
    offsetRef.current = o;
    setOffset(o);
  };

  // `onClose`/`getWidth` read through refs, synced from effects (never the
  // render body — an unsafe ref write) so the mount-once cleanup effect below
  // always calls the latest ones without having to re-run.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const getWidthRef = useRef(getWidth);
  useEffect(() => {
    getWidthRef.current = getWidth;
  }, [getWidth]);

  function onMove(e: globalThis.PointerEvent) {
    if (!active.current) return;
    const width = getWidthRef.current();
    const o = Math.max(
      -width,
      Math.min(0, staticFriction(e.clientX - startX.current)),
    );
    setOffsetTracked(o);
    const now = performance.now();
    const dt = now - lastT.current;
    if (dt > 0) velocity.current = ((e.clientX - lastX.current) / dt) * 1000;
    lastX.current = e.clientX;
    lastT.current = now;
    if (o !== 0) {
      try {
        el.current?.setPointerCapture(pointerId.current);
      } catch {
        // best-effort
      }
    }
  }

  function onUp() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (!active.current) return;
    active.current = false;
    setDragging(false);
    const width = getWidthRef.current();
    const shouldClose =
      velocity.current < -FLICK_VELOCITY || offsetRef.current < -width / 2;
    setOffsetTracked(0);
    if (shouldClose) onCloseRef.current();
  }

  function onPointerDown(e: PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    el.current = e.currentTarget;
    pointerId.current = e.pointerId;
    startX.current = e.clientX;
    lastX.current = e.clientX;
    lastT.current = performance.now();
    velocity.current = 0;
    active.current = true;
    setDragging(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { onPointerDown, offset, dragging };
}
