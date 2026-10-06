// Ties the definition flatten (§3.1) to the Querydown compiler (§2). Branches on
// the `assemble` result: full-mode queries go through `compile` with the prelude
// prepended; sectioned queries through `compile_sections` (section-isolated
// parsing) for builder queries.
//
// `compile`/`compile_sections` return a typed `CompileResult` object and THROW
// on failure — we read `.sql` directly (no JSON.parse) and let failures
// propagate (no error UI this phase — see plan non-goals).

import { compile, compile_sections, type CompileResult } from "querydown-js";
import type { Preset } from "api-client";
import { assemble, type QueryDefinition } from "./definition";
import {
  assemblePlaylist,
  playlistQuerydown,
  type PlaylistDefinition,
  type PlaylistQueryOptions,
} from "./playlist";

/** Compiles a saved query definition to DuckDB SQL plus the per-column
 * annotations. Requires the loaded preset list (to resolve preset references) and
 * the enriched schema JSON. Throws on a compile/parse failure or a dangling
 * preset reference.
 *
 * Phase 04 stops discarding `columnAnnotations` (phase 03 read only `.sql`): they
 * are positional — one per output column, aligned with the Arrow result — and
 * drive the grid's widths, fonts, colors, alignment, prefixes/suffixes,
 * formatters, and which columns are hidden.
 *
 * `prelude` is the Querydown prepended to the query — the `querydown_prelude`
 * setting's value in force, which the caller reads from the store. It's a
 * parameter rather than a module constant so that compiling stays a pure
 * function of what it's handed: the user can change the prelude mid-session,
 * and a run must use the value as of that run. */
export function compileSavedQuery(
  def: QueryDefinition,
  presets: Preset[],
  schemaJson: string,
  prelude: string,
): CompileResult {
  const a = assemble(def, presets);
  return a.kind === "full"
    ? compile(schemaJson, "duckdb", `${prelude}\n${a.text}`)
    : compile_sections(
        schemaJson,
        "duckdb",
        a.base,
        prelude,
        a.filter,
        a.sort,
        a.display,
      );
}

/** Compiles playlist `playlistId`'s entry listing (see `playlistQuerydown`) to
 * DuckDB SQL plus its column annotations, taking the same `presets`,
 * `schemaJson` and `prelude` as {@link compileSavedQuery}.
 *
 * The playlist query is one whole query, so it goes through `compile`, not
 * `compile_sections`: a syntax error in the filter text reports as the generic
 * "Invalid querydown code" rather than as one tied to the filter section.
 * `options` narrows it as `playlistQuerydown` does: `withFilter: false`
 * compiles it without the filter, for committing a sort, and `entryId` lists
 * just that entry. */
export function compilePlaylist(
  playlistId: string,
  def: PlaylistDefinition,
  presets: Preset[],
  schemaJson: string,
  prelude: string,
  options: PlaylistQueryOptions = {},
): CompileResult {
  const text = playlistQuerydown(
    playlistId,
    assemblePlaylist(def, presets),
    options,
  );
  return compile(schemaJson, "duckdb", `${prelude}\n${text}`);
}
