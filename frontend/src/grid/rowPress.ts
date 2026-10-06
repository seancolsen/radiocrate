// What a press on a result row turns into: nothing (a click, or a scroll), a
// drag of the rows, or — for a touch held still — a context menu. The results
// grid (`canvasGrid.ts`) feeds it pointer events and acts on what it decides,
// so the decision itself is plain code that a unit test can drive with
// synthetic events and fake timers.
//
// It presses the way the explorer's tree does (`gestures/useTreeDrag.ts`), with
// the same thresholds (`gestures/press.ts`):
//   • a mouse or pen picks the rows up by moving past a small threshold;
//   • a touch picks them up by resting on the row (a long press), so a swipe
//     still scrolls;
//   • a touch that picks the rows up and lets go without having dropped them
//     anywhere is a long press, not a drag: it raises the row's context menu.

import {
  DRAG_THRESHOLD,
  HOLD_SLOP,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
} from "../gestures/press";

/** One pointer event, as much of it as a press reads. `x` and `y` are viewport
 * coordinates. */
export interface PressPoint {
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
}

/** What the press asks of the grid it belongs to. */
export interface RowPressHost {
  /** A touch has rested on the row long enough to pick it up. Whatever else
   * the finger was doing (scrolling the rows) stops here. */
  onPickUp: () => void;
  /** The press on `row` would become a drag, at viewport point (x, y).
   * Returns whether it did: `false` leaves the rows where they are. */
  onDragStart: (row: number, x: number, y: number) => boolean;
  /** The drag moved to (x, y). */
  onDragMove: (x: number, y: number) => void;
  /** The drag ended, at (x, y): released (`drop`), or called off. Returns
   * whether the release dropped the rows somewhere. */
  onDragEnd: (x: number, y: number, drop: boolean) => boolean;
  /** A touch picked the row up and let go without dropping it anywhere — the
   * touch equivalent of a right-click, at (x, y). */
  onHold: (row: number, x: number, y: number) => void;
}

/** `pressing`: down, but not yet anything more. `held`: a touch picked the row
 * up, but the rows couldn't be dragged. `dragging`: the rows are in hand.
 * `putDown`: the drag was called off, and the pointer is still down. */
type Phase = "pressing" | "held" | "dragging" | "putDown";

interface Session {
  row: number;
  pointerId: number;
  touch: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  phase: Phase;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Tracks one press on a result row at a time. */
export class RowPress {
  private session: Session | undefined;

  constructor(private readonly host: RowPressHost) {}

  /** The pointer being tracked, if any. */
  get pointerId(): number | undefined {
    return this.session?.pointerId;
  }

  /** Whether a touch is resting on a row, or has picked it up — when the
   * platform's own long-press menu must stay away. */
  get touching(): boolean {
    return this.session?.touch ?? false;
  }

  /** Whether the press has picked its row up (whether or not the rows are
   * still in hand), so it's no longer about the row it went down on. */
  get pickedUp(): boolean {
    const phase = this.session?.phase;
    return phase !== undefined && phase !== "pressing";
  }

  /** Whether the rows are being dragged. */
  get dragging(): boolean {
    return this.session?.phase === "dragging";
  }

  /** A press went down on `row`. Ignored while another press is tracked. */
  down(p: PressPoint, row: number): void {
    if (this.session) return;
    const s: Session = {
      row,
      pointerId: p.pointerId,
      touch: p.pointerType === "touch",
      startX: p.x,
      startY: p.y,
      x: p.x,
      y: p.y,
      phase: "pressing",
      timer: undefined,
    };
    this.session = s;
    if (s.touch) {
      s.timer = setTimeout(() => {
        if (this.session === s) this.pickUp(s);
      }, LONG_PRESS_MS);
    }
  }

  move(p: PressPoint): void {
    const s = this.session;
    if (!s || p.pointerId !== s.pointerId) return;
    s.x = p.x;
    s.y = p.y;
    if (s.phase === "dragging") {
      this.host.onDragMove(s.x, s.y);
      return;
    }
    if (s.phase !== "pressing") return;
    const moved = Math.hypot(s.x - s.startX, s.y - s.startY);
    // A touch that travels before its long press completes is a scroll.
    if (s.touch) {
      if (moved > LONG_PRESS_SLOP) this.clear();
      return;
    }
    if (moved < DRAG_THRESHOLD) return;
    if (this.host.onDragStart(s.row, s.x, s.y)) s.phase = "dragging";
    // A press that can't drag anything is just a click, wherever it ends.
    else this.clear();
  }

  /** The pointer was released. Returns whether the press had picked its row
   * up, so the click the release produces belongs to the press and must not
   * also count as a click on whatever lies under it. */
  up(p: PressPoint): boolean {
    const s = this.session;
    if (!s || p.pointerId !== s.pointerId) return false;
    s.x = p.x;
    s.y = p.y;
    this.clear();
    if (s.phase === "pressing") return false;
    if (s.phase === "putDown") return true;
    const dropped =
      s.phase === "dragging" && this.host.onDragEnd(s.x, s.y, true);
    if (s.touch && !dropped && isHold(s)) this.host.onHold(s.row, s.x, s.y);
    return true;
  }

  /** Calls the drag off (Escape), dropping nothing. The pointer is still down,
   * so the press lasts until it's released: the moves meanwhile do nothing, and
   * the release's click is still the press's. */
  putDown(): void {
    const s = this.session;
    if (s?.phase !== "dragging") return;
    s.phase = "putDown";
    this.host.onDragEnd(s.x, s.y, false);
  }

  /** Calls the press off, dropping nothing: the pointer was cancelled, or the
   * grid stopped taking input. */
  cancel(): void {
    const s = this.session;
    if (!s) return;
    this.clear();
    if (s.phase === "dragging") this.host.onDragEnd(s.x, s.y, false);
  }

  private pickUp(s: Session): void {
    s.timer = undefined;
    this.host.onPickUp();
    s.phase = this.host.onDragStart(s.row, s.x, s.y) ? "dragging" : "held";
  }

  private clear(): void {
    clearTimeout(this.session?.timer);
    this.session = undefined;
  }
}

/** Whether a press that dropped nothing stayed close enough to where it began
 * to be a long press. */
function isHold(s: Session): boolean {
  return Math.hypot(s.x - s.startX, s.y - s.startY) < HOLD_SLOP;
}
