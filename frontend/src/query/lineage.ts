// Column-lineage analysis of a compiled query, ported from the egui frontend's
// `lineage.rs`. That code used the `polyglot-sql` Rust crate to trace each output
// column back through the SQL to its source table column; here we use the same
// analysis compiled to a tiny WASM binding (`track-lineage`, vendored — see the
// repo-root `track-lineage/` crate). We build it ourselves with only the
// `semantic` + DuckDB features rather than pulling the full `@polyglot-sql/sdk`
// npm package, whose all-dialects build is ~22 MB vs. our ~2 MB.
//
// The one thing we deduce is which output column carries `track.id`: if the
// query has one (unambiguously), each result row represents a track and a
// double-click can play it. This mirrors `IdColumns.track` in the Rust code.
//
// Like `querydown-js`, the `.wasm` is imported as a same-origin asset URL
// (CSP/offline-safe) and instantiated once, lazily, on first use — off the
// critical path, so results paint first and the double-click affordance lights
// up once the analysis is ready.

import init, { detect_track_id_column } from "track-lineage";
import wasmUrl from "track-lineage/track_lineage_bg.wasm?url";

let ready: Promise<void> | undefined;

/** Instantiates the track-lineage WASM once, sharing one init across callers. */
function trackLineageReady(): Promise<void> {
  ready ??= init({ module_or_path: wasmUrl }).then(() => undefined);
  return ready;
}

/** The output-column index (0-based, in the query's projection order — which
 * matches the Arrow result columns *before* hidden columns are dropped) that
 * unambiguously traces back to `track.id`, or `undefined` if none does or more
 * than one does. Mirrors `lineage.rs`'s `Unique` handling: a single match is
 * trusted, an ambiguous mapping is not.
 *
 * Any parse/analysis failure degrades to `undefined` (no double-click
 * affordance), matching the Rust code's fallible-to-default behavior — the WASM
 * itself returns `-1` on a parse failure. */
export async function detectTrackIdColumn(
  sql: string,
): Promise<number | undefined> {
  try {
    await trackLineageReady();
    const idx = detect_track_id_column(sql);
    return idx < 0 ? undefined : idx;
  } catch (err) {
    console.error("lineage analysis failed", err);
    return undefined;
  }
}
