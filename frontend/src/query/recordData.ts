// Running a record editor query: Querydown sections → SQL → the query API →
// plain string cells. The compile and the Arrow decode both live here so the
// form model deals only in rows of strings.
//
// The runner is swappable ({@link setRecordQueryRunner}) — a dev/test seam in the
// spirit of the store's `setResults`, letting the seeded harness render a form
// with canned data and no backend.

import { compile_sections } from "querydown-js";
import { runSql, stringifyArrowValue } from "../api/query";
import { querydownReady } from "./querydown";
import type { RecordQuery } from "./recordForm";

/** A query's cells as strings, row-major; `null` for a NULL cell. Columns are
 * positional — the caller knows what it asked for, in what order. */
export type RecordRows = readonly (readonly (string | null)[])[];

/** Runs one record query against the backend: compiles its sections to SQL,
 * executes it, and reads the Arrow table out as strings. */
async function runViaApi(
  query: RecordQuery,
  schemaJson: string,
): Promise<RecordRows> {
  await querydownReady();
  const { sql } = compile_sections(
    schemaJson,
    "duckdb",
    query.base,
    "", // no definitions: the form queries real columns only
    query.filter,
    query.sort,
    query.display,
  );
  const table = await runSql(sql);
  const width = table.schema.fields.length;
  const rows: (string | null)[][] = [];
  for (let r = 0; r < table.numRows; r++) {
    const row: (string | null)[] = new Array<string | null>(width);
    for (let c = 0; c < width; c++) {
      const value = table.getChildAt(c)?.get(r);
      row[c] = value == null ? null : stringifyArrowValue(value);
    }
    rows.push(row);
  }
  return rows;
}

let runner: (query: RecordQuery, schemaJson: string) => Promise<RecordRows> =
  runViaApi;

/** Runs a record query through whatever runner is installed. */
export function runRecordQuery(
  query: RecordQuery,
  schemaJson: string,
): Promise<RecordRows> {
  return runner(query, schemaJson);
}

/** Replaces the runner (dev/test seam — see the module note). */
export function setRecordQueryRunner(
  fn: (query: RecordQuery, schemaJson: string) => Promise<RecordRows>,
): void {
  runner = fn;
}
