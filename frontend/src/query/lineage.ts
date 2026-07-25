// Column-lineage analysis of a compiled query, ported from the egui frontend's
// `lineage.rs`. That code used the `polyglot-sql` Rust crate to trace each output
// column back through the SQL to its source table column; here we use the same
// analysis compiled to a tiny WASM binding (`track-lineage`, vendored — see the
// repo-root `track-lineage/` crate). We build it ourselves with only the
// `semantic` + DuckDB features rather than pulling the full `@polyglot-sql/sdk`
// npm package, whose all-dialects build is ~22 MB vs. our ~2 MB.
//
// The WASM answers one raw question — which base-table columns does each output
// column trace back to — and this module turns that into the two things the UI
// needs:
//
//   • which output column carries `track.id` (rows are tracks → double-click
//     plays), mirroring `IdColumns.track` in the Rust code; and
//   • which output columns carry some table's whole primary key (rows identify a
//     record of that table → right-click offers "Edit {table}"). The egui code
//     only ever asked this of the query's *base* table (`IdColumns.record`); we
//     ask it of every table in the schema, so a row joining track → album offers
//     both.
//
// Like `querydown-js`, the `.wasm` is imported as a same-origin asset URL
// (CSP/offline-safe) and instantiated once, lazily, on first use — off the
// critical path, so results paint first and the affordances light up once the
// analysis is ready.

import init, { column_sources } from "track-lineage";
import wasmUrl from "track-lineage/track_lineage_bg.wasm?url";
import { identifyingColumns, type SchemaTable } from "./schema";

let ready: Promise<void> | undefined;

/** Instantiates the track-lineage WASM once, sharing one init across callers. */
function trackLineageReady(): Promise<void> {
  ready ??= init({ module_or_path: wasmUrl }).then(() => undefined);
  return ready;
}

/** One base-table column an output column traces back to. */
export interface ColumnSource {
  table: string;
  column: string;
}

/** Per output column (0-based, in the query's projection order — which matches
 * the Arrow result columns *before* hidden columns are dropped), the base-table
 * columns it traces back to. */
export type ColumnSources = readonly (readonly ColumnSource[])[];

/** Traces every output column of `sql` back to its source table columns.
 * `undefined` when the SQL can't be parsed or analyzed — callers then offer no
 * lineage-derived affordances, matching the Rust code's fallible-to-default
 * behavior. */
export async function analyzeColumnSources(
  sql: string,
): Promise<ColumnSources | undefined> {
  try {
    await trackLineageReady();
    const json = column_sources(sql);
    if (json === undefined) return undefined;
    const raw = JSON.parse(json) as [string, string][][];
    return raw.map((sources) =>
      sources.map(([table, column]) => ({ table, column })),
    );
  } catch (err) {
    console.error("lineage analysis failed", err);
    return undefined;
  }
}

/** Whether an output column's sources include `table`.`column`, matched
 * case-insensitively as the Rust `traces_to` did. */
function tracesTo(
  sources: readonly ColumnSource[],
  table: string,
  column: string,
): boolean {
  return sources.some(
    (s) =>
      s.table.toLowerCase() === table.toLowerCase() &&
      s.column.toLowerCase() === column.toLowerCase(),
  );
}

/** The single output column tracing to `table`.`column`, or `undefined` when
 * none does or more than one does. Mirrors `lineage.rs`'s `Unique` handling: an
 * unambiguous match is trusted, an ambiguous mapping is not. */
export function uniqueColumnFor(
  sources: ColumnSources,
  table: string,
  column: string,
): number | undefined {
  let found: number | undefined;
  for (let i = 0; i < sources.length; i++) {
    if (!tracesTo(sources[i], table, column)) continue;
    if (found !== undefined) return undefined; // ambiguous
    found = i;
  }
  return found;
}

/** The output column carrying `track.id`, if the query has exactly one — i.e.
 * the rows represent tracks and can be double-clicked to play. */
export function trackIdColumn(sources: ColumnSources): number | undefined {
  return uniqueColumnFor(sources, "track", "id");
}

/** A table whose records the query's rows identify: its key columns, paired with
 * the output columns carrying their values. */
export interface RecordKeyColumns {
  /** The table name, as introspected. */
  table: string;
  /** The key columns identifying one record, in constraint order. */
  keyColumns: readonly string[];
  /** The output-column index carrying each key column's value, parallel to
   * `keyColumns`. */
  keyIndices: readonly number[];
}

/** Every table whose primary key the query's output columns carry in full — one
 * per editable record a result row stands for.
 *
 * A table qualifies when *each* of its identifying columns (single-column key,
 * or every column of a composite one — see {@link identifyingColumns}) traces to
 * exactly one output column. A key column matched by two or more output columns
 * is ambiguous: the row could stand for either record, so the table is dropped
 * rather than guessed at (the same call `lineage.rs`'s `Unique` made).
 *
 * Ordered by the leftmost output column each key occupies, so the menu lists the
 * table the results lead with first. */
export function recordKeyColumns(
  sources: ColumnSources,
  tables: readonly SchemaTable[],
): RecordKeyColumns[] {
  const found: RecordKeyColumns[] = [];
  for (const table of tables) {
    const keyColumns = identifyingColumns(table);
    if (keyColumns.length === 0) continue;
    const keyIndices: number[] = [];
    for (const column of keyColumns) {
      const idx = uniqueColumnFor(sources, table.name, column);
      if (idx === undefined) break;
      keyIndices.push(idx);
    }
    if (keyIndices.length !== keyColumns.length) continue;
    found.push({ table: table.name, keyColumns, keyIndices });
  }
  return found.sort(
    (a, b) => Math.min(...a.keyIndices) - Math.min(...b.keyIndices),
  );
}
