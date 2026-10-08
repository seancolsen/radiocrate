// Query results as delimited text, for "Export results data".
//
// The export is what the grid shows: its visible columns, in order, each cell's
// display text (formatter, prefix and suffix applied), and a list cell's pills
// joined into one field. The user can leave columns out, and write a formatted
// column's raw data instead of its display text. There's no header row — the
// grid has none, and the column names DuckDB gives an unaliased expression
// (`COALESCE("cte0"."v1", 0)`) aren't anything a user wrote.
//
// Fields are tab-separated and records newline-separated; PapaParse quotes a
// field only when it has to (a tab, quote or line break in it, or leading or
// trailing whitespace).

import Papa from "papaparse";
import type { ColumnMetadata } from "./columns";
import type { QueryResult, ResultColumn } from "./result";

/** What a list cell's values are joined with into a single field. */
const LIST_SEPARATOR = ", ";

/** Whether a column's display text can differ from its raw data — a formatter,
 * a prefix or a suffix — so that exporting it offers a choice between them. */
export function hasFormatting(meta: ColumnMetadata): boolean {
  return (
    meta.formatter !== undefined || meta.prefix !== "" || meta.suffix !== ""
  );
}

/** One cell as a single field: its display text, or with `raw` its plain
 * string form (no formatter, prefix or suffix). A list cell's values are joined
 * into one. */
export function exportCellText(
  result: QueryResult,
  row: number,
  column: ResultColumn,
  raw: boolean,
): string {
  if (column.isList) {
    const values = raw
      ? result.rawPills(row, column)
      : result.pills(row, column);
    return values.join(LIST_SEPARATOR);
  }
  return raw ? result.keyText(row, column.index) : result.text(row, column);
}

/** Which of a result's rows and columns to write out, and how. Columns are
 * named by {@link ResultColumn.index}. */
export interface CsvOptions {
  /** The display rows to write (all of them when omitted). */
  rows?: Iterable<number>;
  /** Visible columns to leave out. */
  excluded?: readonly number[];
  /** Columns to write as raw data rather than display text. */
  raw?: readonly number[];
}

/** The display rows of `result` that `options` names, in display order
 * whatever order it lists them in, as tab-separated text. Rows outside the
 * result are skipped. */
export function resultToCsv(
  result: QueryResult,
  options: CsvOptions = {},
): string {
  const { rows, excluded = [], raw = [] } = options;
  const indexes =
    rows === undefined
      ? Array.from({ length: result.rowCount }, (_, i) => i)
      : [...new Set(rows)]
          .filter((r) => r >= 0 && r < result.rowCount)
          .sort((a, b) => a - b);
  const columns = result.visible.filter((c) => !excluded.includes(c.index));
  const data = indexes.map((row) =>
    columns.map((column) =>
      exportCellText(result, row, column, raw.includes(column.index)),
    ),
  );
  return Papa.unparse(data, { delimiter: "\t", newline: "\n" });
}
