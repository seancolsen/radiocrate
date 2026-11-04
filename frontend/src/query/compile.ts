// Ties the definition flatten (§3.1) to the Querydown compiler (§2). Branches on
// the `assemble` result: full-mode queries go through `compile` with the prelude
// prepended; sectioned queries through `compile_sections` (section-isolated
// parsing) for builder queries.
//
// `compile`/`compile_sections` return a typed `CompileResult` object and THROW
// on failure. Every failure leaves here as a `DiagnosticError`: the compiler's
// error traced back to the editor whose text it's about (see `diagnostics.ts`),
// so the caller can show it there.

import {
  compile,
  compile_sections,
  is_querydown_error,
  type CompileResult,
  type QuerydownSection,
} from "querydown-js";
import type { Preset } from "api-client";
import {
  assemble,
  resolveFilterParts,
  type FilterParts,
  type QueryDefinition,
  type Section,
} from "./definition";
import {
  DiagnosticError,
  fromQuerydownError,
  toDiagnostic,
  type QueryDiagnostic,
} from "./diagnostics";
import {
  assemblePlaylist,
  playlistQuerydownMapped,
  type PlaylistDefinition,
  type PlaylistQueryOptions,
} from "./playlist";
import {
  fromSource,
  joinMapped,
  sameOrigin,
  unmapped,
  type Mapped,
  type SourceOrigin,
} from "./sourceMap";

const PRELUDE: SourceOrigin = { kind: "prelude" };

/** Runs a compile, turning a compiler error into a {@link DiagnosticError}
 * traced through `textFor` (see `fromQuerydownError`). */
function diagnosed(
  run: () => CompileResult,
  textFor: (section: QuerydownSection | null) => Mapped | undefined,
): CompileResult {
  try {
    return run();
  } catch (err) {
    if (!is_querydown_error(err)) throw err;
    throw new DiagnosticError(fromQuerydownError(err, textFor));
  }
}

/** Compiles the sections of a query on `base`, each mapped back to the
 * editors it came from. */
function compileSections(
  schemaJson: string,
  base: string,
  prelude: string,
  sections: { filter: Mapped; sort: Mapped; display: Mapped },
): CompileResult {
  const texts: Record<QuerydownSection, Mapped> = {
    definitions: fromSource(prelude, PRELUDE),
    conditions: sections.filter,
    sorting: sections.sort,
    display: sections.display,
  };
  return diagnosed(
    () =>
      compile_sections(
        schemaJson,
        "duckdb",
        base,
        prelude,
        sections.filter.text,
        sections.sort.text,
        sections.display.text,
      ),
    (section) => (section ? texts[section] : undefined),
  );
}

/** Compiles a whole query, `text`, with the prelude prepended. */
function compileWhole(
  schemaJson: string,
  prelude: string,
  text: Mapped,
): CompileResult {
  const whole = joinMapped([fromSource(prelude, PRELUDE), text], "\n");
  return diagnosed(
    () => compile(schemaJson, "duckdb", whole.text),
    () => whole,
  );
}

/** Rethrows `err`, a failure to compile a query whose filter is `filter`,
 * as the problem it's really about.
 *
 * A filter's parts — its custom conditions, then each preset — are joined
 * into one text, and the parser reads straight on from one into the next: a
 * condition left without its value (`year:`) takes the start of the next part
 * as one, and the error turns up further on, in a part that's fine. So when a
 * syntax error lands in a part after the first, each part before it is
 * compiled alone (through `compileFilter`), and the first that has a syntax
 * error of its own is the problem. If none has, `err` stands. */
function retraceFilterError(
  err: unknown,
  filter: FilterParts,
  presets: readonly Preset[],
  compileFilter: (part: Mapped) => void,
): never {
  if (!(err instanceof DiagnosticError) || err.diagnostic.kind !== "syntax") {
    throw err;
  }
  const parts = resolveFilterParts(filter, presets);
  const origin = err.diagnostic.origin;
  const at = parts.findIndex((part) =>
    part.segments.some((seg) => sameOrigin(seg.origin, origin)),
  );
  for (const part of parts.slice(0, Math.max(at, 0))) {
    try {
      compileFilter(part);
    } catch (alone) {
      if (
        alone instanceof DiagnosticError &&
        alone.diagnostic.kind === "syntax"
      ) {
        throw alone;
      }
    }
  }
  throw err;
}

/** Compiles a saved query definition to DuckDB SQL plus the per-column
 * annotations. Requires the loaded preset list (to resolve preset references) and
 * the enriched schema JSON. Throws a `DiagnosticError` on a compile/parse
 * failure or a dangling preset reference.
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
  if (a.kind === "full") return compileWhole(schemaJson, prelude, a.text);
  try {
    return compileSections(schemaJson, a.base, prelude, a);
  } catch (err) {
    retraceFilterError(err, def.filter, presets, (part) =>
      compileSections(schemaJson, a.base, prelude, {
        filter: part,
        sort: unmapped(""),
        display: unmapped(""),
      }),
    );
  }
}

/** Compiles playlist `playlistId`'s entry listing (see `playlistQuerydown`) to
 * DuckDB SQL plus its column annotations, taking the same `presets`,
 * `schemaJson` and `prelude` as {@link compileSavedQuery}.
 *
 * The playlist query is one whole query, so it goes through `compile`, not
 * `compile_sections`: a syntax error in the filter text isn't tied to the
 * filter section by the compiler, but the source map still traces it there.
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
  const text = playlistQuerydownMapped(
    playlistId,
    assemblePlaylist(def, presets),
    options,
  );
  try {
    return compileWhole(schemaJson, prelude, text);
  } catch (err) {
    retraceFilterError(err, def.filter, presets, (part) =>
      compileWhole(
        schemaJson,
        prelude,
        playlistQuerydownMapped(
          playlistId,
          { filter: part, sort: "", display: "" },
          options,
        ),
      ),
    );
  }
}

/** The table {@link checkPrelude} compiles its query on. Every RadioCrate
 * database has it, and it's small. */
const PRELUDE_CHECK_BASE = "role";

/** The problem with `prelude`, if it has one, as the prelude editor checks it
 * while it's typed in: compiled as the definitions of a trivial query
 * (`#role $%count`), since a prelude on its own isn't one. A definition is
 * only resolved against the schema where a query uses it, so what this
 * catches is what's wrong with the prelude's text itself. */
export function checkPrelude(
  schemaJson: string,
  prelude: string,
): QueryDiagnostic | null {
  try {
    compileSections(schemaJson, PRELUDE_CHECK_BASE, prelude, {
      filter: unmapped(""),
      sort: unmapped(""),
      display: unmapped("$%count"),
    });
    return null;
  } catch (err) {
    return toDiagnostic(err);
  }
}

/** The problem with a preset's definition, `text`, if it has one: compiled as
 * `section` of a query on the preset's table (under `prelude`), alone. The
 * problem is traced to `origin` — the preset, or the new one being written. */
export function checkFragment(
  schemaJson: string,
  prelude: string,
  baseTable: string,
  section: Section,
  text: string,
  origin: SourceOrigin,
): QueryDiagnostic | null {
  const empty = unmapped("");
  const fragment = fromSource(text, origin);
  try {
    compileSections(schemaJson, baseTable, prelude, {
      filter: section === "filter" ? fragment : empty,
      sort: section === "sort" ? fragment : empty,
      display: section === "display" ? fragment : empty,
    });
    return null;
  } catch (err) {
    return toDiagnostic(err);
  }
}
