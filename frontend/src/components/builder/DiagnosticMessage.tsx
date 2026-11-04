import type { JSX, ReactNode } from "react";
import { Icons } from "../../icons";
import { sectionLabel } from "../../query/definition";
import {
  lineColumn,
  type QueryDiagnostic,
  type TextRange,
} from "../../query/diagnostics";

/** Where a problem is, in words: the editor it's in. `presetName` names the
 * preset, for a problem in one. */
export function diagnosticPlace(
  d: QueryDiagnostic,
  presetName?: string,
): string {
  const origin = d.origin;
  if (origin?.kind === "custom") return sectionLabel(origin.section);
  if (origin?.kind === "preset") {
    return presetName ? `Preset “${presetName}”` : "Preset";
  }
  if (origin?.kind === "prelude") return "Querydown prelude";
  if (origin?.kind === "full") return "Querydown";
  return d.kind === "run" ? "Database" : "Query";
}

/** `text` with its `backticked` stretches set as code — how the compiler
 * quotes Querydown in its messages. */
function withCode(text: string): ReactNode[] {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="font-mono">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** "line 2, column 7", for where `range` starts in `source`. */
function where(source: string, range: TextRange): string {
  const { line, column } = lineColumn(source, range.start);
  return `line ${line}, column ${column}`;
}

/** The line of `source` that `range` starts on, over a row of carets
 * marking the range (to the line's end, at most; one caret for an empty
 * range). Tabs before the range are kept in the marker row so it lines up. */
function Excerpt(props: { source: string; range: TextRange }): JSX.Element {
  const { source, range } = props;
  const lineStart = source.lastIndexOf("\n", range.start - 1) + 1;
  const newline = source.indexOf("\n", range.start);
  const lineEnd = newline === -1 ? source.length : newline;
  const line = source.slice(lineStart, lineEnd);
  const lead = source.slice(lineStart, range.start).replace(/[^\t]/g, " ");
  const width = Math.max(1, Math.min(range.end, lineEnd) - range.start);
  return (
    <pre className="bg-sheet text-ink mt-1 overflow-x-auto rounded px-2 py-1 font-mono text-xs leading-4">
      {line}
      {"\n"}
      <span className="text-danger">
        {lead}
        {"^".repeat(width)}
      </span>
    </pre>
  );
}

/** A problem with some Querydown, as everything that edits Querydown shows
 * one: where it is (`place`, and the line and column), what's wrong, the line
 * in question with the spot marked, any further places it involves, and the
 * compiler's hint. `actions` sit at the right — a way to go to it, say. */
export default function DiagnosticMessage(props: {
  diagnostic: QueryDiagnostic;
  place: string;
  actions?: ReactNode;
}): JSX.Element {
  const d = props.diagnostic;
  return (
    <div role="alert" className="flex items-start gap-2 text-xs leading-5">
      <Icons.QueryError className="text-danger mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>
          <span className="text-ink font-semibold">{props.place}</span>
          {d.range && (
            <span className="text-ink-weak"> · {where(d.source, d.range)}</span>
          )}
        </p>
        <p className="text-danger break-words">{withCode(d.reason)}</p>
        {d.range && <Excerpt source={d.source} range={d.range} />}
        {d.notes.map((note) => (
          <p
            key={`${note.range.start}:${note.message}`}
            className="text-ink-weak"
          >
            {where(d.source, note.range)}: {withCode(note.message)}
          </p>
        ))}
        {d.hint && (
          <p className="text-ink-weak">
            <span className="font-semibold">Hint:</span> {withCode(d.hint)}
          </p>
        )}
      </div>
      {props.actions && <div className="shrink-0">{props.actions}</div>}
    </div>
  );
}
