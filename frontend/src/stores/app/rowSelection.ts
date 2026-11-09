// A page's result-row selection, and every way the user changes it, as pure
// functions from one selection to the next. The actions in `actions.ts` assign
// what these return; nothing else builds a `RowSelection`.

/** A page's result-row selection: which rows are selected, plus the two ends
 * that keyboard and Shift+click gestures work from. One value, written whole,
 * so the selected rows and the place the next gesture counts from can't come
 * apart. (Before this, the anchor and lead were kept outside the store. A
 * write that selected rows without updating them, like the now-playing bar's
 * "Locate", left the arrow keys stepping from a row that was no longer
 * selected.)
 *
 * `rows` is a `Set` that's always swapped in whole, never mutated. Immer has
 * no `enableMapSet()` here, so read it from `get()`, never through a
 * draft. */
export interface RowSelection {
  /** The selected row indexes. Can be empty: Ctrl+clicking off the last
   * selected row leaves nothing selected but keeps the place it was at. */
  readonly rows: ReadonlySet<number>;
  /** The fixed end: the row a Shift range grows from. */
  readonly anchor: number;
  /** The moving end: the row an arrow-key step counts from. */
  readonly lead: number;
  /** Only on a selection grown by a tap in multi-select's range mode (see
   * {@link rangedSelection}): the rows that were selected before the range
   * began. They stay selected however the range from `anchor` to `lead` grows
   * or shrinks. Every other transition builds a selection without it, which
   * is what ends the range: the next range tap starts from what's selected
   * then. */
  readonly kept?: ReadonlySet<number>;
}

/** The rows from `a` to `b`, inclusive, in either order. */
function span(a: number, b: number): Set<number> {
  const rows = new Set<number>();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) rows.add(i);
  return rows;
}

/** Row `row` alone, with both ends on it. */
export function singleRow(row: number): RowSelection {
  return { rows: new Set([row]), anchor: row, lead: row };
}

/** Rows `rows` (they needn't be contiguous), as clicking the first and
 * Shift+clicking the last would anchor them. `undefined` for none. */
export function someRows(rows: readonly number[]): RowSelection | undefined {
  if (rows.length === 0) return undefined;
  return { rows: new Set(rows), anchor: rows[0], lead: rows[rows.length - 1] };
}

/** Every one of `rowCount` rows, anchored at the top. `undefined` for none. */
export function allRows(rowCount: number): RowSelection | undefined {
  if (rowCount === 0) return undefined;
  return { rows: span(0, rowCount - 1), anchor: 0, lead: rowCount - 1 };
}

/** The selection after a click on row `row`. Shift grows a range from the
 * anchor (from `row` itself, with nothing anchored yet). `toggle` (Ctrl, or
 * any click in multi-select mode) adds or removes `row` and re-anchors there.
 * A plain click selects `row` alone. In every case `row` becomes the lead. */
export function clickedSelection(
  prev: RowSelection | undefined,
  row: number,
  mods: { shift: boolean; toggle: boolean },
): RowSelection {
  if (mods.shift) {
    const anchor = prev?.anchor ?? row;
    return { rows: span(anchor, row), anchor, lead: row };
  }
  if (mods.toggle) {
    const rows = new Set(prev?.rows);
    if (rows.has(row)) rows.delete(row);
    else rows.add(row);
    return { rows, anchor: row, lead: row };
  }
  return singleRow(row);
}

/** The selection after a tap on row `row` in multi-select's range mode: the
 * rows from the range's origin to `row`, on top of whatever was selected
 * before the range began.
 *
 * The origin is the anchor, provided it's selected — the row last tapped on,
 * or the one multi-select mode was entered from — and it stays put wherever
 * the taps land, so a later tap nearer to it shrinks the range rather than
 * starting another. With no selected anchor (nothing selected, or the last
 * tap took its row out), the tap sets the origin instead, selecting `row`. */
export function rangedSelection(
  prev: RowSelection | undefined,
  row: number,
): RowSelection {
  if (!prev || !prev.rows.has(prev.anchor)) {
    const kept = prev?.rows ?? new Set<number>();
    return { rows: new Set([...kept, row]), anchor: row, lead: row, kept };
  }
  const kept = prev.kept ?? prev.rows;
  const rows = span(prev.anchor, row);
  for (const r of kept) rows.add(r);
  return { rows, anchor: prev.anchor, lead: row, kept };
}

/** `prev` with nothing selected, keeping its place: the arrow keys and the
 * next Shift+click still count from where it was. */
export function clearedSelection(prev: RowSelection): RowSelection {
  return { rows: new Set(), anchor: prev.anchor, lead: prev.lead };
}

/** The selection after an arrow-key step down (`forward`) or up among
 * `rowCount` rows: one row past the lead, stopping at the ends. With nothing
 * selected yet, Down selects the first row and Up the last. `extend`
 * (Shift+Arrow) grows the range from the anchor rather than selecting the new
 * row alone. `undefined` when there are no rows to step through. */
export function steppedSelection(
  prev: RowSelection | undefined,
  rowCount: number,
  forward: boolean,
  extend: boolean,
): RowSelection | undefined {
  if (rowCount === 0) return undefined;
  const last = rowCount - 1;
  const clamp = (row: number) => Math.min(Math.max(row, 0), last);
  const lead =
    prev === undefined
      ? forward
        ? 0
        : last
      : clamp(prev.lead + (forward ? 1 : -1));
  if (!extend) return singleRow(lead);
  const anchor = prev === undefined ? lead : clamp(prev.anchor);
  return { rows: span(anchor, lead), anchor, lead };
}

/** `selection` fitted to rows that came back `rowCount` long, for a refresh
 * that may have returned fewer rows than before: the selected rows past the
 * end are dropped, and the ends are pulled back inside. The same reference
 * when every selected row survived (so a refresh that moved nothing doesn't
 * look like a change of selection), and `undefined` when none did. */
export function trimmedSelection(
  selection: RowSelection,
  rowCount: number,
): RowSelection | undefined {
  const kept = [...selection.rows].filter((row) => row < rowCount);
  if (kept.length === selection.rows.size) return selection;
  if (kept.length === 0) return undefined;
  const last = rowCount - 1;
  return {
    rows: new Set(kept),
    anchor: Math.min(selection.anchor, last),
    lead: Math.min(selection.lead, last),
  };
}
