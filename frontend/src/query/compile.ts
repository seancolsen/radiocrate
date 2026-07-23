// Ties the definition flatten (§3.1) to the Querydown compiler (§2). Branches on
// the `assemble` result: full-mode queries go through `compile` with the PRELUDE
// prepended; sectioned queries through `compile_sections` (section-isolated
// parsing), the faithful analog of what the egui app did for builder queries.
//
// `compile`/`compile_sections` return a typed `CompileResult` object and THROW
// on failure — we read `.sql` directly (no JSON.parse) and let failures
// propagate (no error UI this phase — see plan non-goals).

import { compile, compile_sections } from "querydown-js";
import type { Preset } from "../api/rpc";
import { assemble, PRELUDE, type QueryDefinition } from "./definition";

/** Compiles a saved query definition to DuckDB SQL. Requires the loaded preset
 * list (to resolve preset references) and the enriched schema JSON. Throws on a
 * compile/parse failure or a dangling preset reference. */
export function compileSavedQuery(
  def: QueryDefinition,
  presets: Preset[],
  schemaJson: string,
): string {
  const a = assemble(def, presets);
  const result =
    a.kind === "full"
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
  return result.sql;
}
