import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from "react";
import { computeFieldLayout } from "../../query/fieldLayout";
import { defaultColumnMetadata } from "../../query/columns";
import { COL_GAP, ROW_PAD_Y, SMALL_LINE_H } from "../../query/rowGeometry";
import ModifiedStar from "./ModifiedStar";

// The embedded record: a preview of one row, inside the form.
//
// It's the query result row's DOM cousin — same field-layout algorithm, same row
// metrics, same surface treatment (gradient, hover, selected fill) — with the
// deviations the spec calls for: every cell is small and light whatever the
// column says, and the widget is bordered and rounded to a semicircle at each
// end. Its cells are positioned rather than flowed, exactly as the canvas
// positions them, so a preview reads like the row it previews.
//
// Which columns it shows is decided in `query/embeddedRecord.ts`; this component
// only receives their values.

/** Horizontal padding inside the widget. Wider than a result row's, so text
 * clears the rounded ends rather than running into them. */
const PAD_X = 12;
/** Border width, in the radius calculation below. */
const BORDER = 1;
/** The radius that makes a single-line widget a perfect semicircle at each end:
 * half its border-box height. It stays fixed as content wraps, so a taller
 * widget keeps flat sides between the same two rounded ends. */
const RADIUS = (SMALL_LINE_H + ROW_PAD_Y * 2 + BORDER * 2) / 2;

/** The width bounds every preview column gets: the same defaults a result column
 * has when its query annotates it with nothing. */
const META = defaultColumnMetadata();

/** A preview of one record: its cells laid out like a result row.
 *
 * `cells` is empty while the preview is still loading (or for a record being
 * created), which leaves an empty widget of the right size — the shape of the
 * list is visible before its contents arrive. */
export default function EmbeddedRecord(props: {
  cells: readonly (string | null)[];
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
  // Measured in a layout effect, so the first paint already has the real width.
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const cells = props.cells;
  const layout = useMemo(
    () =>
      computeFieldLayout(
        cells.map(() => ({ min: META.min_width, max: META.max_width })),
        Math.max(0, width - PAD_X * 2),
        COL_GAP,
      ),
    [cells, width],
  );
  const height = Math.max(1, layout.lineCount) * SMALL_LINE_H + ROW_PAD_Y * 2;

  return (
    <div
      ref={ref}
      className="rc-embedded text-ink-weak focus:outline-accent relative min-w-0 flex-1 cursor-default text-[11px] outline-none select-none focus:outline-2 focus:outline-offset-0"
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
          style={{ lineHeight: `${SMALL_LINE_H}px` }}
        >
          New
        </span>
      )}
      {cells.map((cell, index) => {
        const placement = layout.placements[index];
        return (
          <span
            key={index}
            className="absolute truncate"
            style={{
              left: `${PAD_X + placement.x}px`,
              top: `${ROW_PAD_Y + placement.line * SMALL_LINE_H}px`,
              width: `${placement.width}px`,
              lineHeight: `${SMALL_LINE_H}px`,
            }}
          >
            {cell}
          </span>
        );
      })}
    </div>
  );
}
