// Ties the definition flatten (§3.1) to the Querydown compiler (§2). Branches on
// the `assemble` result: full-mode queries go through `compile` with the PRELUDE
// prepended; sectioned queries through `compile_sections` (section-isolated
// parsing), the faithful analog of what the egui app did for builder queries.
//
// `compile`/`compile_sections` return a typed `CompileResult` object and THROW
// on failure — we read `.sql` directly (no JSON.parse) and let failures
// propagate (no error UI this phase — see plan non-goals).

import { compile, compile_sections, type CompileResult } from "querydown-js";
import type { Preset } from "api-client";
import { assemble, PRELUDE, type QueryDefinition } from "./definition";

/** Compiles a saved query definition to DuckDB SQL plus the per-column
 * annotations. Requires the loaded preset list (to resolve preset references) and
 * the enriched schema JSON. Throws on a compile/parse failure or a dangling
 * preset reference.
 *
 * Phase 04 stops discarding `columnAnnotations` (phase 03 read only `.sql`): they
 * are positional — one per output column, aligned with the Arrow result — and
 * drive the grid's widths, fonts, colors, alignment, prefixes/suffixes,
 * formatters, and which columns are hidden. */
export function compileSavedQuery(
  def: QueryDefinition,
  presets: Preset[],
  schemaJson: string,
): CompileResult {
  const a = assemble(def, presets);
  return a.kind === "full"
    ? compile(schemaJson, "duckdb", `${PRELUDE}\n${a.text}`)
    : compile_sections(
        schemaJson,
        "duckdb",
        a.base,
        PRELUDE,
        a.filter,
        a.sort,
        a.display,
      );
}
