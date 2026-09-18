// Where a menu panel goes on screen. Pure functions over rectangles, so every
// placement rule is testable without a DOM: `useMenu.ts` measures the anchor
// and the panel, asks one of these where the panel belongs, and writes the
// answer onto its `position: fixed` style.
//
// The contract all three share: the panel ends up wholly inside the viewport.
// Where it has to be moved to get there, it's moved `VIEWPORT_MARGIN` clear of
// the edge it overran; when it's too tall for the room it has, `maxHeight`
// caps it and the panel scrolls.

/** Gap kept between a menu and the viewport's edges. */
export const VIEWPORT_MARGIN = 8;

/** Gap between a panel and the thing it hangs off (a trigger, a submenu row). */
export const ANCHOR_GAP = 4;

/** An on-screen box, in viewport coordinates — `DOMRect` satisfies it. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Where to put a panel: its top-left corner, and the tallest it may be. */
export interface Placement {
  left: number;
  top: number;
  maxHeight: number;
}

/** Which side of its row a submenu opens on. */
export type SubmenuSide = "right" | "left";

/** The start of a `size`-long span along an axis `length` long. Already on
 * screen, the span stays exactly where it is — a menu flush against the edge
 * is fine. Otherwise it moves as little as it must to sit `VIEWPORT_MARGIN`
 * clear of the edge it overran, and is pinned to the near margin when it
 * can't fit at all, so its start (a menu's top-left, where reading begins)
 * stays on screen. */
function fitSpan(start: number, size: number, length: number) {
  if (start >= 0 && start + size <= length) return start;
  return Math.max(
    VIEWPORT_MARGIN,
    Math.min(start, length - VIEWPORT_MARGIN - size),
  );
}

/** A dropdown hanging off its trigger (`anchor`): below or above it per
 * `side`, flipping to the other side when the preferred one hasn't room for
 * the whole panel but the other has, and otherwise taking whichever side has
 * more room and scrolling. Horizontally, `align` lines the panel up with the
 * trigger's left (`start`) or right (`end`) edge, then slides it back inside
 * the viewport if that runs off an edge. */
export function placeDropdown(
  anchor: Rect,
  size: Size,
  viewport: Size,
  side: "below" | "above",
  align: "start" | "end",
): Placement {
  const m = VIEWPORT_MARGIN;
  const room = {
    below: viewport.height - m - (anchor.bottom + ANCHOR_GAP),
    above: anchor.top - ANCHOR_GAP - m,
  };
  const other = side === "below" ? "above" : "below";
  const chosen =
    size.height <= room[side]
      ? side
      : size.height <= room[other]
        ? other
        : room.below >= room.above
          ? "below"
          : "above";
  const maxHeight = Math.max(0, room[chosen]);
  const height = Math.min(size.height, maxHeight);
  const start = align === "start" ? anchor.left : anchor.right - size.width;
  return {
    left: fitSpan(start, size.width, viewport.width),
    top:
      chosen === "below"
        ? anchor.bottom + ANCHOR_GAP
        : anchor.top - ANCHOR_GAP - height,
    maxHeight,
  };
}

/** A submenu opening beside the row that holds it (`row`), its top level with
 * the row's. It opens on the `prefer`red side — a nested submenu keeps going
 * the way its parent went, as native menus do — and flips when that side
 * hasn't room but the other has. When neither has, it takes the roomier one
 * and slides back inside the viewport, overlapping its parent rather than
 * running off-screen. Vertically it slides up as far as it must to clear the
 * bottom edge. */
export function placeSubmenu(
  row: Rect,
  size: Size,
  viewport: Size,
  prefer: SubmenuSide,
): Placement & { side: SubmenuSide } {
  const m = VIEWPORT_MARGIN;
  const starts = {
    right: row.right + ANCHOR_GAP,
    left: row.left - ANCHOR_GAP - size.width,
  };
  const room = {
    right: viewport.width - m - starts.right,
    left: row.left - ANCHOR_GAP - m,
  };
  const other = prefer === "right" ? "left" : "right";
  const side =
    size.width <= room[prefer]
      ? prefer
      : size.width <= room[other]
        ? other
        : room.right >= room.left
          ? "right"
          : "left";
  const maxHeight = Math.max(0, viewport.height - 2 * m);
  return {
    left: fitSpan(starts[side], size.width, viewport.width),
    top: fitSpan(row.top, Math.min(size.height, maxHeight), viewport.height),
    maxHeight,
    side,
  };
}

/** A context menu at a point (the pointer, on a right-click): its top-left
 * corner there, slid back inside the viewport where it would overflow. */
export function placeAtPoint(
  point: Point,
  size: Size,
  viewport: Size,
): Placement {
  const m = VIEWPORT_MARGIN;
  const maxHeight = Math.max(0, viewport.height - 2 * m);
  return {
    left: fitSpan(point.x, size.width, viewport.width),
    top: fitSpan(point.y, Math.min(size.height, maxHeight), viewport.height),
    maxHeight,
  };
}

/** How far behind the exit point the grace area's apex sits, so the point the
 * pointer left from is itself inside the area. */
const GRACE_BLEED = 5;

/** The "safe triangle" a pointer may cross on its way from a submenu's row to
 * the submenu itself: from just behind where it left the row, fanning out to
 * the submenu panel's near corners, plus the panel itself. A pointer cutting
 * diagonally across the parent's other rows stays inside it; one heading
 * anywhere else leaves it within a few pixels. */
export function gracePolygon(
  exit: Point,
  panel: Rect,
  side: SubmenuSide,
): Point[] {
  const [near, far] =
    side === "right" ? [panel.left, panel.right] : [panel.right, panel.left];
  const bleed = side === "right" ? -GRACE_BLEED : GRACE_BLEED;
  return [
    { x: exit.x + bleed, y: exit.y },
    { x: near, y: panel.top },
    { x: far, y: panel.top },
    { x: far, y: panel.bottom },
    { x: near, y: panel.bottom },
  ];
}

/** Whether `point` lies inside `polygon` (ray casting; the polygon need not be
 * convex). */
export function pointInPolygon(point: Point, polygon: readonly Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
