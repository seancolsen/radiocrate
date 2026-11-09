// What went wrong with a query, in terms of what the user can edit.
//
// The compiler's errors (`QuerydownError`) point into the text it was handed,
// which the app stitched together (see `sourceMap.ts`). A `QueryDiagnostic`
// is the same problem traced back to the editor it came from — a section's
// custom text, a preset, the prelude — with its location inside that editor's
// own text. The query's other failures (a dangling preset, a missing base
// table, an error from the database) become diagnostics too, so there's one
// shape for everything the error strip shows.

import type { QuerydownError, QuerydownSection } from "querydown-js";
import {
  locate,
  locateWithin,
  sameOrigin,
  type Mapped,
  type SourceOrigin,
} from "./sourceMap";

/** What sort of problem a {@link QueryDiagnostic} is:
 *
 * - the compiler's own kinds — `"syntax"` (the text doesn't parse; always
 *   located), `"compile"` (it parses, but doesn't fit the schema), and
 *   `"schema"` / `"argument"` (the app handed the compiler something bad);
 * - `"definition"`: the query can't be put together to be compiled: it uses a
 *   preset that's gone;
 * - `"incomplete"`: there's nothing to compile yet — no base table chosen, or
 *   a full query emptied. Nothing's wrong with what's been written, so it's
 *   never shown as an error (see {@link shownProblem});
 * - `"run"`: it compiled, but the database refused the SQL. */
export type DiagnosticKind =
  QuerydownError["kind"] | "definition" | "incomplete" | "run";

/** A stretch of an editor's text, in UTF-16 offsets (string indexes), from
 * `start` inclusive to `end` exclusive. Empty where the problem is a
 * position — the end of the input, say. */
export interface TextRange {
  start: number;
  end: number;
}

/** A further place in the same editor's text the problem involves — where an
 * unclosed bracket was opened, say. */
export interface DiagnosticNote {
  range: TextRange;
  message: string;
}

/** A problem with a query, traced back to the editor it came from. */
export interface QueryDiagnostic {
  kind: DiagnosticKind;
  /** The problem, on its own: no editor, no location. */
  reason: string;
  /** How to fix it, when the compiler has a suggestion. */
  hint: string | null;
  /** The editor whose text the problem is in; `null` when it can't be put
   * down to one: the compiler gave no location (a base table that doesn't
   * exist), the location is in text the app wrote (a playlist's
   * scaffolding), or the problem isn't the compiler's (a database's
   * refusal). */
  origin: SourceOrigin | null;
  /** That editor's text, as it was compiled — what `range` and the notes'
   * ranges index into. Empty when there's no origin. */
  source: string;
  /** Where in `source` the problem is, when it's known. */
  range: TextRange | null;
  notes: readonly DiagnosticNote[];
}

/** An error carrying a {@link QueryDiagnostic}: what the compile path throws,
 * so its callers can show the problem rather than just log it. */
export class DiagnosticError extends Error {
  readonly diagnostic: QueryDiagnostic;
  constructor(diagnostic: QueryDiagnostic) {
    super(diagnostic.reason);
    this.name = "DiagnosticError";
    this.diagnostic = diagnostic;
  }
}

/** A problem with how the query is put together, before any compiling:
 * `"definition"` or `"incomplete"`. */
export function definitionError(
  kind: "definition" | "incomplete",
  reason: string,
  origin: SourceOrigin | null = null,
): DiagnosticError {
  return new DiagnosticError({
    kind,
    reason,
    hint: null,
    origin,
    source: "",
    range: null,
    notes: [],
  });
}

/** Traces a compiler error back to an editor. `textFor` gives the text the
 * compiler was handed for the error's section (`null` for a whole-query
 * compile) — what its span indexes into — or `undefined` if there's no
 * telling. */
export function fromQuerydownError(
  err: QuerydownError,
  textFor: (section: QuerydownSection | null) => Mapped | undefined,
): QueryDiagnostic {
  const unlocated: QueryDiagnostic = {
    kind: err.kind,
    reason: err.reason,
    hint: err.hint,
    origin: null,
    source: "",
    range: null,
    notes: [],
  };
  const text = err.span ? textFor(err.section) : undefined;
  const start =
    err.span && text ? locate(text, err.span.start.offset) : undefined;
  if (!err.span || !text || !start) return unlocated;

  const { segment } = start;
  const range = (span: NonNullable<QuerydownError["span"]>): TextRange => ({
    start: locateWithin(segment, span.start.offset),
    end: locateWithin(segment, span.end.offset),
  });
  const notes: DiagnosticNote[] = [];
  for (const label of err.labels) {
    const at = locate(text, label.span.start.offset);
    if (at?.segment !== segment) continue; // in another editor's text
    notes.push({ range: range(label.span), message: label.message });
  }
  return {
    ...unlocated,
    origin: segment.origin,
    source: segment.source,
    range: {
      start: start.offset,
      end: locateWithin(segment, err.span.end.offset),
    },
    notes,
  };
}

/** Any error from compiling or running a query, as a diagnostic: the one a
 * {@link DiagnosticError} carries, or else the database's (or the network's)
 * refusal, which can't be put down to an editor. */
export function toDiagnostic(err: unknown): QueryDiagnostic {
  if (err instanceof DiagnosticError) return err.diagnostic;
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: "run",
    // The query endpoint's errors lead with their HTTP status ("400 Binder
    // Error: …"), which says nothing the reason doesn't.
    reason: message.replace(/^\d{3} /, ""),
    hint: null,
    origin: null,
    source: "",
    range: null,
    notes: [],
  };
}

/** `diagnostic`, if it's a problem to show the user: anything but an
 * `"incomplete"` query. */
export function shownProblem(
  diagnostic: QueryDiagnostic | null,
): QueryDiagnostic | null {
  return diagnostic?.kind === "incomplete" ? null : diagnostic;
}

/** Whether two diagnostics report the same problem in the same place — the
 * same complaint about the same editor, though perhaps at a moved position as
 * the text around it changes. */
export function sameProblem(a: QueryDiagnostic, b: QueryDiagnostic): boolean {
  return (
    a.kind === b.kind && a.reason === b.reason && sameOrigin(a.origin, b.origin)
  );
}

/** Whether two diagnostics say exactly the same thing — the same problem at
 * the same position in the same text. */
export function sameDiagnostic(
  a: QueryDiagnostic | null,
  b: QueryDiagnostic | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    sameProblem(a, b) &&
    a.source === b.source &&
    a.range?.start === b.range?.start &&
    a.range?.end === b.range?.end
  );
}

/** How long typing has to pause before a new problem with what's being typed
 * is shown. Long enough that a word half-typed doesn't flash an error for the
 * moment it's incomplete; short enough that a real mistake is pointed out
 * while the user is still looking at it. */
export const DIAGNOSTIC_SETTLE_MS = 700;

/** What an error display shows as an edit changes the problem from the one it
 * shows (`shown`) to `latest`: slow to complain, quick to forgive.
 *
 * - Fixing the problem clears it at once — but a database's refusal
 *   (`"run"`) stands until the next run says otherwise, since the text
 *   compiling again says nothing about whether the database will take it.
 * - The same problem, moved along by the typing, is shown as it now stands.
 * - A new problem waits (`settle`) for a pause in the typing: what's shown
 *   meanwhile is what was shown before. */
export function nextShown(
  shown: QueryDiagnostic | null,
  latest: QueryDiagnostic | null,
): { show: QueryDiagnostic | null; settle: boolean } {
  if (latest === null) {
    return { show: shown?.kind === "run" ? shown : null, settle: false };
  }
  if (shown !== null && sameProblem(shown, latest)) {
    return { show: latest, settle: false };
  }
  return { show: shown, settle: true };
}

/** The 1-based line and column of `offset` in `text`, counting columns in
 * UTF-16 units, as the compiler does. */
export function lineColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return {
    line: before.split("\n").length,
    column: offset - lineStart + 1,
  };
}
