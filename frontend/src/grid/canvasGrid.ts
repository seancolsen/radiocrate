// The columnar results grid rendered to a <canvas> (DOM-UI experiment, canvas
// variant). This is the canvas analog of the retained-DOM grid that previously
// lived in QueryResults.tsx: same result model, same field-layout algorithm,
// same geometry constants and visual treatment (row gradient, hairline
// separator, warm pills, per-column fonts/colors/alignment) — but every row is
// painted imperatively into one canvas rather than materialized as DOM nodes.
//
// Only the *visible* window of rows is drawn each frame (windowed by the scroll
// offset), so paint cost is bounded by the viewport, not the row count.
//
// The canvas owns ALL scrolling — nothing scrolls natively:
//   • mouse wheel        → `wheel` handler adjusts the scroll offset
//   • scrollbar          → a custom thumb drawn on the right edge, draggable
//   • touch              → drag-to-pan with hand-rolled inertia (velocity
//                          tracking + an exponential-decay rAF loop)
//
// Scroll offset 0 puts the first row at the top, and the offset may go negative
// when the owner has reserved a band there for a floating overlay of its own
// (`setTopOverscroll` — the multi-select toolbar): the rows it covers are then
// scrollable into the clear, as they'd be under a sticky header.
//
// Row interaction is hit-tested against the same windowed geometry: pointer moves
// track a hovered row (repainted with a subtly shifted background), clicks report
// a `(row, modifiers)` selection intent to the owner, right-clicks report a
// context-menu request, and double-clicks report a row activation. The selection
// itself lives outside the engine (the query page's per-tab state) and is pushed
// back in via `setSelection` for painting — the grid renders selection, it
// doesn't own it.
//
// A press on a row can also pick the rows up to drag them (`RowPress`): a mouse
// or pen by moving past a small threshold, a touch by resting on the row. A
// touch held still and let go raises the row's context menu instead, in place
// of the platform's own long-press `contextmenu`. Where the rows can go is the
// owner's business: the grid only reports the drag's start, moves and end.
// When the owner says the rows can also be dropped among these rows (a
// playlist's page, `setDropGap`), the grid draws the drop line where it's told
// and scrolls itself while the drag sits near its top or bottom edge, as the
// explorer's tree does; `gapAt` says which gap between rows a point is over.
//
// A touch that hasn't rested starts out undecided, and its first few px say
// what it is. Up or down, it pans; pulled down past the top, it takes the rows
// with it, and letting go far enough along asks the owner to refresh them
// (`onPullRefresh`), while a spinner in the gap waits on `setRefreshing`. Left
// or right along a row the owner has an action for that way
// (`onRowSwipeStart`: left edits, right queues), it takes that row with it,
// along with the rest of the selection if the row is part of it, over a band
// naming the action, and letting go far enough along asks the owner to act on
// them (`onRowSwipe`). Neither answers to a mouse, which has the wheel, Refresh,
// the context menu and Alt+click.
//
// The owner can also freeze the grid (`setFrozen`) while a menu it opened is up:
// scrolling, hovering and clicking all stop, so the rows under an open context
// menu hold still. The DOM overlay above the canvas already swallows the events
// that reach it; freezing covers what it can't (a wheel over the menu itself, a
// pointer that was mid-gesture when the menu opened).

import { edgeScrollDelta, swallowReleaseClick } from "../gestures/press";
import {
  releaseVelocity,
  swipeAxis,
  type SwipeSample,
} from "../gestures/swipe";
import { colSizesOf, type QueryResult } from "../query/result";
import { createLayoutMemo, type Placement } from "../query/fieldLayout";
import {
  BODY_FONT,
  BODY_LINE_H,
  COL_GAP,
  ROW_PAD_Y,
  SMALL_FONT,
  SMALL_LINE_H,
  TEXT_PAD_X,
} from "../query/rowGeometry";
import {
  fingerForPull,
  PULL_HOLD,
  PULL_TRIGGER,
  pullDistance,
  ROW_SWIPE_DISTANCE,
  rowSwipeCommits,
  settle,
} from "./rowGestures";
import { RowPress, type PressPoint } from "./rowPress";

// ── Geometry (logical px == CSS px). The row metrics are shared with the record
// editor's embedded record widget (see `query/rowGeometry.ts`); what's left here
// is what only the canvas draws. ──

/** Extra height a line gains when it holds a pill column (`PILL_LINE_EXTRA`). */
const PILL_LINE_EXTRA = 6;

// Pill geometry (mirrors `.rc-pill`: padding 2px 6px, 4px gap, radius 4).
const PILL_PAD_X = 6;
const PILL_PAD_Y = 2;
const PILL_GAP = 4;
const PILL_RADIUS = 4;
const PILL_LINE_HEIGHT = 1.2;

// The playing row is ringed by a rounded blue rectangle: inset from the row's
// box so the ring reads as a frame around the row rather than a border between
// rows, and stroked thick enough to hold its color at a glance on a dense grid.
const CURRENT_MARKER_INSET = 2;
const CURRENT_MARKER_W = 2;
const CURRENT_MARKER_RADIUS = 8;

// A queued row wears the same ring, dashed. With more than one track queued,
// a badge on the ring's top-left corner gives the row's place in the queue.
const QUEUED_MARKER_DASH = [6, 4];
const QUEUE_BADGE_H = 14;
const QUEUE_BADGE_PAD_X = 4;
const QUEUE_BADGE_FONT = 10;
/** Where the badge's left edge sits, in from the row's. */
const QUEUE_BADGE_X = 6;

/** The glyph marking a row whose record has unsaved edits in the record editor,
 * drawn large enough to read at a glance over the row's left padding. */
const MODIFIED_MARKER = "✱";
const MODIFIED_MARKER_FONT = 18;

// The drop line between rows, while rows being dragged would land there: the
// explorer tree's line (a 2px rounded accent bar, just inside the edges).
const DROP_LINE_H = 2;
const DROP_LINE_INSET = 4;

/** Opacity of the top-lit sheen gradient layered over a selected row's flat fill,
 * so the sheen reads without hiding the selection color (SELECTED_ROW_GRADIENT_
 * ALPHA = 90/255 in results.rs). */
const SELECTED_SHEEN_ALPHA = 90 / 255;

// Scrollbar (custom overlay, macOS-style). It comes and goes as the sidebars'
// does: at full strength the moment the rows scroll, fading in while the mouse
// is over them, and fading out a second after both have stopped.
const SB_WIDTH = 8;
const SB_MARGIN = 2;
const SB_MIN_THUMB = 24;
/** Extra horizontal slop around the thumb for an easier grab (logical px). */
const SB_GRAB_SLOP = 8;
/** How long (ms) the thumb stays once the rows stop scrolling, or the mouse
 * leaves them — the sidebars' `ScrollArea` wait. */
const SB_HIDE_AFTER_MS = 1000;
/** How long (ms) the thumb takes to fade in or out (`ScrollArea`'s too). */
const SB_FADE_MS = 200;

// Touch inertia.
/** Velocity below which the fling stops (logical px per ms). */
const MIN_FLING_VELOCITY = 0.015;
/** Exponential decay time constant of the fling (ms). Larger = longer glide. */
const FLING_TAU = 325;
/** A pause longer than this before release cancels the fling (finger held). */
const FLING_RELEASE_TIMEOUT = 80;

// The spinner in the gap above rows being pulled: an arc that grows as the pull
// nears its trigger, and turns while a refresh is under way.
const PULL_SPINNER_RADIUS = 9;
const PULL_SPINNER_W = 2;
/** How much of a circle the arc covers at its fullest (radians). */
const PULL_SPINNER_SWEEP = 1.5 * Math.PI;
/** How fast the arc turns (radians per ms). */
const PULL_SPINNER_SPEED = 0.006;

/** How far in from the edge it uncovers the swipe band's label sits. */
const SWIPE_LABEL_INSET = 16;

/** Theme colors read from CSS custom properties, so canvas paint tracks the
 * live light/dark theme just like the DOM did. Re-read on theme change. */
interface Theme {
  panel: string;
  rowTop: string;
  rowBottom: string;
  /** Row gradient endpoints shifted toward the foreground for the hover state
   * (darker in light mode, lighter in dark mode). */
  rowTopHover: string;
  rowBottomHover: string;
  rowSep: string;
  pillBg: string;
  /** Flat fill of a selected row, and its (darker) hovered variant. */
  selectedBg: string;
  selectedBgHover: string;
  ink: string;
  inkWeak: string;
  scrollThumb: string;
  /** The rectangle ringing the playing row, and the translucent wash over the
   * rest of that row. */
  currentMarker: string;
  currentWash: string;
  /** The unsaved-changes ✱, in the same red as everywhere else. */
  danger: string;
  /** The drop line, in the accent the tree's drop line uses. */
  accent: string;
}

/** Which way a row is swiped. */
export type SwipeDirection = "left" | "right";

/** Callbacks the owner wires up to react to row interaction. */
export interface GridInteraction {
  /** A row was clicked, with the click's range/toggle modifiers, and whether
   * Alt (Option) was held. */
  onRowClick: (
    index: number,
    mods: { shift: boolean; ctrl: boolean; alt: boolean },
  ) => void;
  /** A row was double-clicked (row activation, e.g. play the track). */
  onRowDoubleClick: (index: number) => void;
  /** A row was right-clicked (or held still under a touch and let go), at the
   * given viewport coordinates — where the owner anchors its DOM menu. */
  onRowContextMenu: (index: number, x: number, y: number) => void;
  /** The keyboard asked for a context menu (the Menu key, or Shift+F10) while
   * the grid had focus: for whichever rows the owner has selected, since the
   * keyboard points at none of them. See {@link CanvasGrid.rowMenuPoint}. */
  onKeyboardContextMenu?: () => void;
  /** A press on row `index` would pick the rows up, at viewport point (x, y).
   * Returns whether the owner took them: `false` (or leaving this out) means
   * these rows don't drag, and the press stays a click — or, under a touch
   * held still, a context menu. */
  onRowDragStart?: (index: number, x: number, y: number) => boolean;
  /** The rows being dragged moved to viewport point (x, y) — or the pointer
   * stayed there while the grid scrolled other rows under it. */
  onRowDragMove?: (x: number, y: number) => void;
  /** The drag ended at (x, y): released (`drop`), or called off (Escape, a
   * cancelled pointer, the grid freezing or going away). Returns whether the
   * release dropped the rows somewhere. */
  onRowDragEnd?: (x: number, y: number, drop: boolean) => boolean;
  /** A touch began swiping row `index` `direction`-ward. Returns the name of
   * what letting go would do, which the band the row uncovers shows: `null`
   * (or leaving this out) means nothing, which leaves the row where it is, and
   * the touch goes on as a pan. */
  onRowSwipeStart?: (index: number, direction: SwipeDirection) => string | null;
  /** A swipe on row `index` went far enough `direction`-ward to act on. */
  onRowSwipe?: (index: number, direction: SwipeDirection) => void;
  /** A pull past the top went far enough to refresh the rows. */
  onPullRefresh?: () => void;
}

/** The width-dependent layout, recomputed only on resize or a new result (not
 * per frame): each column's placement, the shared row height, and per-line
 * tops/heights. Mirrors `applyLayout` in the old DOM renderer. */
interface GridLayout {
  placements: Placement[];
  rowH: number;
  lineTops: number[];
  lineHeights: number[];
}

function fontSizeOf(size: "small" | "normal"): number {
  return size === "small" ? SMALL_FONT : BODY_FONT;
}

/** Traces a rounded-rect path (uses the native `roundRect` when present). */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class CanvasGrid {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly memo = createLayoutMemo();

  private result: QueryResult | undefined;
  private layout: GridLayout | undefined;
  private theme: Theme;
  private fontFamily = "sans-serif";

  // Cache of vertical font metrics keyed by the exact `ctx.font` string. The
  // font's ascent/descent are constant per size+family, so measure once and
  // reuse; cleared when the font family changes or a web font finishes loading.
  private readonly metrics = new Map<
    string,
    { ascent: number; descent: number }
  >();

  // Viewport size in logical (CSS) px; backing store is this × dpr.
  private vw = 0;
  private vh = 0;
  private dpr = 1;

  private scrollTop = 0;
  /** How far above the first row the view may scroll (see
   * {@link setTopOverscroll}). */
  private topInset = 0;

  // Row interaction: the selection (owned outside, pushed in for painting), the
  // currently-hovered row, the last mouse Y (to re-derive hover after a scroll),
  // and the owner's interaction callbacks.
  private selection: ReadonlySet<number> = new Set();
  /** The row holding the now-playing track, when it's in this result set. */
  private currentRow: number | undefined;
  /** The rows holding queued tracks, each with its place in the queue to show
   * (`null` for none). */
  private queuedRows: ReadonlyMap<number, number | null> = new Map();
  /** Rows whose record has unsaved changes in the record editor. */
  private modifiedRows: ReadonlySet<number> = new Set();
  private hoverRow: number | undefined;
  private lastMouseY: number | undefined;
  private interaction: GridInteraction | undefined;
  /** While true the grid ignores every input (see `setFrozen`). */
  private frozen = false;
  /** Whether the `contextmenu` to come is the keyboard's: the Menu key or
   * Shift+F10 went down since the last press on the rows. */
  private keyboardMenu = false;
  /** Where rows in hand would drop among these rows (see `setDropGap`). */
  private dropGap: number | null | undefined;
  /** Where the pointer dragging rows is, in viewport coordinates. */
  private dragPoint: { x: number; y: number } | undefined;

  /** How far (px) the rows sit below where the scroll puts them: under a pull,
   * waiting on a refresh, or going home from either. */
  private pull = 0;
  /** The finger travel behind {@link pull}, while a pan has hold of it. */
  private pullFinger = 0;
  /** Whether the rows wait where they are for a refresh a pull began. */
  private pullHeld = false;
  /** Whether a refresh is under way, whatever began it (`setRefreshing`). */
  private refreshing = false;
  /** The spinner's turn, in radians. */
  private pullSpin = 0;

  /** The row a swipe took hold of, until it has gone home. */
  private swipeRow: number | undefined;
  /** How far it has come, in px from home: negative leftward. */
  private swipeOffset = 0;
  /** The band it uncovers names this. */
  private swipeLabel = "";

  // Frame scheduling: one rAF coalesces draws; the same loop steps the fling.
  private raf = 0;
  private dirty = false;
  private destroyed = false;
  private flinging = false;
  private velocity = 0; // logical px per ms
  private lastFrameT = 0;

  // Active pointer gesture (a touch not yet decided, a pan, a swipe along a row,
  // or a scrollbar drag). A press on a row is tracked alongside it (`press`): a
  // touch pans and may also pick the row up.
  private gesture:
    | {
        kind: "touch";
        id: number;
        startX: number;
        startY: number;
        row: number | undefined;
      }
    | { kind: "pan"; id: number; lastY: number; lastT: number }
    | {
        kind: "swipe";
        id: number;
        originX: number;
        direction: -1 | 1;
        samples: SwipeSample[];
      }
    | { kind: "scrollbar"; id: number; grabOffset: number }
    | undefined;
  private rect: DOMRect | undefined;

  // Last-drawn thumb geometry, for pointer hit-testing.
  private thumb: { y: number; h: number } | undefined;
  /** How strongly the thumb is drawn, from 0 (gone) to 1. */
  private thumbAlpha = 0;
  /** Whether a mouse (or pen) is over the rows, which keeps the thumb. */
  private mouseOver = false;
  /** Until when (`performance.now()`) the thumb stays after the last scroll,
   * or the mouse leaving. */
  private thumbUntil = 0;
  /** Wakes the frame loop to fade the thumb once {@link thumbUntil} passes. */
  private thumbTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reducedMotion: MediaQueryList | undefined =
    typeof matchMedia === "function"
      ? matchMedia("(prefers-reduced-motion: reduce)")
      : undefined;

  /** The press on a row, which may pick the rows up (see `rowPress.ts`). */
  private readonly press = new RowPress({
    onPickUp: () => {
      // The finger now holds the rows; it no longer scrolls them.
      this.gesture = undefined;
      this.pullFinger = 0;
      this.stopFling();
      this.requestDraw();
      navigator.vibrate?.(10);
    },
    onDragStart: (row, x, y) => {
      const taken = this.interaction?.onRowDragStart?.(row, x, y) ?? false;
      if (!taken) return false;
      // The drag's moves keep coming here wherever the pointer goes.
      const id = this.press.pointerId;
      if (id !== undefined && !this.canvas.hasPointerCapture(id)) {
        this.canvas.setPointerCapture(id);
      }
      window.addEventListener("keydown", this.onDragKey, true);
      this.dragPoint = { x, y };
      this.hoverRow = undefined;
      // Also starts the frame loop that scrolls near the edges.
      this.requestDraw();
      return true;
    },
    onDragMove: (x, y) => {
      this.dragPoint = { x, y };
      this.interaction?.onRowDragMove?.(x, y);
    },
    onDragEnd: (x, y, drop) => {
      window.removeEventListener("keydown", this.onDragKey, true);
      this.dragPoint = undefined;
      return this.interaction?.onRowDragEnd?.(x, y, drop) ?? false;
    },
    onHold: (row, x, y) => this.interaction?.onRowContextMenu(row, x, y),
  });

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.theme = this.readTheme();

    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("dblclick", this.onDblClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("keydown", this.onKeyDown);

    // Re-paint once web fonts finish loading so text metrics (and thus ellipsis
    // truncation and pill widths) are measured against the real font.
    // Canvas text doesn't reliably start a font's download, so ask for the
    // face outright rather than waiting for DOM text to pull it in.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      const family = getComputedStyle(canvas).fontFamily;
      void Promise.all([
        document.fonts.load(`14px ${family}`, "Aa"),
        document.fonts.ready,
      ]).then(() => {
        // The fonts can outlast this grid, and its canvas may have a new grid
        // by now (a tab shown again, a StrictMode remount) that this would
        // paint over.
        if (this.destroyed) return;
        this.metrics.clear(); // real font may differ from the fallback metrics
        this.requestDraw();
      });
    }

    this.resize();
  }

  destroy(): void {
    this.destroyed = true;
    const c = this.canvas;
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerCancel);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("click", this.onClick);
    c.removeEventListener("dblclick", this.onDblClick);
    c.removeEventListener("contextmenu", this.onContextMenu);
    c.removeEventListener("keydown", this.onKeyDown);
    // A drag under way when the grid goes (its tab hidden) drops nothing.
    this.press.cancel();
    clearTimeout(this.thumbTimer);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Swaps in a new result (or clears): recomputes the layout and repaints.
   * Called when the tab's result changes.
   *
   * The scroll goes back to the top because new rows are *other* rows — row 200
   * of the query you just narrowed isn't the row you were looking at.
   * `preserveScroll` is the exception: a re-run that compiled to the very same
   * query (Refresh), where these are the same rows and the user's place in them
   * is worth keeping. It's clamped, since the re-run may have come back
   * shorter, and the hover is re-derived rather than dropped — the pointer
   * hasn't moved, but the row under it may have. */
  setResult(result: QueryResult | undefined, preserveScroll = false): void {
    // A press that hasn't picked its row up yet was on a row of the old rows.
    // One that has holds what it picked up, whatever the rows are now.
    if (!this.press.pickedUp) this.press.cancel();
    // Likewise a touch on one of them: it can still pan, but a swipe is over.
    if (this.gesture?.kind === "swipe") this.gesture = undefined;
    else if (this.gesture?.kind === "touch") this.gesture.row = undefined;
    this.result = result;
    if (!preserveScroll) this.scrollTop = 0;
    this.flinging = false;
    this.velocity = 0;
    this.hoverRow = undefined;
    this.relayout();
    if (preserveScroll) {
      this.clampScroll();
      if (this.lastMouseY !== undefined) this.updateHover(this.lastMouseY);
    }
    this.requestDraw();
  }

  /** The current scroll offset, in logical px below the first row (negative
   * while an overlay has reserved space above it). Read when a tab hands the
   * shared grid over to the next one — see {@link setScrollOffset}. */
  scrollOffset(): number {
    return this.scrollTop;
  }

  /** Puts a scroll offset back, clamped to what the current result allows.
   *
   * One `CanvasGrid` serves every tab in turn, so a tab switch is a swap of
   * result, selection *and* the place in the rows the user had reached; the
   * results pane keeps the last of those per tab and restores it here (the
   * first two ride in on the store). Any fling in flight belonged to the tab
   * being left, so it's dropped. */
  setScrollOffset(px: number): void {
    this.stopFling();
    this.scrollTop = px;
    this.clampScroll();
    if (this.lastMouseY !== undefined) this.updateHover(this.lastMouseY);
    this.requestDraw();
  }

  /** Repaints the current result. For a change *within* the rows the engine
   * already holds — a row re-read after a DML write, which re-points the row at
   * a fresh one-row table (see the store's `patchRow`) — where the result
   * object, the layout and the scroll position all still stand. */
  redraw(): void {
    this.requestDraw();
  }

  /** Registers the owner's row-interaction callbacks (click / double-click /
   * context menu). */
  setInteraction(interaction: GridInteraction): void {
    this.interaction = interaction;
  }

  /** Freezes or thaws input. While frozen the grid neither scrolls, hovers, nor
   * reports clicks — the state the results pane sits in while a context menu it
   * raised is open. Freezing also drops the hover highlight and cancels any
   * in-flight gesture, press or fling, so nothing keeps moving underneath the
   * menu. */
  setFrozen(frozen: boolean): void {
    if (frozen === this.frozen) return;
    this.frozen = frozen;
    if (!frozen) return;
    this.stopFling();
    this.gesture = undefined;
    this.pullFinger = 0;
    this.press.cancel();
    this.lastMouseY = undefined;
    this.hoverRow = undefined;
    this.requestDraw();
  }

  /** Says whether a refresh of these rows is under way. Rows a pull left waiting
   * go home when it ends; otherwise there's nothing to show for it here. */
  setRefreshing(refreshing: boolean): void {
    this.refreshing = refreshing;
    if (refreshing) return;
    this.pullHeld = false;
    this.requestDraw();
  }

  /** Pushes in the owner's current row selection for painting. Cheap to call on
   * every selection change — repaints only when the set actually differs. */
  setSelection(selection: ReadonlySet<number>): void {
    if (selection === this.selection) return;
    this.selection = selection;
    this.requestDraw();
  }

  /** Says whether rows being dragged can be dropped among these rows, and
   * where the drop line goes: `undefined` when they can't (no line, and the
   * grid doesn't scroll at its edges), `null` when they can but not at the
   * pointer (no line), or the gap the line marks, above row `gap` (below the
   * last row when `gap` is the row count). */
  setDropGap(gap: number | null | undefined): void {
    if (gap === this.dropGap) return;
    this.dropGap = gap;
    this.requestDraw();
  }

  /** The gap between rows that viewport point (x, y) is over: the row
   * boundary nearest it, from 0 (above the first row) to the row count (below
   * the last). A point above or below the grid counts as being at its edge, so
   * a drag held there names the gap it's scrolling toward. `undefined` when
   * the point is to either side of the grid, or there are no rows. */
  gapAt(x: number, y: number): number | undefined {
    const layout = this.layout;
    const count = this.result?.rowCount ?? 0;
    if (!layout || count === 0) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    if (x < rect.left || x > rect.right) return undefined;
    const local = Math.max(0, Math.min(this.vh, y - rect.top));
    const gap = Math.round((local + this.viewTop) / layout.rowH);
    return Math.max(0, Math.min(count, gap));
  }

  /** Reserves `px` of scrollable space above the first row, for a floating
   * overlay the owner paints over the top of the grid (the multi-select
   * toolbar). The rows aren't moved: the view can simply be scrolled up past
   * them by that much, so the rows the overlay covers can be read by scrolling
   * — the same bargain a sticky header strikes. `0` gives it back. */
  setTopOverscroll(px: number): void {
    const inset = Math.max(0, px);
    if (inset === this.topInset) return;
    this.topInset = inset;
    this.stopFling();
    this.clampScroll();
    this.requestDraw();
  }

  /** Marks the rows whose records the record editor is holding unsaved changes
   * for, painted with a red ✱ in the left margin. Replaced wholesale, like the
   * selection, so a new set means a repaint. */
  setModifiedRows(rows: ReadonlySet<number>): void {
    if (rows === this.modifiedRows) return;
    this.modifiedRows = rows;
    this.requestDraw();
  }

  /** Marks the row playing right now (`undefined` when the now-playing track
   * isn't in this result set), painted with a blue ring and a faint wash. */
  setCurrentRow(row: number | undefined): void {
    if (row === this.currentRow) return;
    this.currentRow = row;
    this.requestDraw();
  }

  /** Marks the rows holding queued tracks, painted with a dashed blue ring —
   * and, where the row's place in the queue is given, a badge numbering it.
   * Replaced wholesale, like the selection. */
  setQueuedRows(rows: ReadonlyMap<number, number | null>): void {
    if (rows === this.queuedRows) return;
    this.queuedRows = rows;
    this.requestDraw();
  }

  /** Re-reads the backing-store size for the current viewport + devicePixelRatio,
   * re-derives the layout for the new width, clamps scroll, and repaints.
   *
   * Sizes the canvas so its backing store maps **1:1 onto the physical pixel
   * grid**, which is the crux of keeping text crisp at a fractional dpr. The
   * container's box is measured at sub-pixel precision (`getBoundingClientRect`),
   * the backing store is the largest whole number of device pixels that fits
   * (`floor(css * dpr)`), and the canvas's CSS box is then pinned to exactly
   * `backing / dpr`. Without that last step the browser paints `backing` device
   * px into a `css * dpr` box — a non-integer rescale that re-blurs every glyph
   * (undoing our per-glyph snapping) and shifts with each pixel of resize, which
   * is why text looked crisp only at the widths where `css * dpr` happened to be
   * whole. Because the canvas now has an explicit size, the ResizeObserver must
   * watch the *container* (see QueryResults), not the canvas itself. */
  resize(): void {
    const host = this.canvas.parentElement ?? this.canvas;
    const rect = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(0, Math.floor(rect.width * dpr));
    const bh = Math.max(0, Math.floor(rect.height * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    // Pin the CSS box to an exact multiple of device pixels (1:1 mapping).
    const cssW = bw / dpr;
    const cssH = bh / dpr;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.vw = cssW;
    this.vh = cssH;
    this.dpr = dpr;
    this.rect = undefined; // invalidate cached bounding rect
    this.relayout();
    this.clampScroll();
    // Repaint synchronously, not via rAF. Assigning `canvas.width/height` above
    // cleared the backing store to transparent, and ResizeObserver (our caller)
    // fires *after* rAF callbacks within a frame — so a deferred draw wouldn't
    // run until the next frame, compositing a blank canvas in between. During a
    // live resize that blank frame recurs every event and reads as a flicker.
    // Drawing here fills the freshly-cleared buffer before the browser paints.
    this.dirty = false;
    this.draw();
  }

  /** Scrolls row `index` into view, doing nothing when it already is. Drives the
   * now-playing bar's "Locate": the row is nudged just inside the nearer edge
   * (rather than centered), which keeps its surrounding rows in place when it was
   * only a little off-screen. Any fling in progress is cancelled so the scroll
   * isn't immediately carried past the target. */
  revealRow(index: number): void {
    const layout = this.layout;
    if (!layout || index < 0) return;
    const top = index * layout.rowH;
    const bottom = top + layout.rowH;
    // The reserved band at the top is covered by an overlay, so a row revealed
    // into it wouldn't be visible — scroll it clear of the band instead.
    if (top < this.scrollTop + this.topInset)
      this.scrollTop = top - this.topInset;
    else if (bottom > this.scrollTop + this.vh)
      this.scrollTop = bottom - this.vh;
    else return;
    this.stopFling();
    this.clampScroll();
    if (this.lastMouseY !== undefined) this.updateHover(this.lastMouseY);
    this.requestDraw();
  }

  /** Where a menu for row `index` is raised from the keyboard, in viewport
   * coordinates: just inside its bottom-left corner, as a menu for a focused
   * control hangs from it. Call {@link revealRow} first, so the row is on
   * screen. `undefined` when there's no such row. */
  rowMenuPoint(index: number): { x: number; y: number } | undefined {
    const layout = this.layout;
    const count = this.result?.rowCount ?? 0;
    if (!layout || index < 0 || index >= count) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    const bottom = (index + 1) * layout.rowH - this.viewTop;
    return {
      x: rect.left + TEXT_PAD_X,
      y: rect.top + Math.max(0, Math.min(this.vh, bottom)),
    };
  }

  /** Re-reads theme colors + font family from CSS and repaints (theme toggle). */
  refreshTheme(): void {
    this.theme = this.readTheme();
    this.metrics.clear(); // font family is re-read in readTheme and may change
    this.requestDraw();
  }

  /** Where the top of the view is over the rows, a pull included. */
  private get viewTop(): number {
    return this.scrollTop - this.pull;
  }

  private get totalHeight(): number {
    if (!this.result || !this.layout) return 0;
    return this.result.rowCount * this.layout.rowH;
  }

  private get maxScroll(): number {
    return Math.max(0, this.totalHeight - this.vh);
  }

  /** The topmost scroll offset — negative while an overlay has reserved space
   * above the first row. */
  private get minScroll(): number {
    return -this.topInset;
  }

  /** How much scrolling there is to do at all: `0` means the content fits and
   * nothing is reserved above it, so every gesture is inert. */
  private get scrollRange(): number {
    return this.maxScroll - this.minScroll;
  }

  /** Snaps a logical coordinate to the device-pixel grid. The context is scaled
   * by `dpr`, so a logical `v` paints at device `v * dpr`; rounding that to a
   * whole device pixel (then back to logical) keeps glyph baselines, text
   * anchors, and hairlines from landing on fractional pixels — the cause of the
   * soft text (and the crisp/blurry shimmer while resizing, since fractional
   * column widths otherwise slide text across sub-pixel offsets). Works for
   * fractional `dpr` (e.g. 1.5 fractional-scaled displays), where snapping to
   * logical pixels alone wouldn't align to the physical grid. */
  private snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  /** Vertical metrics of the currently-set `ctx.font`, cached per font string.
   * Uses the font-wide bounding box (constant for a given size+family, unlike
   * the glyph-dependent `actualBoundingBox*`) so vertical centering doesn't jump
   * between rows with different text. */
  private fontMetrics(): { ascent: number; descent: number } {
    const key = this.ctx.font;
    let m = this.metrics.get(key);
    if (!m) {
      const tm = this.ctx.measureText("Mg");
      const ascent =
        tm.fontBoundingBoxAscent ?? tm.actualBoundingBoxAscent ?? 0;
      const descent =
        tm.fontBoundingBoxDescent ?? tm.actualBoundingBoxDescent ?? 0;
      m = { ascent, descent };
      this.metrics.set(key, m);
    }
    return m;
  }

  /** The device-snapped alphabetic baseline that visually centers text on the
   * line `centerY`. The font box spans `[B - ascent, B + descent]`, so its center
   * sits at `B + (descent - ascent) / 2`; solving for the baseline that lands
   * that center on `centerY` gives `B = centerY + (ascent - descent) / 2`.
   * Snapping the *baseline itself* (not the em-box center as `textBaseline:
   * "middle"` would) is what keeps horizontal stems on whole device pixels. */
  private centeredBaseline(centerY: number): number {
    const { ascent, descent } = this.fontMetrics();
    return this.snap(centerY + (ascent - descent) / 2);
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  private relayout(): void {
    const result = this.result;
    if (!result || result.rowCount === 0) {
      this.layout = undefined;
      return;
    }
    const cols = colSizesOf(result);
    const avail = Math.max(0, this.vw - TEXT_PAD_X * 2);
    const fl = this.memo(cols, avail, COL_GAP);

    const lineHeights = new Array<number>(fl.lineCount).fill(0);
    result.visible.forEach((col, k) => {
      const p = fl.placements[k];
      let h =
        fontSizeOf(col.meta.font_size) === SMALL_FONT
          ? SMALL_LINE_H
          : BODY_LINE_H;
      if (col.isList) h += PILL_LINE_EXTRA;
      lineHeights[p.line] = Math.max(lineHeights[p.line], h);
    });
    const lineTops = new Array<number>(fl.lineCount).fill(0);
    let acc = 0;
    for (let i = 0; i < fl.lineCount; i++) {
      lineTops[i] = acc;
      acc += lineHeights[i];
    }
    const contentH = fl.lineCount === 0 ? BODY_LINE_H : acc;
    const rowH = contentH + ROW_PAD_Y * 2;
    this.layout = { placements: fl.placements, rowH, lineTops, lineHeights };
  }

  // ── Scrolling ───────────────────────────────────────────────────────────────

  private clampScroll(): void {
    const max = this.maxScroll;
    const min = this.minScroll;
    if (this.scrollTop < min) this.scrollTop = min;
    else if (this.scrollTop > max) this.scrollTop = max;
  }

  /** Applies a scroll delta, clamping to bounds. Returns whether it hit a bound
   * (used to end a fling that runs off the top/bottom). */
  private scrollBy(dy: number): boolean {
    const before = this.scrollTop;
    this.scrollTop = before + dy;
    this.clampScroll();
    this.dirty = true;
    if (this.scrollTop !== before) this.showThumb();
    return (
      this.scrollTop === this.minScroll || this.scrollTop === this.maxScroll
    );
  }

  private onWheel = (e: WheelEvent): void => {
    if (this.frozen || this.scrollRange <= 0) return;
    this.stopFling();
    // Normalize line/page deltas to pixels so trackpads and mice agree.
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= BODY_LINE_H;
    else if (e.deltaMode === 2) dy *= this.vh;
    this.scrollBy(dy);
    // The stationary cursor now sits over a different row — keep hover in step.
    if (this.lastMouseY !== undefined) this.updateHover(this.lastMouseY);
    this.requestDraw();
    e.preventDefault();
  };

  // ── Pointer gestures: touch pan (+ fling), scrollbar-thumb drag, row press ──

  private localPoint(e: PointerEvent): { x: number; y: number } {
    if (!this.rect) this.rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }

  /** The event as a press reads it, in viewport coordinates. */
  private static pressPoint(e: PointerEvent): PressPoint {
    return {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      x: e.clientX,
      y: e.clientY,
    };
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.keyboardMenu = false;
    if (this.frozen || this.gesture || this.press.pointerId !== undefined) {
      return;
    }
    const { x, y } = this.localPoint(e);

    // A press on the scrollbar thumb starts a thumb drag (any pointer type).
    if (this.scrollRange > 0 && this.thumb && this.hitThumb(x, y)) {
      this.stopFling();
      this.gesture = {
        kind: "scrollbar",
        id: e.pointerId,
        grabOffset: y - this.thumb.y,
      };
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Touch anywhere else pans the content or swipes a row, as its first few px
    // will say (a mouse scrolls by wheel or the scrollbar instead) — and, on a
    // row, may also pick it up. Even with nothing to scroll: it can still pull.
    if (e.pointerType === "touch") {
      this.stopFling();
      this.gesture = {
        kind: "touch",
        id: e.pointerId,
        startX: x,
        startY: y,
        row: this.rowAt(y),
      };
      this.velocity = 0;
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }

    // A primary press on a row (not the scrollbar's column) may pick the rows
    // up, or (under a touch held still) raise their menu.
    if (e.button !== 0 || this.overScrollbar(x)) return;
    const row = this.rowAt(y);
    if (row !== undefined) this.press.down(CanvasGrid.pressPoint(e), row);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.frozen) return;
    if (e.pointerId === this.press.pointerId) {
      this.press.move(CanvasGrid.pressPoint(e));
    }
    const g = this.gesture;
    // A mouse over the rows keeps the scrollbar (a finger, which can't hover,
    // shows it by scrolling).
    if (e.pointerType !== "touch" && !this.mouseOver) {
      this.mouseOver = true;
      this.requestDraw();
    }
    // Not mid-gesture: a mouse move only updates the hovered row — unless the
    // rows are in hand, which leaves them as they were. (Touch has no hover; a
    // pan is handled below once its gesture is active.)
    if (!g) {
      if (e.pointerType === "mouse" && !this.press.dragging) {
        const { x, y } = this.localPoint(e);
        this.lastMouseY = y;
        // Over the scrollbar's column, the pointer is at the thumb, not a row.
        if (this.overScrollbar(x)) this.clearHover();
        else this.updateHover(y);
      }
      return;
    }
    if (e.pointerId !== g.id) return;
    const { x, y } = this.localPoint(e);

    if (g.kind === "touch") {
      this.decideTouch(g, x, y, e.timeStamp);
      e.preventDefault();
      return;
    }

    if (g.kind === "swipe") {
      const travel = (x - g.originX) * g.direction;
      this.swipeOffset = Math.max(0, Math.min(this.vw, travel)) * g.direction;
      g.samples.push({ x, t: e.timeStamp });
      if (g.samples.length > 32) g.samples.shift();
      this.requestDraw();
      e.preventDefault();
      return;
    }

    if (g.kind === "scrollbar") {
      const range = this.vh - (this.thumb?.h ?? 0);
      const thumbY = Math.max(0, Math.min(range, y - g.grabOffset));
      this.scrollTop =
        range > 0
          ? this.minScroll + (thumbY / range) * this.scrollRange
          : this.minScroll;
      this.showThumb();
      this.dirty = true;
      this.requestDraw();
      e.preventDefault();
      return;
    }

    // Pan: finger up (y decreasing) scrolls content down.
    let dy = g.lastY - y;
    const dt = e.timeStamp - g.lastT;
    // Down past the top, the finger pulls the rows instead, and back up it has
    // to undo that before what's left of the move scrolls them.
    if (this.pullFinger > 0 || (dy < 0 && this.scrollTop <= this.minScroll)) {
      const finger = this.pullFinger - dy;
      this.pull = pullDistance(finger);
      this.pullFinger = fingerForPull(this.pull);
      dy = Math.max(0, -finger);
    }
    this.scrollBy(dy);
    if (dt > 0) {
      const inst = dy / dt;
      // Smooth so a jittery last sample doesn't dominate the fling velocity.
      this.velocity = this.velocity * 0.6 + inst * 0.4;
    }
    g.lastY = y;
    g.lastT = e.timeStamp;
    this.requestDraw();
    e.preventDefault();
  };

  /** A touch has moved: if it has gone far enough to say what it is, it becomes
   * that from here, so nothing jumps by the distance that decided it. */
  private decideTouch(
    g: { id: number; startX: number; startY: number; row: number | undefined },
    x: number,
    y: number,
    t: number,
  ): void {
    const axis = swipeAxis(x - g.startX, y - g.startY);
    if (axis === null) return;
    const direction = x < g.startX ? -1 : 1;
    const label =
      axis === "horizontal" && g.row !== undefined
        ? (this.interaction?.onRowSwipeStart?.(
            g.row,
            direction < 0 ? "left" : "right",
          ) ?? null)
        : null;
    if (label !== null) {
      this.gesture = {
        kind: "swipe",
        id: g.id,
        originX: x,
        direction,
        samples: [],
      };
      this.swipeRow = g.row;
      this.swipeOffset = 0;
      this.swipeLabel = label;
      return;
    }
    this.gesture = { kind: "pan", id: g.id, lastY: y, lastT: t };
    // Rows already pulled (waiting on a refresh, say) are the finger's now.
    this.pullFinger = fingerForPull(this.pull);
  }

  private onPointerUp = (e: PointerEvent): void => {
    // A press that picked its rows up owns the click this release produces.
    if (e.pointerId === this.press.pointerId) {
      if (this.press.up(CanvasGrid.pressPoint(e))) swallowReleaseClick();
    }
    this.endGesture(e, true);
  };

  /** Ends the pointer's gesture, if it has one. `release` says the finger let go
   * rather than being called off, which is what lets a swipe or a pull act. */
  private endGesture(e: PointerEvent, release: boolean): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.id) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    this.gesture = undefined;
    if (g.kind === "swipe") {
      this.endSwipe(g.direction, g.samples, e.timeStamp, release);
      return;
    }
    if (g.kind !== "pan") return;

    if (this.pullFinger > 0) {
      this.pullFinger = 0;
      this.velocity = 0;
      if (release && this.pull >= PULL_TRIGGER) {
        this.interaction?.onPullRefresh?.();
        // The owner has answered by now: a refresh that began is under way.
        this.pullHeld = this.refreshing;
      }
      this.requestDraw();
      return;
    }

    // Fling only on a quick release with real velocity (a held finger stops).
    const idle = e.timeStamp - g.lastT;
    if (
      idle < FLING_RELEASE_TIMEOUT &&
      Math.abs(this.velocity) > MIN_FLING_VELOCITY
    ) {
      this.flinging = true;
      this.lastFrameT = 0;
      this.requestDraw();
    } else {
      this.velocity = 0;
    }
  }

  /** A swipe let go: acts on its row, if it came far enough, and the row goes
   * home either way. A flick can be too short for the browser to count it as
   * having moved, and the click that makes isn't a click on the row. */
  private endSwipe(
    direction: -1 | 1,
    samples: readonly SwipeSample[],
    now: number,
    release: boolean,
  ): void {
    this.requestDraw();
    if (!release) return;
    swallowReleaseClick();
    const velocity = releaseVelocity(samples, now);
    if (
      this.swipeRow !== undefined &&
      rowSwipeCommits(this.swipeOffset, velocity, direction)
    ) {
      this.interaction?.onRowSwipe?.(
        this.swipeRow,
        direction < 0 ? "left" : "right",
      );
    }
  }

  private onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId === this.press.pointerId) this.press.cancel();
    this.endGesture(e, false);
  };

  /** Escape, while the rows are being dragged, puts them down where they were. */
  private onDragKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.press.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    this.press.putDown();
  };

  private hitThumb(x: number, y: number): boolean {
    if (!this.thumb || !this.thumbShown) return false;
    const left = this.vw - SB_MARGIN - SB_WIDTH - SB_GRAB_SLOP;
    return (
      x >= left &&
      x <= this.vw &&
      y >= this.thumb.y - SB_GRAB_SLOP &&
      y <= this.thumb.y + this.thumb.h + SB_GRAB_SLOP
    );
  }

  private onPointerLeave = (): void => {
    this.lastMouseY = undefined;
    this.clearHover();
    if (this.mouseOver) {
      this.mouseOver = false;
      this.holdThumb();
    }
  };

  private clearHover(): void {
    if (this.hoverRow === undefined) return;
    this.hoverRow = undefined;
    this.requestDraw();
  }

  // Clicks come through the native `click`/`dblclick` events (not the pointer
  // gesture handlers) so the browser handles click timing and double-click
  // detection for us; a drag on the scrollbar moves the pointer enough that no
  // click fires. We still guard the scrollbar column so a press there never
  // selects a row.
  private onClick = (e: MouseEvent): void => {
    if (this.frozen) return;
    const p = this.mousePoint(e);
    if (this.overScrollbar(p.x)) return;
    const row = this.rowAt(p.y);
    if (row === undefined) return;
    this.interaction?.onRowClick(row, {
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
    });
  };

  private onDblClick = (e: MouseEvent): void => {
    if (this.frozen) return;
    const p = this.mousePoint(e);
    if (this.overScrollbar(p.x)) return;
    const row = this.rowAt(p.y);
    if (row === undefined) return;
    this.interaction?.onRowDoubleClick(row);
  };

  // A right-click asks the owner for a menu at the pointer, in viewport
  // coordinates. The browser's own menu is always suppressed over the rows —
  // the grid paints no selectable text, so there's nothing it could usefully
  // offer — but only *there*: a right-click past the last row or over the
  // scrollbar falls through untouched. A touch long-press, which the platform
  // turns into a `contextmenu` too, is the press's to decide (`RowPress`): its
  // menu comes with the release, if the rows weren't dropped anywhere.
  private onContextMenu = (e: MouseEvent): void => {
    if (this.frozen || this.press.touching) {
      e.preventDefault();
      return;
    }
    // The keyboard's menu comes with a point on the canvas (where depends on
    // the browser) that says nothing about which row it's for.
    if (this.keyboardMenu) {
      this.keyboardMenu = false;
      e.preventDefault();
      this.interaction?.onKeyboardContextMenu?.();
      return;
    }
    const p = this.mousePoint(e);
    if (this.overScrollbar(p.x)) return;
    const row = this.rowAt(p.y);
    if (row === undefined) return;
    e.preventDefault();
    this.interaction?.onRowContextMenu(row, e.clientX, e.clientY);
  };

  /** Notes the keys that raise a context menu, for the `contextmenu` they go
   * on to produce — on their keydown or their keyup, depending on the
   * platform. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      this.keyboardMenu = true;
    }
  };

  private mousePoint(e: MouseEvent): { x: number; y: number } {
    if (!this.rect) this.rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }

  /** Whether local x falls in the custom scrollbar's grab column (only when a
   * scrollbar is actually shown). */
  private overScrollbar(x: number): boolean {
    if (!this.thumbShown) return false;
    return x >= this.vw - SB_MARGIN - SB_WIDTH - SB_GRAB_SLOP;
  }

  /** Whether there's a thumb to grab: one is drawn, or is on its way in. A
   * touch at the edge of rows whose thumb has faded is on the rows. */
  private get thumbShown(): boolean {
    return (
      this.scrollRange > 0 &&
      (this.thumbAlpha > 0 || this.thumbWanted(performance.now()))
    );
  }

  /** Whether the thumb should be showing, `now`: while the mouse is over the
   * rows, a finger or the thumb scrolls them, a fling carries them on, and for
   * a while after any of that. */
  private thumbWanted(now: number): boolean {
    const kind = this.gesture?.kind;
    return (
      this.mouseOver ||
      kind === "pan" ||
      kind === "scrollbar" ||
      this.flinging ||
      now < this.thumbUntil
    );
  }

  /** The rows scrolled: the thumb shows at full strength at once, rather than
   * fading in behind the scroll it reports, and stays a while. */
  private showThumb(): void {
    this.thumbAlpha = 1;
    this.holdThumb();
  }

  /** Keeps the thumb (whatever it's showing) for {@link SB_HIDE_AFTER_MS}
   * from now, then lets it fade. */
  private holdThumb(): void {
    this.thumbUntil = performance.now() + SB_HIDE_AFTER_MS;
    this.requestDraw();
    if (this.thumbTimer !== undefined) return;
    const wake = () => {
      const left = this.thumbUntil - performance.now();
      if (left > 0) {
        this.thumbTimer = setTimeout(wake, left);
        return;
      }
      this.thumbTimer = undefined;
      this.requestDraw();
    };
    this.thumbTimer = setTimeout(wake, SB_HIDE_AFTER_MS);
  }

  /** One frame of the thumb fading toward where it should be. Returns whether
   * there's more to come. */
  private stepThumbFade(dt: number): boolean {
    if (this.scrollRange <= 0) {
      this.thumbAlpha = 0;
      return false;
    }
    const target = this.thumbWanted(performance.now()) ? 1 : 0;
    if (this.thumbAlpha === target) return false;
    const step = this.reducedMotion?.matches ? 1 : dt / SB_FADE_MS;
    this.thumbAlpha =
      target > this.thumbAlpha
        ? Math.min(target, this.thumbAlpha + step)
        : Math.max(target, this.thumbAlpha - step);
    this.dirty = true;
    return this.thumbAlpha !== target;
  }

  /** The result row under local y (accounting for scroll), or undefined when past
   * the last row or before the first. */
  private rowAt(y: number): number | undefined {
    const layout = this.layout;
    if (!this.result || !layout || this.result.rowCount === 0) return undefined;
    const idx = Math.floor((y + this.viewTop) / layout.rowH);
    return idx >= 0 && idx < this.result.rowCount ? idx : undefined;
  }

  /** Sets the hovered row from local y, repainting only when it changes. */
  private updateHover(y: number): void {
    const row = this.rowAt(y);
    if (row === this.hoverRow) return;
    this.hoverRow = row;
    this.requestDraw();
  }

  private stopFling(): void {
    this.flinging = false;
    this.velocity = 0;
  }

  private stepFling(dt: number): void {
    const hitBound = this.scrollBy(this.velocity * dt);
    // Exponential decay, frame-rate independent.
    this.velocity *= Math.exp(-dt / FLING_TAU);
    if (hitBound || Math.abs(this.velocity) < MIN_FLING_VELOCITY) {
      this.flinging = false;
      this.velocity = 0;
    }
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  private requestDraw(): void {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (t: number): void => {
    this.raf = 0;
    const dt = this.lastFrameT ? Math.min(64, t - this.lastFrameT) : 16;
    this.lastFrameT = t;
    if (this.flinging) this.stepFling(dt);
    const edgeScrolling = this.stepEdgeScroll();
    const settling = this.stepSettle(dt);
    const fading = this.stepThumbFade(dt);
    if (this.dirty) {
      this.draw();
      this.dirty = false;
    }
    if (this.flinging || edgeScrolling || settling || fading) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.lastFrameT = 0;
    }
  };

  /** One frame of whatever no finger has hold of going where it goes: a swiped
   * row home, pulled rows home or to where they wait for a refresh, and the
   * spinner around. Returns whether there's more to come. */
  private stepSettle(dt: number): boolean {
    let moving = false;
    if (this.swipeRow !== undefined && this.gesture?.kind !== "swipe") {
      this.swipeOffset = settle(this.swipeOffset, 0, dt);
      if (this.swipeOffset === 0) this.swipeRow = undefined;
      else moving = true;
      this.dirty = true;
    }
    if (this.gesture?.kind !== "pan" || this.pullFinger === 0) {
      const waits = this.pullHeld && this.scrollTop <= this.minScroll;
      const target = waits ? PULL_HOLD : 0;
      if (this.pull !== target) {
        this.pull = settle(this.pull, target, dt);
        if (this.pull !== target) moving = true;
        this.dirty = true;
      }
    }
    if (this.pullHeld && this.pull > 0) {
      this.pullSpin += dt * PULL_SPINNER_SPEED;
      this.dirty = true;
      moving = true;
    } else if (this.pull === 0) {
      this.pullSpin = 0;
    }
    return moving;
  }

  /** One frame of scrolling under a drag held near the top or bottom edge,
   * while the rows in hand can drop among these rows. A scroll moves the rows
   * under the pointer, so the owner hears the pointer "move" to where it now
   * is. Returns whether to keep watching, which is for as long as the drag
   * lasts. */
  private stepEdgeScroll(): boolean {
    const p = this.dragPoint;
    if (!p || !this.press.dragging || this.dropGap === undefined) return false;
    if (!this.rect) this.rect = this.canvas.getBoundingClientRect();
    const { left, right, top, bottom } = this.rect;
    if (p.x < left || p.x > right) return true;
    const dy = edgeScrollDelta(p.y, top, bottom);
    if (dy === 0 || this.scrollRange <= 0) return true;
    const before = this.scrollTop;
    this.scrollBy(dy);
    if (this.scrollTop !== before) this.interaction?.onRowDragMove?.(p.x, p.y);
    return true;
  }

  // ── Painting ────────────────────────────────────────────────────────────────

  private draw(): void {
    const ctx = this.ctx;
    const { vw, vh } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Alphabetic baseline (the default) so we can snap the true baseline to the
    // device grid for crisp glyphs; vertical centering is done via font metrics
    // in `centeredBaseline`. (`"middle"` would offset the baseline by a constant
    // fraction of a pixel, leaving text soft even when the center is snapped.)
    ctx.textBaseline = "alphabetic";

    ctx.fillStyle = this.theme.panel;
    ctx.fillRect(0, 0, vw, vh);
    if (this.pull > 0) this.drawPullSpinner();

    const result = this.result;
    const layout = this.layout;
    if (!result || !layout || result.rowCount === 0) {
      this.canvas.dataset.thumb = "none";
      this.drawEmpty();
      return;
    }

    this.layoutScrollbar();

    const { rowH } = layout;
    const top = this.viewTop;
    const first = Math.max(0, Math.floor(top / rowH));
    const last = Math.min(result.rowCount - 1, Math.floor((top + vh) / rowH));

    for (let r = first; r <= last; r++) {
      const screenY = r * rowH - top;
      const slide = this.rowSlide(r);
      if (slide !== 0) {
        this.drawSwipeBand(screenY, rowH, slide);
        ctx.save();
        ctx.translate(slide, 0);
      }
      this.drawRowBackground(
        screenY,
        rowH,
        this.selection.has(r),
        this.hoverRow === r,
        this.currentRow === r,
      );
      for (let k = 0; k < result.visible.length; k++) {
        this.drawCell(r, k, screenY);
      }
      const queued = this.queuedRows.get(r);
      if (this.currentRow === r) this.drawCurrentMarker(screenY, rowH, false);
      else if (queued !== undefined) {
        this.drawCurrentMarker(screenY, rowH, true);
      }
      // Over the ring, whose left edge it straddles: unsaved changes are the
      // more urgent of the two to notice.
      if (this.modifiedRows.has(r)) this.drawModifiedMarker(screenY, rowH);
      if (queued != null) this.drawQueueBadge(screenY, queued, r === 0);
      if (slide !== 0) ctx.restore();
    }
    if (typeof this.dropGap === "number") {
      this.drawDropLine(this.dropGap * rowH - top);
    }

    this.drawScrollbar();
    // Readiness signal for tests: the grid has painted a non-empty result. (Row
    // text lives in canvas pixels, not the DOM, so there's nothing to query.)
    this.canvas.dataset.rows = String(result.rowCount);
  }

  /** How far (px, device-snapped) row `r` is drawn from its place: a swipe takes
   * its row, and when that row is part of the selection, all of it, since that's
   * what the swipe will act on. */
  private rowSlide(r: number): number {
    const row = this.swipeRow;
    if (row === undefined) return 0;
    const moves =
      r === row || (this.selection.has(row) && this.selection.has(r));
    return moves ? this.snap(this.swipeOffset) : 0;
  }

  /** What a swiped row uncovers, in the `|slide|` px it has left bare at the
   * edge it moved away from: the accent, and the action's name, coming in as
   * the row nears the distance that commits it. */
  private drawSwipeBand(screenY: number, rowH: number, slide: number): void {
    const ctx = this.ctx;
    const width = Math.abs(slide);
    const leftward = slide < 0;
    const left = leftward ? this.vw + slide : 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, screenY, width, rowH);
    ctx.clip();
    ctx.fillStyle = this.theme.accent;
    ctx.fillRect(left, screenY, width, rowH);
    ctx.globalAlpha = Math.min(1, width / ROW_SWIPE_DISTANCE);
    ctx.fillStyle = this.theme.panel;
    ctx.font = `${BODY_FONT}px ${this.fontFamily}`;
    ctx.textAlign = leftward ? "right" : "left";
    ctx.fillText(
      this.swipeLabel,
      this.snap(leftward ? this.vw - SWIPE_LABEL_INSET : SWIPE_LABEL_INSET),
      this.centeredBaseline(screenY + rowH / 2),
    );
    ctx.restore();
  }

  /** The spinner, centered in the gap a pull opens above the first row. Strong
   * once letting go would refresh, or a refresh is under way. */
  private drawPullSpinner(): void {
    const ctx = this.ctx;
    const armed = this.pullHeld || this.pull >= PULL_TRIGGER;
    const reach = armed ? 1 : this.pull / PULL_TRIGGER;
    const start = this.pullSpin - Math.PI / 2;
    ctx.save();
    ctx.strokeStyle = armed ? this.theme.ink : this.theme.inkWeak;
    ctx.lineWidth = PULL_SPINNER_W;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(
      this.vw / 2,
      this.topInset + this.pull / 2,
      PULL_SPINNER_RADIUS,
      start,
      start + reach * PULL_SPINNER_SWEEP,
    );
    ctx.stroke();
    ctx.restore();
  }

  private drawEmpty(): void {
    if (!this.result) {
      this.thumb = undefined;
      return;
    }
    const ctx = this.ctx;
    ctx.fillStyle = this.theme.inkWeak;
    ctx.font = `14px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText(
      "No results",
      this.snap(this.vw / 2),
      this.centeredBaseline(this.vh / 2),
    );
    this.thumb = undefined;
  }

  private drawRowBackground(
    screenY: number,
    rowH: number,
    selected: boolean,
    hovered: boolean,
    current: boolean,
  ): void {
    const ctx = this.ctx;
    const t = this.theme;
    // Hover shifts the gradient endpoints toward the foreground (and, on a
    // selected row, deepens the flat fill) — see results.rs `draw_row`.
    const top = hovered ? t.rowTopHover : t.rowTop;
    const bottom = hovered ? t.rowBottomHover : t.rowBottom;
    if (selected) {
      // A flat blue fill marks the selection; the same top-lit sheen every row
      // gets is then layered over it at reduced opacity so the blue reads through.
      ctx.fillStyle = hovered ? t.selectedBgHover : t.selectedBg;
      ctx.fillRect(0, screenY, this.vw, rowH);
      ctx.save();
      ctx.globalAlpha = SELECTED_SHEEN_ALPHA;
      ctx.fillStyle = this.rowGradient(screenY, rowH, top, bottom);
      ctx.fillRect(0, screenY, this.vw, rowH);
      ctx.restore();
    } else {
      ctx.fillStyle = this.rowGradient(screenY, rowH, top, bottom);
      ctx.fillRect(0, screenY, this.vw, rowH);
    }
    // The playing row also takes a faint blue wash, skipped on a selected row
    // whose own fill already carries the color. (Its ring is drawn over the
    // cells, in `drawCurrentMarker`.)
    if (current && !selected) {
      ctx.fillStyle = t.currentWash;
      ctx.fillRect(0, screenY, this.vw, rowH);
    }
    // Softened hairline separator along the bottom edge. Snap to the device grid
    // so the 1px line stays a crisp single pixel instead of a blurred 2px smear.
    ctx.fillStyle = t.rowSep;
    ctx.fillRect(0, this.snap(screenY + rowH - 1), this.vw, this.snap(1));
  }

  /** The playing row's marker: a rounded blue rectangle around the row. Drawn
   * after the row's cells (and after the separator the background lays down, so
   * no hairline crosses it), with the stroke's center placed half a line-width
   * inside the inset edge, which keeps the 2px band on whole device pixels. It
   * spans the full row width whether or not a scrollbar is showing, so the ring
   * never shifts inward over the cells. Where the thumb crosses it the ring
   * isn't painted at all, which is what puts the scrollbar visually on top: the
   * thumb is translucent, so a ring merely drawn under it would tint it blue
   * and read as the nearer of the two. */
  private drawCurrentMarker(
    screenY: number,
    rowH: number,
    dashed: boolean,
  ): void {
    const ctx = this.ctx;
    const off = CURRENT_MARKER_INSET + CURRENT_MARKER_W / 2;
    const w = this.vw - 2 * off;
    const h = rowH - 2 * off;
    if (w <= 0 || h <= 0) return;
    const ring = () => {
      roundRectPath(
        ctx,
        this.snap(off),
        this.snap(screenY + off),
        w,
        h,
        CURRENT_MARKER_RADIUS,
      );
      ctx.stroke();
    };
    ctx.save();
    ctx.strokeStyle = this.theme.currentMarker;
    ctx.lineWidth = CURRENT_MARKER_W;
    if (dashed) ctx.setLineDash(QUEUED_MARKER_DASH);
    ctx.save();
    this.clipThumb("out");
    ring();
    ctx.restore();
    // Behind a thumb that's faded (or fading), the ring shows through as much
    // as the thumb doesn't.
    if (this.thumb && this.thumbAlpha < 1) {
      this.clipThumb("in");
      ctx.globalAlpha = 1 - this.thumbAlpha;
      ring();
    }
    ctx.restore();
  }

  /** A queued row's place in the queue: a pill in the playing-row blue,
   * straddling its ring's top edge at the left, so it reads as a tag on the
   * ring rather than as part of the row's first cell. The `first` row's has
   * nothing above it to straddle, so it sits just inside instead, where the
   * top of the rows can't cut it off. */
  private drawQueueBadge(
    screenY: number,
    position: number,
    first: boolean,
  ): void {
    const ctx = this.ctx;
    const text = String(position);
    ctx.save();
    ctx.font = `600 ${QUEUE_BADGE_FONT}px ${this.fontFamily}`;
    const w = Math.max(
      QUEUE_BADGE_H,
      ctx.measureText(text).width + 2 * QUEUE_BADGE_PAD_X,
    );
    const ring = screenY + CURRENT_MARKER_INSET + CURRENT_MARKER_W / 2;
    const top = this.snap(first ? ring : ring - QUEUE_BADGE_H / 2);
    const left = this.snap(QUEUE_BADGE_X);
    ctx.fillStyle = this.theme.currentMarker;
    roundRectPath(ctx, left, top, w, QUEUE_BADGE_H, QUEUE_BADGE_H / 2);
    ctx.fill();
    ctx.fillStyle = this.theme.panel;
    ctx.textAlign = "center";
    ctx.fillText(
      text,
      this.snap(left + w / 2),
      this.centeredBaseline(top + QUEUE_BADGE_H / 2),
    );
    ctx.restore();
  }

  /** The drop line, centered on the row boundary at `screenY`, and kept just
   * inside the canvas at its top and bottom so a line above the first row (or
   * below the last) still shows whole. */
  private drawDropLine(screenY: number): void {
    const w = this.vw - 2 * DROP_LINE_INSET;
    if (w <= 0) return;
    const half = DROP_LINE_H / 2;
    const y = Math.max(half, Math.min(this.vh - half, screenY));
    const ctx = this.ctx;
    ctx.fillStyle = this.theme.accent;
    roundRectPath(
      ctx,
      this.snap(DROP_LINE_INSET),
      this.snap(y - half),
      w,
      DROP_LINE_H,
      half,
    );
    ctx.fill();
  }

  /** Cuts the thumb's box out of the clip region (`"out"`), so what follows
   * paints everywhere but behind the scrollbar — or clips to just that box
   * (`"in"`). The box is the thumb's *bounding* box, not its rounded pill:
   * squaring it off keeps stray slivers of the clipped artwork out of the
   * notches beside the thumb's round ends. Its edges are snapped outward to
   * whole device pixels so no fraction of a pixel survives along them. Call
   * inside a `save()`/`restore()` pair. */
  private clipThumb(mode: "out" | "in"): void {
    const thumb = this.thumb;
    if (!thumb) return;
    const ctx = this.ctx;
    const out = (v: number, dir: -1 | 1): number =>
      (dir < 0 ? Math.floor(v * this.dpr) : Math.ceil(v * this.dpr)) / this.dpr;
    ctx.beginPath();
    if (mode === "out") ctx.rect(0, 0, this.vw, this.vh);
    ctx.rect(
      this.vw - SB_MARGIN - SB_WIDTH,
      out(thumb.y, -1),
      SB_WIDTH,
      out(thumb.y + thumb.h, 1) - out(thumb.y, -1),
    );
    ctx.clip("evenodd");
  }

  /** The unsaved-changes ✱ for one row: the record editor is holding edits to
   * the record this row stands for, whether or not its form is open. Drawn in
   * the row's left padding, where no cell text reaches. */
  private drawModifiedMarker(screenY: number, rowH: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = this.theme.danger;
    ctx.font = `${MODIFIED_MARKER_FONT}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.fillText(
      MODIFIED_MARKER,
      this.snap(TEXT_PAD_X / 2),
      this.centeredBaseline(screenY + rowH / 2),
    );
    ctx.restore();
  }

  /** A vertical `top`→`bottom` gradient spanning one row. */
  private rowGradient(
    screenY: number,
    rowH: number,
    top: string,
    bottom: string,
  ): CanvasGradient {
    const g = this.ctx.createLinearGradient(0, screenY, 0, screenY + rowH);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  }

  private drawCell(r: number, k: number, screenY: number): void {
    const result = this.result!;
    const col = result.visible[k];
    const layout = this.layout!;
    const p = layout.placements[k];
    const cellX = TEXT_PAD_X + p.x;
    const cellW = p.width;
    if (cellW <= 0) return;
    const lineH = layout.lineHeights[p.line];
    const cellY = screenY + ROW_PAD_Y + layout.lineTops[p.line];

    const fontSize = fontSizeOf(col.meta.font_size);
    const color =
      col.meta.font_color === "light" ? this.theme.inkWeak : this.theme.ink;
    const ctx = this.ctx;
    ctx.font = `${fontSize}px ${this.fontFamily}`;

    ctx.save();
    ctx.beginPath();
    ctx.rect(cellX, cellY, cellW, lineH);
    ctx.clip();

    if (col.isList) {
      this.drawPills(
        result.pills(r, col),
        cellX,
        cellY,
        cellW,
        lineH,
        fontSize,
        color,
        col.meta.text_align,
      );
    } else {
      this.drawText(
        result.text(r, col),
        cellX,
        cellY,
        cellW,
        lineH,
        color,
        col.meta.text_align,
      );
    }

    ctx.restore();
  }

  private drawText(
    text: string,
    cellX: number,
    cellY: number,
    cellW: number,
    lineH: number,
    color: string,
    align: "left" | "right" | "center",
  ): void {
    if (!text) return;
    const ctx = this.ctx;
    ctx.fillStyle = color;
    // Snap the baseline and the horizontal anchor to whole device pixels so the
    // glyphs render crisply (see `snap`). The anchor is snapped *after* the align
    // math so the rounded edge is the one text actually grows from.
    const cy = this.centeredBaseline(cellY + lineH / 2);
    const fitted = this.fitText(text, cellW);
    if (align === "right") {
      ctx.textAlign = "right";
      ctx.fillText(fitted, this.snap(cellX + cellW), cy);
    } else if (align === "center") {
      ctx.textAlign = "center";
      ctx.fillText(fitted, this.snap(cellX + cellW / 2), cy);
    } else {
      ctx.textAlign = "left";
      ctx.fillText(fitted, this.snap(cellX), cy);
    }
  }

  private drawPills(
    items: readonly string[],
    cellX: number,
    cellY: number,
    cellW: number,
    lineH: number,
    fontSize: number,
    color: string,
    align: "left" | "right" | "center",
  ): void {
    if (items.length === 0) return;
    const ctx = this.ctx;
    const pillH = fontSize * PILL_LINE_HEIGHT + PILL_PAD_Y * 2;
    const pillY = cellY + (lineH - pillH) / 2;

    const widths = items.map(
      (it) => ctx.measureText(it).width + PILL_PAD_X * 2,
    );
    const total =
      widths.reduce((a, b) => a + b, 0) +
      PILL_GAP * Math.max(0, items.length - 1);
    let x =
      align === "right"
        ? cellX + cellW - total
        : align === "center"
          ? cellX + (cellW - total) / 2
          : cellX;

    ctx.textAlign = "left";
    const snappedPillY = this.snap(pillY);
    const textCy = this.centeredBaseline(pillY + pillH / 2);
    for (let i = 0; i < items.length; i++) {
      const w = widths[i];
      // Snap the pill's left edge and its label anchor to the device grid so both
      // the rounded rect and the text inside stay crisp (see `snap`).
      const px = this.snap(x);
      ctx.fillStyle = this.theme.pillBg;
      roundRectPath(ctx, px, snappedPillY, w, pillH, PILL_RADIUS);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(items[i], this.snap(px + PILL_PAD_X), textCy);
      x += w + PILL_GAP;
      if (x > cellX + cellW) break; // rest is clipped anyway
    }
  }

  /** Places the thumb for this frame (and clears it when there's nothing to
   * scroll). Runs before the rows are drawn, because the playing row's ring has
   * to know where the thumb will land to leave its box unpainted. */
  private layoutScrollbar(): void {
    if (this.scrollRange <= 0) {
      this.thumb = undefined;
      return;
    }
    const vh = this.vh;
    // The thumb is sized against everything the view can be scrolled over —
    // the rows *plus* whatever space an overlay reserved above them — so it
    // still spans the whole travel when the only thing to scroll is the inset.
    const span = vh + this.scrollRange;
    const h = Math.max(SB_MIN_THUMB, (vh * vh) / span);
    const y = ((this.scrollTop - this.minScroll) / this.scrollRange) * (vh - h);
    this.thumb = { y, h };
  }

  private drawScrollbar(): void {
    // For tests: whether the thumb is there to see, which they can't read
    // from the pixels.
    const state = !this.thumb
      ? "none"
      : this.thumbAlpha >= 1
        ? "shown"
        : this.thumbAlpha <= 0
          ? "hidden"
          : "fading";
    if (this.canvas.dataset.thumb !== state) this.canvas.dataset.thumb = state;
    if (!this.thumb || this.thumbAlpha <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = this.thumbAlpha;
    ctx.fillStyle = this.theme.scrollThumb;
    roundRectPath(
      ctx,
      this.vw - SB_MARGIN - SB_WIDTH,
      this.thumb.y,
      SB_WIDTH,
      this.thumb.h,
      SB_WIDTH / 2,
    );
    ctx.fill();
    ctx.restore();
  }

  /** Truncates `text` with an ellipsis so it fits within `maxWidth`. Assumes the
   * caller has already set `ctx.font`. */
  private fitText(text: string, maxWidth: number): string {
    const ctx = this.ctx;
    if (maxWidth <= 0) return "";
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ell = "…";
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + ell).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo === 0 ? ell : text.slice(0, lo) + ell;
  }

  /** The grid's colors, from app.css's tokens. A token's own text can be
   * `light-dark(…)`, which only resolves where it's used — and canvas can't
   * parse it — so each one is set as the color of a hidden probe beside the
   * canvas (inheriting the canvas's `color-scheme`) and read back from its
   * computed `color`, which is always a plain `rgb(…)`. */
  private readTheme(): Theme {
    const cs = getComputedStyle(this.canvas);
    const probe = document.createElement("span");
    probe.hidden = true;
    (this.canvas.parentElement ?? document.body).append(probe);
    const resolved = getComputedStyle(probe);
    const v = (name: string, fallback: string): string => {
      if (cs.getPropertyValue(name).trim() === "") return fallback;
      probe.style.color = `var(${name})`;
      return resolved.color;
    };
    const family = cs.fontFamily.trim();
    if (family) this.fontFamily = family;
    const theme: Theme = {
      panel: v("--panel", "#f8f8f8"),
      rowTop: v("--row-bg-top", "#ffffff"),
      rowBottom: v("--row-bg-bottom", "#f2f2f2"),
      rowTopHover: v("--row-bg-top-hover", "#f5f5f5"),
      rowBottomHover: v("--row-bg-bottom-hover", "#e8e8e8"),
      rowSep: v("--row-sep", "rgb(200 200 200 / 0.5)"),
      pillBg: v("--pill-bg", "#efddff"),
      selectedBg: v("--row-selected", "#c8e4ff"),
      selectedBgHover: v("--row-selected-hover", "#b4d0eb"),
      ink: v("--ink", "#1b1b1b"),
      inkWeak: v("--ink-weak", "#5a5a5a"),
      currentMarker: v("--now-playing", "rgb(46 124 246)"),
      currentWash: v("--row-current", "rgb(46 124 246 / 0.063)"),
      danger: v("--danger", "#c0392b"),
      accent: v("--accent", "rgb(46 124 246)"),
      // No CSS token for the thumb; a mid-gray reads on both themes.
      scrollThumb: "rgba(130, 130, 130, 0.55)",
    };
    probe.remove();
    return theme;
  }
}
