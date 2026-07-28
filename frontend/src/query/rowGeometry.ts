// The geometry of a row of query results — the numbers that, together with
// `fieldLayout.ts`, decide where a row's cells sit and how tall the row is.
//
// Two things draw rows and must agree on these: the results grid, painted to a
// canvas (`components/canvasGrid.ts`), and the record editor's embedded record
// widget, built from DOM nodes (`components/record/EmbeddedRecord.tsx`). Logical
// px == CSS px in both.

/** Vertical padding above and below a row's content. */
export const ROW_PAD_Y = 6;
/** Horizontal padding between a row's edge and its content area. */
export const TEXT_PAD_X = 8;
/** Horizontal spacing between two columns on the same line. */
export const COL_GAP = 16;

// Per-line content heights and the matching font sizes (hardcoded, not measured
// per frame, so the layout stays deterministic and memoizable).
export const BODY_LINE_H = 18;
export const SMALL_LINE_H = 15;
export const BODY_FONT = 14;
export const SMALL_FONT = 11;
