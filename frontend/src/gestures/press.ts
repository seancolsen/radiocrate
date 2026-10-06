// What every press-to-drag gesture in the app agrees on: how long a touch has
// to rest before it picks something up, how far a pointer travels before a
// press becomes a drag, how a drag scrolls the list it's in near that list's
// edges, and how the click a drag's release produces is kept from also counting
// as a click. The explorer's tree (`useTreeDrag`) and the results grid
// (`grid/rowPress.ts`, `grid/canvasGrid.ts`) both press this way, so the two
// feel the same under a finger.

/** How far (px) a touch may travel after picking something up and still count
 * as a long press — when its drop has done nothing — rather than a drag that
 * went nowhere useful. */
export const HOLD_SLOP = 32;
/** Mouse/pen movement (px) before a press becomes a drag rather than a click. */
export const DRAG_THRESHOLD = 5;
/** How long a touch has to rest before it picks what's under it up (ms)… */
export const LONG_PRESS_MS = 450;
/** …and how far it may wander meanwhile (px) — further, and it's a scroll. */
export const LONG_PRESS_SLOP = 8;

/** Distance from a list's scrolling edge (px) inside which a drag scrolls it,
 * faster the closer it gets, up to this many px per frame. */
const EDGE_ZONE = 32;
const MAX_EDGE_SPEED = 14;

/** How far (px) one frame of a drag at viewport height `y` scrolls a list that
 * spans `top`…`bottom` on screen: negative toward the top, positive toward the
 * bottom, and 0 away from both edges. Past an edge, it scrolls at full speed. */
export function edgeScrollDelta(
  y: number,
  top: number,
  bottom: number,
): number {
  const speed = (into: number) =>
    Math.ceil(MAX_EDGE_SPEED * (1 - Math.max(0, into) / EDGE_ZONE));
  if (y < top + EDGE_ZONE) return -speed(y - top);
  if (y > bottom - EDGE_ZONE) return speed(bottom - y);
  return 0;
}

/** Swallows the click a drag's release is about to produce: it ends the drag,
 * and isn't a request to act on whatever lies under it. The click is
 * dispatched along with the release, so one still pending once this task is
 * over is another click altogether. */
export function swallowReleaseClick(): void {
  const swallow = (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}
