// Running a record editor query: Querydown sections → SQL → the query API →
// plain string cells, and what the query's annotations say about showing them.
// The compile and the Arrow decode both live here so the form model deals only in
// rows of strings.
//
// The runner is swappable ({@link setRecordQueryRunner}) — a dev/test seam in the
// spirit of the store's `setResults`, letting the seeded harness render a form
// with canned data and no backend.

import { compile_sections, is_querydown_error } from "querydown-js";
import { runSql } from "../api/query";
import type { ColumnMetadata } from "./columns";
import { querydownReady } from "./querydown";
import type { RecordQuery } from "./recordForm";
import { buildResultFromArrow, type QueryResult } from "./result";

/** A query's cells as strings, row-major; `null` for a NULL cell. Columns are
 * positional — the caller knows what it asked for, in what order. */
export type RecordRows = readonly (readonly (string | null)[])[];

/** A query's cells, and how each column is to be shown: positional, like the
 * cells. A column the query didn't annotate has its defaults. */
export interface RecordResult {
  rows: RecordRows;
  columns: readonly ColumnMetadata[];
}

/** A decoded table's cells as strings, in the plain form a key is read in: no
 * formatter, prefix or suffix, which are for whoever ends up showing them. */
export function recordRowsOf(result: QueryResult): RecordRows {
  const rows: (string | null)[][] = [];
  for (let r = 0; r < result.rowCount; r++) {
    rows.push(
      result.columns.map(({ index }) =>
        result.value(r, index) == null ? null : result.keyText(r, index),
      ),
    );
  }
  return rows;
}

/** Runs one record query against the backend: compiles its sections to SQL,
 * executes it, and reads the Arrow table out as strings. */
async function runViaApi(
  query: RecordQuery,
  schemaJson: string,
): Promise<RecordResult> {
  await querydownReady();
  const { sql, columnAnnotations } = compile_sections(
    schemaJson,
    "duckdb",
    query.base,
    "", // no definitions: the form queries real columns only
    query.filter,
    query.sort,
    query.display,
  );
  const result = buildResultFromArrow(await runSql(sql), columnAnnotations);
  return {
    rows: recordRowsOf(result),
    columns: result.columns.map((column) => column.meta),
  };
}

let runner: (query: RecordQuery, schemaJson: string) => Promise<RecordResult> =
  runViaApi;

/** Runs a record query through whatever runner is installed, for its data. */
export async function runRecordQuery(
  query: RecordQuery,
  schemaJson: string,
): Promise<RecordRows> {
  return (await runner(query, schemaJson)).rows;
}

/** Runs a record query whose rows will be shown to the user, so how to show them
 * comes too. */
export function runDisplayQuery(
  query: RecordQuery,
  schemaJson: string,
): Promise<RecordResult> {
  return runner(query, schemaJson);
}

/** Whether a failed query never reached the database, its Querydown not compiling. */
export function isCompileError(err: unknown): boolean {
  return is_querydown_error(err);
}

/** Replaces the runner (dev/test seam — see the module note). */
export function setRecordQueryRunner(
  fn: (query: RecordQuery, schemaJson: string) => Promise<RecordResult>,
): void {
  runner = fn;
}
