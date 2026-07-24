// Column-lineage analysis of a compiled query, ported from the egui frontend's
// `lineage.rs`. That code used the `polyglot-sql` Rust crate to trace each output
// column back through the SQL to its source table column; here we use the same
// project's JavaScript/WASM bindings (`@polyglot-sql/sdk`).
//
// Right now the only thing we deduce is which output column carries `track.id`:
// if the query has one (unambiguously), each result row represents a track and a
// double-click can play it. This mirrors `IdColumns.track` in the Rust code (the
// base-table primary-key column, `record`, isn't needed until the record editor
// lands).
//
// The polyglot WASM is large (~20 MB) and only needed once per query run, so the
// module is imported lazily and off the critical path — results paint first, and
// the double-click affordance lights up once detection resolves.

type Sdk = typeof import("@polyglot-sql/sdk");

let sdk: Promise<Sdk> | undefined;

/** Lazily loads (and initializes) the polyglot-sql WASM bindings, sharing one
 * load across all callers. */
function loadSdk(): Promise<Sdk> {
  sdk ??= import("@polyglot-sql/sdk").then(async (m) => {
    await m.init();
    return m;
  });
  return sdk;
}

/** The output-column index (0-based, in the query's projection order — which
 * matches the Arrow result columns *before* hidden columns are dropped) that
 * unambiguously traces back to `track.id`, or `undefined` if none does or more
 * than one does. Mirrors `lineage.rs`'s `Unique` handling: a single match is
 * trusted, an ambiguous mapping is not.
 *
 * Any parse/analysis failure degrades to `undefined` (no double-click
 * affordance), matching the Rust code's fallible-to-default behavior. */
export async function detectTrackIdColumn(
  sql: string,
): Promise<number | undefined> {
  return detectIdColumn(sql, "track", "id");
}

/** Locates the sole output column tracing to `table`.`column`, by table and
 * column name (case-insensitive). */
async function detectIdColumn(
  sql: string,
  table: string,
  column: string,
): Promise<number | undefined> {
  try {
    const pg = await loadSdk();
    const res = pg.analyzeQuery(sql, "duckdb");
    if (!res.success || !res.analysis) return undefined;

    let found: number | undefined;
    let ambiguous = false;
    for (const proj of res.analysis.projections) {
      const tracesTo = proj.upstream.some(
        (u) =>
          (u.table ?? u.sourceName ?? "").toLowerCase() === table &&
          u.column.toLowerCase() === column,
      );
      if (!tracesTo) continue;
      if (found !== undefined) ambiguous = true;
      else found = proj.index;
    }
    return ambiguous ? undefined : found;
  } catch (err) {
    console.error("lineage analysis failed", err);
    return undefined;
  }
}
