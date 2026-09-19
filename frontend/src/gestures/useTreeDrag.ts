import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  dropBetween,
  dropInto,
  subtreeIds,
  type DropTarget,
  type TreeItemRef,
  type TreeNode,
  type TreeRow,
} from "../query/explorerTree";
import { claimPointer, releasePointer } from "./pointerClaim";

/** A tree row's left padding at depth 0, and the extra indent per level (px).
 * The rows lay themselves out with these, and the drop line is indented by
 * them, so the two always agree. */
export const TREE_PAD = 8;
export const TREE_INDENT = 16;

/** How far (px) a touch may travel after picking a row up and still count as a
 * long press — when its drop has moved nothing — rather than a drag that went
 * nowhere useful. */
const HOLD_SLOP = 32;
/** Mouse/pen movement (px) before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 5;
/** How long a touch has to rest on a row before it picks the row up (ms)… */
const LONG_PRESS_MS = 450;
/** …and how far it may wander meanwhile (px) — further, and it's a scroll. */
const LONG_PRESS_SLOP = 8;
/** Distance from the list's scrolling edge (px) inside which a drag scrolls it,
 * faster the closer it gets, up to this many px per frame. */
const EDGE_ZONE = 32;
const MAX_EDGE_SPEED = 14;

/** The drag in progress: what's being dragged, and where it would land (null:
 * nowhere — over itself, or out of reach). `lineTop` places the drop line for
 * a between-rows target, in px from the top of the list. */
export interface TreeDragState {
  item: TreeItemRef;
  target: DropTarget | null;
  lineTop: number;
}

/** Whether a session that moved nothing stayed close enough to where it began
 * to be a long press. */
function isHold(s: Session): boolean {
  return Math.hypot(s.x - s.startX, s.y - s.startY) < HOLD_SLOP;
}

interface Session {
  item: TreeItemRef;
  pointerId: number;
  touch: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  blocked: Set<string>;
  target: DropTarget | null;
  /** Removes the window listeners this session added. */
  detach: () => void;
}

/** Hand-rolled drag-to-rearrange for the explorer's query tree (no DnD
 * library, like the tab bar's `useTabDragReorder`).
 *
 * The dragged row stays where it is; what moves is the drop indicator the
 * caller draws from {@link TreeDragState}: a line between two rows, indented to
 * the nesting depth the drop would land at, or an outline around a folder the
 * item would drop into. Which depth a between-rows line stands for follows the
 * pointer's horizontal position — the further right, the deeper, within what
 * the rows on either side allow.
 *
 * A mouse or pen picks a row up by moving past a threshold; a touch picks it up
 * by resting on it (a long press), so an ordinary swipe still scrolls the list.
 * Once a touch drag is under way the list stops scrolling under the finger, and
 * the drag scrolls it instead near its edges. A touch that picks a row up and
 * lets go without having moved it anywhere is a long press, not a drag: it
 * raises the row's context menu (`onHold`) instead.
 *
 * `listRef` is the element holding the rows (each marked `data-tree-row`, in
 * `rows` order); `scrollRef` is the element that scrolls them. */
export function useTreeDrag(opts: {
  listRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  tree: readonly TreeNode[];
  rows: readonly TreeRow[];
  /** Makes the drop; returns whether anything actually moved. */
  onDrop: (item: TreeItemRef, target: DropTarget) => boolean;
  /** A touch held on the row and let go without moving it — the touch
   * equivalent of a right-click, at viewport point (x, y). */
  onHold: (item: TreeItemRef, x: number, y: number) => void;
}) {
  const [drag, setDrag] = useState<TreeDragState | null>(null);

  // The latest inputs, for the imperative handlers below — synced from an
  // effect, never written in render.
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  const session = useRef<Session | null>(null);
  const frame = useRef<number | undefined>(undefined);

  /** Where the pointer at (x, y) would drop the dragged item, and where to
   * draw the line for it. */
  function locate(s: Session): TreeDragState {
    const { listRef, rows } = latest.current;
    const list = listRef.current;
    const none = { item: s.item, target: null, lineTop: 0 };
    if (!list) return none;
    const box = list.getBoundingClientRect();
    const els = Array.from(
      list.querySelectorAll<HTMLElement>("[data-tree-row]"),
    );
    if (els.length !== rows.length) return none;

    let gap = rows.length;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (s.y >= r.bottom) continue;
      const frac = (s.y - r.top) / r.height;
      if (rows[i].node.kind === "folder") {
        if (frac >= 0.25 && frac <= 0.75) {
          return {
            item: s.item,
            target: dropInto(rows[i].node.id, s.blocked),
            lineTop: 0,
          };
        }
        gap = frac < 0.25 ? i : i + 1;
      } else {
        gap = frac < 0.5 ? i : i + 1;
      }
      break;
    }

    const depth = Math.floor((s.x - box.left - TREE_PAD) / TREE_INDENT);
    const target = dropBetween(rows, gap, depth, s.blocked);
    const edge =
      gap < els.length
        ? els[gap].getBoundingClientRect().top
        : (els[els.length - 1]?.getBoundingClientRect().bottom ?? box.top);
    return { item: s.item, target, lineTop: edge - box.top };
  }

  function update() {
    const s = session.current;
    if (!s?.started) return;
    const next = locate(s);
    s.target = next.target;
    setDrag(next);
  }

  /** Scrolls the list while the pointer sits near its top or bottom edge, a
   * frame at a time, for as long as the drag lasts. */
  function edgeScroll() {
    frame.current = requestAnimationFrame(edgeScroll);
    const s = session.current;
    const scroller = latest.current.scrollRef.current;
    if (!s?.started || !scroller) return;
    const box = scroller.getBoundingClientRect();
    const speed = (into: number) =>
      Math.ceil(MAX_EDGE_SPEED * (1 - Math.max(0, into) / EDGE_ZONE));
    let dy = 0;
    if (s.y < box.top + EDGE_ZONE) dy = -speed(s.y - box.top);
    else if (s.y > box.bottom - EDGE_ZONE) dy = speed(box.bottom - s.y);
    if (dy === 0) return;
    const before = scroller.scrollTop;
    scroller.scrollTop += dy;
    if (scroller.scrollTop !== before) update();
  }

  function begin(s: Session) {
    s.started = true;
    claimPointer(s.pointerId);
    // Nothing on the page should be selected, or selecting, while a row is in
    // hand — a long press would otherwise start a text selection.
    window.getSelection()?.removeAllRanges();
    if (s.touch) navigator.vibrate?.(10);
    update();
    frame.current = requestAnimationFrame(edgeScroll);
  }

  function end(drop: boolean) {
    const s = session.current;
    if (!s) return;
    session.current = null;
    clearTimeout(s.timer);
    s.detach();
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    if (!s.started) return;
    releasePointer(s.pointerId);
    // The click this release produces ends the drag; it isn't a request to
    // open the row (or toggle the chevron) under it. It's dispatched along
    // with the release, so a click still pending once this task is over is
    // another click altogether.
    const swallow = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    setDrag(null);
    if (!drop) return;
    const moved = s.target !== null && latest.current.onDrop(s.item, s.target);
    if (s.touch && !moved && isHold(s)) latest.current.onHold(s.item, s.x, s.y);
  }

  function onMove(e: globalThis.PointerEvent) {
    const s = session.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.x = e.clientX;
    s.y = e.clientY;
    if (!s.started) {
      const moved = Math.hypot(s.x - s.startX, s.y - s.startY);
      // A touch that travels before its long press completes is a scroll.
      if (s.touch) {
        if (moved > LONG_PRESS_SLOP) end(false);
        return;
      }
      if (moved < DRAG_THRESHOLD) return;
      begin(s);
      return;
    }
    update();
  }

  function onUp(e: globalThis.PointerEvent) {
    if (e.pointerId === session.current?.pointerId) end(true);
  }

  function onCancel(e: globalThis.PointerEvent) {
    const s = session.current;
    if (e.pointerId !== s?.pointerId) return;
    // A touch drag under way finishes on `touchend`; the browser may still
    // cancel the pointer when it thinks a pan began.
    if (s.touch && s.started) return;
    end(false);
  }

  function onTouchEnd() {
    if (session.current?.touch) end(true);
  }

  function onTouchCancel() {
    if (session.current?.touch) end(false);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !session.current?.started) return;
    e.preventDefault();
    e.stopPropagation();
    end(false);
  }

  /** Starts tracking a press on the row for `item`. */
  function onPointerDown(e: PointerEvent<HTMLElement>, item: TreeItemRef) {
    if (e.button !== 0 || session.current) return;
    const touch = e.pointerType === "touch";
    const s: Session = {
      item,
      pointerId: e.pointerId,
      touch,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      started: false,
      timer: undefined,
      blocked: subtreeIds(latest.current.tree, item),
      target: null,
      detach: () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("touchend", onTouchEnd);
        window.removeEventListener("touchcancel", onTouchCancel);
        window.removeEventListener("keydown", onKey, true);
      },
    };
    session.current = s;
    if (touch) {
      s.timer = setTimeout(() => {
        if (session.current === s) begin(s);
      }, LONG_PRESS_MS);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchCancel);
    window.addEventListener("keydown", onKey, true);
  }

  // While a touch drag is under way, the finger moves the drag, not the list.
  // Registered once, non-passive (React's own touch handlers are passive, so
  // they can't cancel a scroll), and a no-op the rest of the time. A touch
  // drag's moves also arrive here, for the browsers that stop sending pointer
  // events once they have decided the touch is theirs.
  useEffect(() => {
    const list = opts.listRef.current;
    if (!list) return;
    const onTouchMove = (e: TouchEvent) => {
      const s = session.current;
      if (!s?.touch || !s.started) return;
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      s.x = t.clientX;
      s.y = t.clientY;
      update();
    };
    list.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => list.removeEventListener("touchmove", onTouchMove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.listRef]);

  // Unmounting mid-drag drops nothing and leaves no listener behind.
  useEffect(() => {
    return () => end(false);
  }, []);

  return {
    drag,
    onPointerDown,
    /** Whether a click on a row should be ignored, because a drag is under
     * way. */
    ignoreClick: () => session.current?.started ?? false,
    /** Whether a touch is resting on a row, on its way to picking it up — when
     * the browser's own long-press menu must stay away. */
    pressing: () => session.current !== null,
  };
}
