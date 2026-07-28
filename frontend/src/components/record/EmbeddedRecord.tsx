import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { computeFieldLayout } from "../../query/fieldLayout";
import { defaultColumnMetadata } from "../../query/columns";
import { COL_GAP, ROW_PAD_Y, SMALL_LINE_H } from "../../query/rowGeometry";

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
  itemId?: string;
  onClick?: (e: MouseEvent & { currentTarget: HTMLElement }) => void;
  onDblClick?: () => void;
  onFocus?: () => void;
  onContextMenu?: (e: MouseEvent & { currentTarget: HTMLElement }) => void;
}) {
  // The available width decides the layout, so it's measured rather than
  // assumed: the sidebar is resizable and the widget is nested arbitrarily deep.
  const [width, setWidth] = createSignal(0);
  const measure = (el: HTMLElement) => {
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    onCleanup(() => observer.disconnect());
  };

  const layout = createMemo(() =>
    computeFieldLayout(
      props.cells.map(() => ({ min: META.min_width, max: META.max_width })),
      Math.max(0, width() - PAD_X * 2),
      COL_GAP,
    ),
  );
  const height = () =>
    Math.max(1, layout().lineCount) * SMALL_LINE_H + ROW_PAD_Y * 2;

  return (
    <div
      ref={measure}
      class="rc-embedded text-ink-weak focus:outline-accent relative min-w-0 flex-1 cursor-default text-[11px] outline-none focus:outline-2 focus:outline-offset-0"
      style={{
        height: `${height()}px`,
        "border-radius": `${RADIUS}px`,
      }}
      data-selected={props.selected ? "true" : undefined}
      data-form-item={props.focusable ? "" : undefined}
      data-selectable={props.focusable ? "" : undefined}
      data-item-id={props.itemId}
      tabindex={props.focusable ? 0 : undefined}
      onClick={(e) => props.onClick?.(e)}
      onDblClick={() => props.onDblClick?.()}
      onFocus={() => props.onFocus?.()}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      <Show when={props.isNew}>
        <span
          class="absolute inset-0 flex items-center justify-center italic"
          style={{ "line-height": `${SMALL_LINE_H}px` }}
        >
          New
        </span>
      </Show>
      <For each={props.cells}>
        {(cell, index) => {
          const placement = () => layout().placements[index()];
          return (
            <span
              class="absolute truncate"
              style={{
                left: `${PAD_X + placement().x}px`,
                top: `${ROW_PAD_Y + placement().line * SMALL_LINE_H}px`,
                width: `${placement().width}px`,
                "line-height": `${SMALL_LINE_H}px`,
              }}
            >
              {cell}
            </span>
          );
        }}
      </For>
    </div>
  );
}
