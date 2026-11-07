// What an embedded record's cells come to on screen, once the annotations of the
// query they came from have had their say — the same settings, read the same way,
// as a result row's (see `query/columns.ts`).
//
// Pure, so the widget and the labels that name it agree on what it shows.

import { defaultColumnMetadata, type ColumnMetadata } from "./columns";
import { displayText } from "./format";

const DEFAULTS = defaultColumnMetadata();

/** One record's preview: its cells, and how each column is to be shown. */
export interface EmbedPreview {
  cells: readonly (string | null)[];
  /** Positional, like the cells. Absent, or short, means the defaults. */
  columns?: readonly ColumnMetadata[];
}

/** A preview with something to show: `cells`, unless the query asked for nothing
 * or hid all of it, when `key` stands in rather than leaving the widget blank. */
export function embedPreview(
  cells: readonly (string | null)[],
  columns: readonly ColumnMetadata[],
  key: readonly (string | null)[],
): EmbedPreview {
  return cells.some((_, i) => !columns[i]?.hide)
    ? { cells, columns }
    : { cells: key };
}

/** The cells a preview shows, in order, with the settings of each. */
export function visibleCells(
  preview: EmbedPreview,
): { index: number; value: string | null; meta: ColumnMetadata }[] {
  return preview.cells.flatMap((value, index) => {
    const meta = preview.columns?.[index] ?? DEFAULTS;
    return meta.hide ? [] : [{ index, value, meta }];
  });
}

/** A preview's text as it reads on screen, for whatever has to name the record in
 * words. Empty when none of it has any. */
export function embedText(preview: EmbedPreview): string {
  return visibleCells(preview)
    .map(({ value, meta }) => displayText(meta, value))
    .filter(Boolean)
    .join(" ");
}
