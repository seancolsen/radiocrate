import {
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { claimPointer, releasePointer } from "../../gestures/pointerClaim";
import { cx } from "./cx";

/** Keyboard resize step (Arrow keys on the handle). */
const RESIZE_STEP = 16;

/** The grab handle along one edge of a sidebar, which must be its direct child
 * (and positioned): drag it, or focus it and use the arrow keys, to resize.
 *
 * Under a mouse it's the whole edge: a strip straddling the panel's border, so
 * it's grabbable from either side without widening the visible seam. Under a
 * finger it's a grip halfway up the edge, which shows itself (there's no hover
 * to find it by) and leaves the rest of the edge to whatever else a finger does
 * there — swiping a drawer closed, above all. `touch-none` is what makes it work
 * under a finger at all: without it, the browser takes the touch for a pan after
 * a few px and cancels the pointer. */
export default function SidebarResizeHandle(props: {
  /** Which of the panel's edges it's on: dragging away from the panel widens. */
  edge: "left" | "right";
  /** Its accessible name ("Resize explorer"). */
  label: string;
  /** The widest the panel can go right now, in CSS px. */
  maxWidth: (panel: HTMLElement) => number;
  /** A new width, while resizing. The owner clamps it to its absolute bounds. */
  onResize: (px: number) => void;
  /** The resize is over: the width is worth persisting. */
  onCommit: () => void;
}): JSX.Element {
  const [resizing, setResizing] = useState(false);
  const outward = props.edge === "right" ? 1 : -1;

  const apply = (panel: HTMLElement, px: number) =>
    props.onResize(Math.min(px, props.maxWidth(panel)));

  // Pointer capture keeps the gesture alive over the results canvas (which
  // swallows pointer events of its own), and the width is persisted once on
  // release rather than on every move. The start is the width on screen, which
  // a narrow viewport can hold below the stored one.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const panel = handle.parentElement!;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    handle.setPointerCapture(pointerId);
    // A resize starting inside a drawer isn't a swipe to close it.
    claimPointer(pointerId);
    setResizing(true);

    const onMove = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      apply(panel, startWidth + outward * (ev.clientX - startX));
    };
    const onUp = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      releasePointer(pointerId);
      setResizing(false);
      props.onCommit();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const direction =
      e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (direction === 0) return;
    e.preventDefault();
    const panel = e.currentTarget.parentElement!;
    apply(
      panel,
      panel.getBoundingClientRect().width + direction * outward * RESIZE_STEP,
    );
    props.onCommit();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      tabIndex={0}
      className={cx(
        "hover:bg-accent/40 focus-visible:bg-accent/40 absolute inset-y-0 z-10 w-[7px] cursor-col-resize touch-none outline-none pointer-coarse:inset-y-auto pointer-coarse:top-1/2 pointer-coarse:h-20 pointer-coarse:w-7 pointer-coarse:-translate-y-1/2 pointer-coarse:rounded-full",
        {
          "-left-[3px] pointer-coarse:-left-3.5": props.edge === "left",
          "-right-[3px] pointer-coarse:-right-3.5": props.edge === "right",
          "bg-accent/40": resizing,
        },
      )}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <span className="bg-ink-weak/60 absolute inset-y-5 left-1/2 hidden w-1 -translate-x-1/2 rounded-full pointer-coarse:block" />
    </div>
  );
}
