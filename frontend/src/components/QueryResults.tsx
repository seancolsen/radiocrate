import { createEffect, onCleanup, onMount } from "solid-js";
import { unwrap } from "solid-js/store";
import { useAppState } from "../state/store";
import {
  colSizesOf,
  type QueryResult,
  type ResultColumn,
} from "../query/result";
import { createLayoutMemo } from "../query/fieldLayout";

// The columnar results grid, rendered as raw DOM (phase 04). Every row is a real
// DOM node — no virtual scroll, no canvas — with off-screen rows skipped via
// `content-visibility` (see app.css). Cells are absolutely positioned from the
// memoized field layout, delivered through CSS custom properties on the grid
// container (see below), so a resize repositions all cells by rewriting a handful
// of vars rather than touching any node.
//
// Rows are built IMPERATIVELY (innerHTML), NOT with <For>/<Index>: the result set
// is an immutable snapshot, so paying Solid's fine-grained reactivity per row
// (×10k) would be pure waste. Solid reactivity is reserved for the container.

// Geometry constants — logical px == CSS px, copied verbatim from `results.rs`.
const ROW_PAD_Y = 6;
const TEXT_PAD_X = 8;
const COL_GAP = 16;
/** Extra height a line gains when it holds a pill column (`PILL_LINE_EXTRA`). */
const PILL_LINE_EXTRA = 6;

// Per-line content heights fed into the layout, and the matching CSS font sizes.
// Hardcoded (not measured per frame) so the layout stays deterministic and the
// memo effective; tuned against `whole_app.png` (PPP = 2). `results.rs` uses
// egui's Body/Small `text_style_height`.
const BODY_LINE_H = 18;
const SMALL_LINE_H = 15;
const BODY_FONT = 14;
const SMALL_FONT = 11;

/** Escapes a cell string for safe interpolation into the rows HTML. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;",
  );
}

function justifyFor(align: ResultColumn["meta"]["text_align"]): string {
  if (align === "right") return "flex-end";
  if (align === "center") return "center";
  return "flex-start";
}

/** Generates the per-column CSS: geometry via the container's `--c*-k` vars, plus
 * the column-fixed font size, color, and alignment. Scoped under the grid's
 * unique class so multiple grids can't collide. Regenerated only when the column
 * set changes (a new result), never on resize. */
function columnStyleCss(uid: string, result: QueryResult): string {
  let css = "";
  result.columns.forEach((col, k) => {
    const sel = `.${uid} .c${k}`;
    const fontSize = col.meta.font_size === "small" ? SMALL_FONT : BODY_FONT;
    const color =
      col.meta.font_color === "light" ? "var(--ink-weak)" : "var(--ink)";
    const geom = `left:var(--cx-${k});width:var(--cw-${k});top:var(--ct-${k});height:var(--ch-${k});`;
    if (col.isList) {
      css += `${sel}{${geom}justify-content:${justifyFor(col.meta.text_align)};font-size:${fontSize}px;color:${color};}`;
    } else {
      // line-height = the line's height so single-line text centers vertically.
      css += `${sel}{${geom}line-height:var(--ch-${k});text-align:${col.meta.text_align};font-size:${fontSize}px;color:${color};}`;
    }
  });
  return css;
}

/** Builds every row as one HTML string (escaping cell text). One element per
 * scalar cell; list cells get inline pill spans clipped by the cell. */
function rowsHtml(result: QueryResult): string {
  const cols = result.columns;
  const parts: string[] = [];
  for (let r = 0; r < result.rowCount; r++) {
    parts.push('<div class="rc-row">');
    for (let k = 0; k < cols.length; k++) {
      const col = cols[k];
      if (col.isList) {
        const items = (col.cells as readonly (readonly string[])[])[r];
        let inner = "";
        for (const it of items) {
          inner += `<span class="rc-pill">${escapeHtml(it)}</span>`;
        }
        parts.push(`<div class="rc-cell rc-pillcell c${k}">${inner}</div>`);
      } else {
        const text = (col.cells as readonly string[])[r];
        parts.push(`<div class="rc-cell c${k}">${escapeHtml(text)}</div>`);
      }
    }
    parts.push("</div>");
  }
  return parts.join("");
}

/** Rebuilds the grid's inner DOM for a new result (or clears / shows an empty
 * state). Called only when the tab's result changes — not on resize. */
function renderRows(
  container: HTMLDivElement,
  uid: string,
  result: QueryResult | undefined,
): void {
  if (!result) {
    container.innerHTML = "";
    return;
  }
  if (result.rowCount === 0) {
    container.innerHTML = `<div class="rc-empty">No results</div>`;
    return;
  }
  container.innerHTML = `<style>${columnStyleCss(uid, result)}</style>${rowsHtml(result)}`;
}

/** Recomputes the (memoized) field layout for the current width and writes it to
 * the container's CSS vars — the resize path. Reproduces `row_metrics`: per-line
 * heights (max column height, +pill extra), cumulative line tops, and the shared
 * row height. Writes only `--row-h` + `(4·columns)` vars; the browser repositions
 * every cell via CSS-var inheritance — no per-node JS, no DOM rebuild. */
function applyLayout(
  container: HTMLDivElement,
  result: QueryResult | undefined,
  memo: ReturnType<typeof createLayoutMemo>,
): void {
  if (!result || result.rowCount === 0) return;
  const cols = colSizesOf(result);
  const avail = Math.max(0, container.clientWidth - TEXT_PAD_X * 2);
  const layout = memo(cols, avail, COL_GAP);

  const lineHeights = new Array<number>(layout.lineCount).fill(0);
  result.columns.forEach((col, k) => {
    const p = layout.placements[k];
    let h = col.meta.font_size === "small" ? SMALL_LINE_H : BODY_LINE_H;
    if (col.isList) h += PILL_LINE_EXTRA;
    lineHeights[p.line] = Math.max(lineHeights[p.line], h);
  });
  const lineTops = new Array<number>(layout.lineCount).fill(0);
  let acc = 0;
  for (let i = 0; i < layout.lineCount; i++) {
    lineTops[i] = acc;
    acc += lineHeights[i];
  }
  const contentH = layout.lineCount === 0 ? BODY_LINE_H : acc;
  const rowH = contentH + ROW_PAD_Y * 2;

  const s = container.style;
  s.setProperty("--row-h", `${rowH}px`);
  result.columns.forEach((col, k) => {
    const p = layout.placements[k];
    s.setProperty(`--cx-${k}`, `${TEXT_PAD_X + p.x}px`);
    s.setProperty(`--cw-${k}`, `${p.width}px`);
    s.setProperty(`--ct-${k}`, `${ROW_PAD_Y + lineTops[p.line]}px`);
    s.setProperty(`--ch-${k}`, `${lineHeights[p.line]}px`);
  });
}

let gridSeq = 0;

/** The results pane: the current tab's result set as the columnar DOM grid. */
export default function QueryResults(props: { tabId: string }) {
  const store = useAppState();
  let container: HTMLDivElement | undefined;
  const memo = createLayoutMemo();
  // A per-instance class so the generated per-column rules stay scoped.
  const uid = `rcg-${(gridSeq += 1)}`;
  // The current result (raw, un-proxied) — read by the resize handler without
  // re-touching the store.
  let current: QueryResult | undefined;

  // Rebuild rows when the tab's result changes (or the tab itself switches).
  // `unwrap` hands the tight build/layout loops the raw snapshot rather than
  // Solid store proxies, so reading 90k cells never wraps them reactively.
  createEffect(() => {
    const tracked = store.state.resultsByTab[props.tabId];
    current = tracked ? (unwrap(tracked) as QueryResult) : undefined;
    if (!container) return;
    renderRows(container, uid, current);
    applyLayout(container, current, memo);
  });

  onMount(() => {
    const el = container;
    if (!el) return;
    let raf = 0;
    // Coalesce resize bursts into one layout write per frame.
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        applyLayout(el, current, memo);
      });
    });
    ro.observe(el);
    onCleanup(() => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    });
  });

  return (
    <div
      ref={(el) => (container = el)}
      class={`rc-grid ${uid} min-h-0 flex-1`}
    />
  );
}
