import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import { claimPointer, releasePointer } from "./pointerClaim";
import {
  DRAG_THRESHOLD,
  edgeScrollDelta,
  HOLD_SLOP,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  swallowReleaseClick,
} from "./press";

/** Where a drag would land: the drop (null: nowhere — over itself, or out of
 * reach), and where to draw the line for it, in px from the top of the list. */
export interface DragLocation<Target> {
  target: Target | null;
  lineTop: number;
}

/** The drag in progress: what's in hand, where it would land, and the pointer's
 * viewport position, for whatever follows it. */
export interface PressDragState<Item, Target> extends DragLocation<Target> {
  item: Item;
  x: number;
  y: number;
}

interface Session<Item, Target> {
  item: Item;
  pointerId: number;
  touch: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  target: Target | null;
  /** Removes the window listeners this session added. */
  detach: () => void;
}

/** Whether a session that moved nothing stayed close enough to where it began
 * to be a long press. */
function isHold<Item, Target>(s: Session<Item, Target>): boolean {
  return Math.hypot(s.x - s.startX, s.y - s.startY) < HOLD_SLOP;
}

/** The app's drag-to-rearrange gesture (no DnD library), for a list that isn't
 * laid out any differently while something in it is in hand. `CLAUDE.md`'s "Drag
 * to rearrange" has the standard this implements.
 *
 * The dragged item stays where it is; what moves is what the caller draws from
 * {@link PressDragState}. `locate` decides what the pointer is over.
 *
 * A mouse or pen picks an item up by moving past a threshold; a touch picks it up
 * by resting on it (a long press), so an ordinary swipe still scrolls the list.
 * Once a touch drag is under way the list stops scrolling under the finger, and
 * the drag scrolls it instead near its edges. A touch that picks an item up and
 * lets go without having moved it anywhere is a long press, not a drag: it
 * raises the item's context menu (`onHold`) instead.
 *
 * `listRef` is the element holding the items; `scroller` finds the element that
 * scrolls them. */
export function usePressDrag<Item, Target>(opts: {
  listRef: RefObject<HTMLElement | null>;
  scroller: () => HTMLElement | null | undefined;
  /** Where the pointer at viewport point (x, y) would drop `item`. */
  locate: (item: Item, x: number, y: number) => DragLocation<Target>;
  /** Makes the drop; returns whether anything actually moved. */
  onDrop: (item: Item, target: Target) => boolean;
  /** A touch held on the item and let go without moving it — the touch
   * equivalent of a right-click, at viewport point (x, y). */
  onHold: (item: Item, x: number, y: number) => void;
}) {
  const [drag, setDrag] = useState<PressDragState<Item, Target> | null>(null);

  // The latest inputs, for the imperative handlers below — synced from an
  // effect, never written in render.
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  const session = useRef<Session<Item, Target> | null>(null);
  const frame = useRef<number | undefined>(undefined);

  function update() {
    const s = session.current;
    if (!s?.started) return;
    const next = latest.current.locate(s.item, s.x, s.y);
    s.target = next.target;
    setDrag({ ...next, item: s.item, x: s.x, y: s.y });
  }

  /** Scrolls the list while the pointer sits near its top or bottom edge, a
   * frame at a time, for as long as the drag lasts. */
  function edgeScroll() {
    frame.current = requestAnimationFrame(edgeScroll);
    const s = session.current;
    const scroller = latest.current.scroller();
    if (!s?.started || !scroller) return;
    const box = scroller.getBoundingClientRect();
    const dy = edgeScrollDelta(s.y, box.top, box.bottom);
    if (dy === 0) return;
    const before = scroller.scrollTop;
    scroller.scrollTop += dy;
    if (scroller.scrollTop !== before) update();
  }

  function begin(s: Session<Item, Target>) {
    s.started = true;
    claimPointer(s.pointerId);
    // Nothing on the page should be selected, or selecting, while an item is in
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
    // act on whatever is under it.
    swallowReleaseClick();
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

  /** Starts tracking a press on `item`. */
  function onPointerDown(e: PointerEvent<HTMLElement>, item: Item) {
    if (e.button !== 0 || session.current) return;
    const touch = e.pointerType === "touch";
    const s: Session<Item, Target> = {
      item,
      pointerId: e.pointerId,
      touch,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      started: false,
      timer: undefined,
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
  }, [opts.listRef]);

  // Unmounting mid-drag drops nothing and leaves no listener behind.
  useEffect(() => {
    return () => end(false);
  }, []);

  return {
    drag,
    onPointerDown,
    /** Whether a click on an item should be ignored, because a drag is under
     * way. */
    ignoreClick: () => session.current?.started ?? false,
    /** Whether a touch is resting on an item, on its way to picking it up — when
     * the browser's own long-press menu must stay away. */
    pressing: () => session.current !== null,
  };
}
