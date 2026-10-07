// Query results as delimited text, for "Export results data".
//
// The export is what the grid shows: its visible columns, in order, each cell's
// display text (formatter, prefix and suffix applied), and a list cell's pills
// joined into one field. There's no header row — the grid has none, and the
// column names DuckDB gives an unaliased expression (`COALESCE("cte0"."v1",
// 0)`) aren't anything a user wrote.
//
// Fields are tab-separated and records newline-separated; PapaParse quotes a
// field only when it has to (a tab, quote or line break in it, or leading or
// trailing whitespace).

import Papa from "papaparse";
import type { QueryResult } from "./result";

/** What a list cell's values are joined with into a single field. */
const LIST_SEPARATOR = ", ";

/** The display rows of `result` named by `rows` (all of them when omitted), in
 * display order whatever order `rows` lists them in, as tab-separated text. Rows
 * outside the result are skipped. */
export function resultToCsv(
  result: QueryResult,
  rows?: Iterable<number>,
): string {
  const indexes =
    rows === undefined
      ? Array.from({ length: result.rowCount }, (_, i) => i)
      : [...new Set(rows)]
          .filter((r) => r >= 0 && r < result.rowCount)
          .sort((a, b) => a - b);
  const data = indexes.map((row) =>
    result.visible.map((column) =>
      column.isList
        ? result.pills(row, column).join(LIST_SEPARATOR)
        : result.text(row, column),
    ),
  );
  return Papa.unparse(data, { delimiter: "\t", newline: "\n" });
}
