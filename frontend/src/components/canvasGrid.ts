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
// Row interaction is hit-tested against the same windowed geometry: pointer moves
// track a hovered row (repainted with a subtly shifted background), clicks report
// a `(row, modifiers)` selection intent to the owner, right-clicks report a
// context-menu request, and double-clicks report a row activation. The selection
// itself lives outside the engine (the query page's per-tab state) and is pushed
// back in via `setSelection` for painting — the grid renders selection, it
// doesn't own it.
//
// The owner can also freeze the grid (`setFrozen`) while a menu it opened is up:
// scrolling, hovering and clicking all stop, so the rows under an open context
// menu hold still. The DOM overlay above the canvas already swallows the events
// that reach it; freezing covers what it can't (a wheel over the menu itself, a
// pointer that was mid-gesture when the menu opened).

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

/** Width of the accent bar down the left edge of the playing row, wide enough
 * that the marker reads at a glance on a dense grid. */
const CURRENT_MARKER_W = 5;

/** The glyph marking a row whose record has unsaved edits in the record editor,
 * drawn large enough to read at a glance over the row's left padding. */
const MODIFIED_MARKER = "✱";
const MODIFIED_MARKER_FONT = 18;

/** Opacity of the top-lit sheen gradient layered over a selected row's flat fill,
 * so the sheen reads without hiding the selection color (SELECTED_ROW_GRADIENT_
 * ALPHA = 90/255 in results.rs). */
const SELECTED_SHEEN_ALPHA = 90 / 255;

// Scrollbar (custom overlay, macOS-style).
const SB_WIDTH = 8;
const SB_MARGIN = 2;
const SB_MIN_THUMB = 24;
/** Extra horizontal slop around the thumb for an easier grab (logical px). */
const SB_GRAB_SLOP = 8;

// Touch inertia.
/** Velocity below which the fling stops (logical px per ms). */
const MIN_FLING_VELOCITY = 0.015;
/** Exponential decay time constant of the fling (ms). Larger = longer glide. */
const FLING_TAU = 325;
/** A pause longer than this before release cancels the fling (finger held). */
const FLING_RELEASE_TIMEOUT = 80;

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
  /** The playing row's left edge marker, and the translucent wash over the rest
   * of that row. */
  currentMarker: string;
  currentWash: string;
  /** The unsaved-changes ✱, in the same red as everywhere else. */
  danger: string;
}

/** Callbacks the owner wires up to react to row interaction. */
export interface GridInteraction {
  /** A row was clicked, with the click's range/toggle modifiers. */
  onRowClick: (index: number, mods: { shift: boolean; ctrl: boolean }) => void;
  /** A row was double-clicked (row activation, e.g. play the track). */
  onRowDoubleClick: (index: number) => void;
  /** A row was right-clicked (or long-pressed into a `contextmenu`), at the
   * given viewport coordinates — where the owner anchors its DOM menu. */
  onRowContextMenu: (index: number, x: number, y: number) => void;
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

  // Row interaction: the selection (owned outside, pushed in for painting), the
  // currently-hovered row, the last mouse Y (to re-derive hover after a scroll),
  // and the owner's interaction callbacks.
  private selection: ReadonlySet<number> = new Set();
  /** The row holding the now-playing track, when it's in this result set. */
  private currentRow: number | undefined;
  /** Rows whose record has unsaved changes in the record editor. */
  private modifiedRows: ReadonlySet<number> = new Set();
  private hoverRow: number | undefined;
  private lastMouseY: number | undefined;
  private interaction: GridInteraction | undefined;
  /** While true the grid ignores every input (see `setFrozen`). */
  private frozen = false;

  // Frame scheduling: one rAF coalesces draws; the same loop steps the fling.
  private raf = 0;
  private dirty = false;
  private flinging = false;
  private velocity = 0; // logical px per ms
  private lastFrameT = 0;

  // Active pointer gesture (touch pan or scrollbar drag).
  private gesture:
    | { kind: "pan"; id: number; lastY: number; lastT: number }
    | { kind: "scrollbar"; id: number; grabOffset: number }
    | undefined;
  private rect: DOMRect | undefined;

  // Last-drawn thumb geometry, for pointer hit-testing.
  private thumb: { y: number; h: number } | undefined;

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
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("click", this.onClick);
    canvas.addEventListener("dblclick", this.onDblClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);

    // Re-paint once web fonts finish loading so text metrics (and thus ellipsis
    // truncation and pill widths) are measured against the real font.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        this.metrics.clear(); // real font may differ from the fallback metrics
        this.requestDraw();
      });
    }

    this.resize();
  }

  destroy(): void {
    const c = this.canvas;
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("click", this.onClick);
    c.removeEventListener("dblclick", this.onDblClick);
    c.removeEventListener("contextmenu", this.onContextMenu);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Swaps in a new result (or clears): resets the scroll position, recomputes
   * the layout, and repaints. Called when the tab's result changes. */
  setResult(result: QueryResult | undefined): void {
    this.result = result;
    this.scrollTop = 0;
    this.flinging = false;
    this.velocity = 0;
    this.hoverRow = undefined;
    this.relayout();
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
   * in-flight gesture or fling, so nothing keeps moving underneath the menu. */
  setFrozen(frozen: boolean): void {
    if (frozen === this.frozen) return;
    this.frozen = frozen;
    if (!frozen) return;
    this.stopFling();
    this.gesture = undefined;
    this.lastMouseY = undefined;
    if (this.hoverRow !== undefined) {
      this.hoverRow = undefined;
      this.requestDraw();
    }
  }

  /** Pushes in the owner's current row selection for painting. Cheap to call on
   * every selection change — repaints only when the set actually differs. */
  setSelection(selection: ReadonlySet<number>): void {
    if (selection === this.selection) return;
    this.selection = selection;
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
   * isn't in this result set), painted with an accent edge and a faint wash. */
  setCurrentRow(row: number | undefined): void {
    if (row === this.currentRow) return;
    this.currentRow = row;
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
    if (top < this.scrollTop) this.scrollTop = top;
    else if (bottom > this.scrollTop + this.vh)
      this.scrollTop = bottom - this.vh;
    else return;
    this.stopFling();
    this.clampScroll();
    if (this.lastMouseY !== undefined) this.updateHover(this.lastMouseY);
    this.requestDraw();
  }

  /** Re-reads theme colors + font family from CSS and repaints (theme toggle). */
  refreshTheme(): void {
    this.theme = this.readTheme();
    this.metrics.clear(); // font family is re-read in readTheme and may change
    this.requestDraw();
  }

  private get totalHeight(): number {
    if (!this.result || !this.layout) return 0;
    return this.result.rowCount * this.layout.rowH;
  }

  private get maxScroll(): number {
    return Math.max(0, this.totalHeight - this.vh);
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
    if (this.scrollTop < 0) this.scrollTop = 0;
    else if (this.scrollTop > max) this.scrollTop = max;
  }

  /** Applies a scroll delta, clamping to bounds. Returns whether it hit a bound
   * (used to end a fling that runs off the top/bottom). */
  private scrollBy(dy: number): boolean {
    const before = this.scrollTop;
    this.scrollTop = before + dy;
    this.clampScroll();
    this.dirty = true;
    return this.scrollTop === 0 || this.scrollTop === this.maxScroll;
  }

  private onWheel = (e: WheelEvent): void => {
    if (this.frozen || this.maxScroll <= 0) return;
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

  // ── Pointer gestures: touch pan (+ fling) and scrollbar-thumb drag ──────────

  private localPoint(e: PointerEvent): { x: number; y: number } {
    if (!this.rect) this.rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.frozen || this.gesture || this.maxScroll <= 0) return;
    const { x, y } = this.localPoint(e);

    // A press on the scrollbar thumb starts a thumb drag (any pointer type).
    if (this.thumb && this.hitThumb(x, y)) {
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

    // Touch anywhere else pans the content (mouse drag on content does nothing —
    // mouse scrolls via wheel or the scrollbar, per the interaction spec).
    if (e.pointerType === "touch") {
      this.stopFling();
      this.gesture = {
        kind: "pan",
        id: e.pointerId,
        lastY: y,
        lastT: e.timeStamp,
      };
      this.velocity = 0;
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.frozen) return;
    const g = this.gesture;
    // Not mid-gesture: a mouse move only updates the hovered row. (Touch has no
    // hover; a pan is handled below once its gesture is active.)
    if (!g) {
      if (e.pointerType === "mouse") {
        const { y } = this.localPoint(e);
        this.lastMouseY = y;
        this.updateHover(y);
      }
      return;
    }
    if (e.pointerId !== g.id) return;
    const { y } = this.localPoint(e);

    if (g.kind === "scrollbar") {
      const range = this.vh - (this.thumb?.h ?? 0);
      const thumbY = Math.max(0, Math.min(range, y - g.grabOffset));
      this.scrollTop = range > 0 ? (thumbY / range) * this.maxScroll : 0;
      this.dirty = true;
      this.requestDraw();
      e.preventDefault();
      return;
    }

    // Pan: finger up (y decreasing) scrolls content down.
    const dy = g.lastY - y;
    const dt = e.timeStamp - g.lastT;
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

  private onPointerUp = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.id) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    this.gesture = undefined;
    if (g.kind !== "pan") return;

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
  };

  private hitThumb(x: number, y: number): boolean {
    if (!this.thumb) return false;
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
    if (this.hoverRow !== undefined) {
      this.hoverRow = undefined;
      this.requestDraw();
    }
  };

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

  // A right-click (or the touch long-press the platform turns into one) asks the
  // owner for a menu at the pointer, in viewport coordinates. The browser's own
  // menu is always suppressed over the rows — the grid paints no selectable
  // text, so there's nothing it could usefully offer — but only *there*: a
  // right-click past the last row or over the scrollbar falls through untouched.
  private onContextMenu = (e: MouseEvent): void => {
    if (this.frozen) {
      e.preventDefault();
      return;
    }
    const p = this.mousePoint(e);
    if (this.overScrollbar(p.x)) return;
    const row = this.rowAt(p.y);
    if (row === undefined) return;
    e.preventDefault();
    this.interaction?.onRowContextMenu(row, e.clientX, e.clientY);
  };

  private mousePoint(e: MouseEvent): { x: number; y: number } {
    if (!this.rect) this.rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }

  /** Whether local x falls in the custom scrollbar's grab column (only when a
   * scrollbar is actually shown). */
  private overScrollbar(x: number): boolean {
    if (this.maxScroll <= 0) return false;
    return x >= this.vw - SB_MARGIN - SB_WIDTH - SB_GRAB_SLOP;
  }

  /** The result row under local y (accounting for scroll), or undefined when past
   * the last row or before the first. */
  private rowAt(y: number): number | undefined {
    const layout = this.layout;
    if (!this.result || !layout || this.result.rowCount === 0) return undefined;
    const idx = Math.floor((y + this.scrollTop) / layout.rowH);
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
    if (this.flinging) {
      const dt = this.lastFrameT ? Math.min(64, t - this.lastFrameT) : 16;
      this.lastFrameT = t;
      this.stepFling(dt);
    }
    if (this.dirty) {
      this.draw();
      this.dirty = false;
    }
    if (this.flinging) this.raf = requestAnimationFrame(this.frame);
  };

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

    const result = this.result;
    const layout = this.layout;
    if (!result || !layout || result.rowCount === 0) {
      this.drawEmpty();
      return;
    }

    const { rowH } = layout;
    const first = Math.max(0, Math.floor(this.scrollTop / rowH));
    const last = Math.min(
      result.rowCount - 1,
      Math.floor((this.scrollTop + vh) / rowH),
    );

    for (let r = first; r <= last; r++) {
      const screenY = r * rowH - this.scrollTop;
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
      if (this.modifiedRows.has(r)) this.drawModifiedMarker(screenY, rowH);
    }

    this.drawScrollbar();
    // Readiness signal for tests: the grid has painted a non-empty result. (Row
    // text lives in canvas pixels, not the DOM, so there's nothing to query.)
    this.canvas.dataset.rows = String(result.rowCount);
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
    if (current) {
      // The playing row: a faint blue wash (skipped on a selected row, whose own
      // fill already carries the color) plus an accent bar down the left edge.
      if (!selected) {
        ctx.fillStyle = t.currentWash;
        ctx.fillRect(0, screenY, this.vw, rowH);
      }
      ctx.fillStyle = t.currentMarker;
      ctx.fillRect(0, screenY, CURRENT_MARKER_W, rowH);
    }
    // Softened hairline separator along the bottom edge. Snap to the device grid
    // so the 1px line stays a crisp single pixel instead of a blurred 2px smear.
    ctx.fillStyle = t.rowSep;
    ctx.fillRect(0, this.snap(screenY + rowH - 1), this.vw, this.snap(1));
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

  private drawScrollbar(): void {
    if (this.maxScroll <= 0) {
      this.thumb = undefined;
      return;
    }
    const { vw, vh } = this;
    const thumbH = Math.max(SB_MIN_THUMB, (vh * vh) / this.totalHeight);
    const thumbY = (this.scrollTop / this.maxScroll) * (vh - thumbH);
    this.thumb = { y: thumbY, h: thumbH };

    const ctx = this.ctx;
    ctx.fillStyle = this.theme.scrollThumb;
    roundRectPath(
      ctx,
      vw - SB_MARGIN - SB_WIDTH,
      thumbY,
      SB_WIDTH,
      thumbH,
      SB_WIDTH / 2,
    );
    ctx.fill();
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

  private readTheme(): Theme {
    const cs = getComputedStyle(this.canvas);
    const v = (name: string, fallback: string): string => {
      const raw = cs.getPropertyValue(name).trim();
      return raw || fallback;
    };
    const family = cs.fontFamily.trim();
    if (family) this.fontFamily = family;
    return {
      panel: v("--panel", "#f8f8f8"),
      rowTop: v("--row-bg-top", "#ffffff"),
      rowBottom: v("--row-bg-bottom", "#f2f2f2"),
      rowTopHover: v("--row-bg-top-hover", "#f5f5f5"),
      rowBottomHover: v("--row-bg-bottom-hover", "#e8e8e8"),
      rowSep: v("--row-sep", "rgb(200 200 200 / 0.5)"),
      pillBg: v("--pill-bg", "#f8e4b2"),
      selectedBg: v("--row-selected", "#c8e4ff"),
      selectedBgHover: v("--row-selected-hover", "#b4d0eb"),
      ink: v("--ink", "#1b1b1b"),
      inkWeak: v("--ink-weak", "#5a5a5a"),
      currentMarker: v("--accent-soft", "#bcd0ea"),
      currentWash: v("--row-current", "rgb(46 124 246 / 0.063)"),
      danger: v("--danger", "#c0392b"),
      // No CSS token for the thumb; a mid-gray reads on both themes.
      scrollThumb: "rgba(130, 130, 130, 0.55)",
    };
  }
}
