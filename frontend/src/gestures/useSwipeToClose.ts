import { useEffect, useRef, type RefObject } from "react";
import { isPointerClaimed } from "./pointerClaim";
import {
  releaseVelocity,
  shouldClose,
  swipeAxis,
  type SwipeSample,
} from "./swipe";

/** What a drawer's two parts look like at `reveal` (1: open, 0: closed): the
 * one description of them, for a drawer at rest and for one under a finger. */
export function revealStyles(reveal: number): {
  panel: { transform: string };
  scrim: { opacity: number };
} {
  return {
    panel: { transform: `translateX(${(reveal - 1) * 100}%)` },
    scrim: { opacity: reveal * 0.4 },
  };
}

/** One touch being watched. Starts undecided; `drag` is set once it has
 * proved to be a horizontal swipe. */
interface Session {
  pointerId: number;
  startX: number;
  startY: number;
  drag: {
    /** The panel's width, for the length of the swipe. */
    width: number;
    /** The finger x that puts the panel at `base` px from open. */
    originX: number;
    base: number;
    /** Where the panel is now: px from open, ≤ 0. */
    offset: number;
    samples: SwipeSample[];
  } | null;
}

/** Swipe a drawer closed, from anywhere in `zoneRef` — the panel and its scrim.
 *
 * A touch starts undecided, and nothing moves until it's clearly one thing or
 * the other. A vertical one is left to scroll. A horizontal one takes the panel
 * with it, px for px from wherever the panel was (so it doesn't jump by the
 * distance that decided it, and a touch that lands mid-spring-back catches it
 * where it is), and a finger run past either end moves it again the moment it
 * turns back. On release, the panel springs home or closes (see `shouldClose`);
 * the transition itself is the caller's CSS, switched off while `data-swiping`
 * is on the zone.
 *
 * What makes it work is `touch-action: pan-y` on everything a touch can land on
 * in the zone (`touch-pan-y`, and `ScrollArea`'s scroller): the browser takes a
 * vertical touch for itself and cancels the pointer, and leaves us every move of
 * a horizontal one. Without it, the browser cancels those too.
 *
 * The moves write to the DOM directly, not through state: a finger on the panel
 * re-renders nothing. They're native listeners because React's bubble through
 * portals, and a touch on a context menu raised from inside the panel isn't a
 * swipe. Nor is one on a dropdown, which renders in place. */
export function useSwipeToClose(opts: {
  zoneRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  scrimRef: RefObject<HTMLElement | null>;
  /** Whether the drawer is open, and so has anything to swipe. */
  enabled: boolean;
  onClose: () => void;
}): void {
  const { zoneRef, panelRef, scrimRef, enabled } = opts;

  const onCloseRef = useRef(opts.onClose);
  useEffect(() => {
    onCloseRef.current = opts.onClose;
  });

  useEffect(() => {
    const zone = zoneRef.current;
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    if (!enabled || !zone || !panel || !scrim) return;

    let session: Session | null = null;

    const paint = (reveal: number) => {
      const styles = revealStyles(reveal);
      panel.style.transform = styles.panel.transform;
      scrim.style.opacity = String(styles.scrim.opacity);
    };

    const stopWatching = () => {
      session = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };

    /** Lets go of the drawer, which animates to `reveal`. */
    const settle = (reveal: number) => {
      delete zone.dataset.swiping;
      paint(reveal);
    };

    const onDown = (e: PointerEvent) => {
      if (session || e.pointerType !== "touch" || !e.isPrimary) return;
      if ((e.target as Element).closest('[role="menu"]')) return;
      session = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        drag: null,
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };

    function onMove(e: PointerEvent) {
      const s = session;
      if (!s || e.pointerId !== s.pointerId) return;
      // Another gesture (the explorer's drag-to-rearrange, a resize) took this
      // pointer over: let go, and put the drawer back where it was.
      if (isPointerClaimed(e.pointerId)) {
        if (s.drag) settle(1);
        stopWatching();
        return;
      }
      if (!s.drag) {
        const axis = swipeAxis(e.clientX - s.startX, e.clientY - s.startY);
        if (axis === null) return;
        if (axis === "vertical") {
          stopWatching();
          return;
        }
        const box = panel!.getBoundingClientRect();
        const base = box.left - zone!.getBoundingClientRect().left;
        s.drag = {
          width: box.width,
          originX: e.clientX,
          base,
          offset: base,
          samples: [],
        };
        zone!.dataset.swiping = "";
      }
      const drag = s.drag;
      const wanted = drag.base + (e.clientX - drag.originX);
      drag.offset = Math.max(-drag.width, Math.min(0, wanted));
      drag.originX += wanted - drag.offset;
      drag.samples.push({ x: e.clientX, t: e.timeStamp });
      if (drag.samples.length > 32) drag.samples.shift();
      paint(1 + drag.offset / drag.width);
    }

    function onUp(e: PointerEvent) {
      const s = session;
      if (!s || e.pointerId !== s.pointerId) return;
      stopWatching();
      if (!s.drag) return;
      const { offset, width, samples } = s.drag;
      if (shouldClose(offset, width, releaseVelocity(samples, e.timeStamp))) {
        settle(0);
        onCloseRef.current();
      } else {
        settle(1);
      }
    }

    /** The browser took the touch for itself: a scroll, if it was undecided. */
    function onCancel(e: PointerEvent) {
      const s = session;
      if (!s || e.pointerId !== s.pointerId) return;
      stopWatching();
      if (s.drag) settle(1);
    }

    zone.addEventListener("pointerdown", onDown);
    return () => {
      zone.removeEventListener("pointerdown", onDown);
      const swiping = session?.drag;
      stopWatching();
      // Closed some other way mid-swipe: its own write says where the drawer
      // goes, and this mustn't leave the transition switched off.
      if (swiping) delete zone.dataset.swiping;
    };
  }, [enabled, zoneRef, panelRef, scrimRef]);
}
