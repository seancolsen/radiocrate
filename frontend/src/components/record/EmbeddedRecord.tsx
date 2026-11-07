import { useMemo, useRef, type JSX, type MouseEvent } from "react";
import type { ColumnMetadata } from "../../query/columns";
import { visibleCells } from "../../query/embedPreview";
import { computeFieldLayout } from "../../query/fieldLayout";
import { displayText } from "../../query/format";
import { COL_GAP } from "../../query/rowGeometry";
import { cx } from "../ui/cx";
import { useElementWidth } from "../ui/useElementWidth";
import { useMinuteClock } from "../ui/useMinuteClock";
import ModifiedStar from "./ModifiedStar";

// The embedded record: a preview of one row, inside the form.
//
// It's the query result row's DOM cousin — same field-layout algorithm, same
// surface treatment (gradient, hover, selected fill), same column annotations —
// with the deviations the spec calls for: the widget is bordered and rounded to a
// semicircle at each end, its text runs a size smaller, and every line is the one
// height, so a single line comes to the standard control height (see `control` in
// `app.css`) whatever its columns' sizes. Its cells are positioned rather than
// flowed, exactly as the canvas positions them, so a preview reads like the row it
// previews.
//
// Which columns it shows is decided in `query/embeddedRecord.ts`; this component
// only receives their values, and the annotations they came with.

/** Horizontal padding inside the widget. Wider than a result row's, so text
 * clears the rounded ends rather than running into them. */
const PAD_X = 12;
/** Height of one line of cells. */
const LINE_H = 16;
/** Vertical padding inside the widget. */
const PAD_Y = 4;
/** Border width, in the height calculations below. */
const BORDER = 1;
/** The radius that makes a single-line widget a perfect semicircle at each end:
 * half its border-box height. It stays fixed as content wraps, so a taller
 * widget keeps flat sides between the same two rounded ends. */
const RADIUS = (LINE_H + PAD_Y * 2 + BORDER * 2) / 2;

/** A preview of one record: its cells laid out like a result row.
 *
 * `cells` is empty while the preview is still loading (or for a record being
 * created), which leaves an empty widget of the right size — the shape of the
 * list is visible before its contents arrive. */
export default function EmbeddedRecord(props: {
  cells: readonly (string | null)[];
  /** How each of `cells` is shown, by the annotations of the query it came from.
   * Absent, every column has the defaults a result column would. */
  columns?: readonly ColumnMetadata[];
  /** Whether this widget is a selected member of a multi-record field. */
  selected?: boolean;
  /** Whether the user can focus it (only multi-record members can). */
  focusable?: boolean;
  /** A record being added but not yet saved, which has no values to preview. */
  isNew?: boolean;
  /** The record's own preview text (or key) — shown as an unsaved-changes star
   * pinned to this widget's top-left corner, in place of an `aria-label`. Left
   * `undefined` to show no star: a record's own modification never shows on a
   * widget that's still `isNew` (there's nothing to compare it against yet). */
  modifiedLabel?: string;
  itemId?: string;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onDblClick?: () => void;
  onFocus?: () => void;
  onContextMenu?: (e: MouseEvent<HTMLDivElement>) => void;
}): JSX.Element {
  // The available width decides the layout, so it's measured rather than
  // assumed: the sidebar is resizable and the widget is nested arbitrarily deep.
  // Measured before the first paint, so it already has the real width.
  // `clientWidth`: the widget has a border but no padding, and the layout wants
  // whole pixels.
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, "client");

  const { cells, columns } = props;
  const shown = useMemo(
    () => visibleCells({ cells, columns }),
    [cells, columns],
  );
  const layout = useMemo(
    () =>
      computeFieldLayout(
        shown.map(({ meta }) => ({ min: meta.min_width, max: meta.max_width })),
        Math.max(0, width - PAD_X * 2),
        COL_GAP,
      ),
    [shown, width],
  );
  // Only a `relativeTime` cell's text changes with the time.
  const now = useMinuteClock(
    shown.some(({ meta }) => meta.formatter?.type === "relativeTime"),
  );
  const height =
    Math.max(1, layout.lineCount) * LINE_H + PAD_Y * 2 + BORDER * 2;

  return (
    <div
      ref={ref}
      className="rc-embedded text-ink focus:outline-accent relative min-w-0 flex-1 cursor-default text-xs outline-none select-none focus:outline-2 focus:outline-offset-0"
      style={{ height: `${height}px`, borderRadius: `${RADIUS}px` }}
      data-selected={props.selected ? "true" : undefined}
      data-form-item={props.focusable ? "" : undefined}
      data-selectable={props.focusable ? "" : undefined}
      data-item-id={props.itemId}
      tabIndex={props.focusable ? 0 : undefined}
      onClick={(e) => props.onClick?.(e)}
      onDoubleClick={() => props.onDblClick?.()}
      onFocus={() => props.onFocus?.()}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      {props.modifiedLabel ? (
        <ModifiedStar label={props.modifiedLabel} />
      ) : null}
      {props.isNew && (
        <span
          className="absolute inset-0 flex items-center justify-center italic"
          style={{ lineHeight: `${LINE_H}px` }}
        >
          New
        </span>
      )}
      {shown.map(({ index, value, meta }, position) => {
        const placement = layout.placements[position];
        return (
          <span
            key={index}
            className={cx(
              "absolute truncate",
              meta.font_size === "small" && "text-[10px]",
              meta.font_color === "light" && "text-ink-weak",
            )}
            style={{
              left: `${PAD_X + placement.x}px`,
              top: `${PAD_Y + placement.line * LINE_H}px`,
              width: `${placement.width}px`,
              lineHeight: `${LINE_H}px`,
              textAlign: meta.text_align,
            }}
          >
            {displayText(meta, value ?? "", now)}
          </span>
        );
      })}
    </div>
  );
}
