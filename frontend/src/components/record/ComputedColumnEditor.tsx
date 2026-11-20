import { forwardRef, useEffect, useMemo } from "react";
import { Icons } from "../../icons";
import { checkComputedColumn } from "../../query/compile";
import { builtInExpression, hasExpression } from "../../query/computedColumns";
import { composePrelude, generatedPrelude } from "../../query/tableSettings";
import { selectComputedExpression, selectUserPrelude } from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import DiagnosticMessage from "../builder/DiagnosticMessage";
import QuerydownEditor from "../builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "../builder/useDiagnostics";

const TOOLBAR_BUTTON =
  "text-ink hover:bg-hover flex h-[26px] shrink-0 items-center gap-1.5 rounded px-2 text-sm disabled:opacity-40 disabled:hover:bg-transparent";

/** The editor of a computed column's expression, wherever it's edited: under
 * the column's field in the record editor, and under its row on the Data
 * structure page — in both, what opening the field or row shows, and gone when
 * it closes. "Reset to default", for one of the app's own columns, over the
 * expression, with a problem with it below.
 *
 * The expression is checked as it's typed: compiled as the column's
 * definition, under the rest of the prelude, in a query that displays the
 * column. What's typed is the column's at once, in every query compiled from
 * then on, and is written once the app goes quiet, or as the editor goes away.
 *
 * The ref forwards to the element that takes the caret, so a caller can focus
 * it. */
const ComputedColumnEditor = forwardRef<
  HTMLElement,
  {
    table: string;
    name: string;
    /** Escape, in the text. */
    onEscape: () => void;
  }
>(function ComputedColumnEditor(props, ref) {
  const { table, name } = props;
  const stored = useApp((s) => selectComputedExpression(s, table, name));
  const builtIn = builtInExpression(table, name);
  const text = stored ?? builtIn ?? "";
  const tables = useApp((s) => s.schema.tables);
  const settings = useApp((s) => s.tableSettings.data);
  const computed = useApp((s) => s.computedColumns.data);
  const comparisons = useApp((s) => s.customComparisons.data);
  const user = useApp(selectUserPrelude);
  const { setComputedColumnExpression, flushComputedColumn } = useAppActions();
  // Nothing typed waits on the idle queue once the editor has gone.
  useEffect(
    () => () => flushComputedColumn(table, name),
    [table, name, flushComputedColumn],
  );

  // Everything the column is compiled under, but for its own definition, which
  // the check puts last.
  const prelude = useMemo(
    () =>
      composePrelude(
        generatedPrelude(tables, settings, computed, comparisons, {
          table,
          computedColumn: name,
        }),
        user,
      ),
    [tables, settings, computed, comparisons, table, name, user],
  );
  const schemaJson = useCheckContext()?.schemaJson;
  const blank = !hasExpression(text);
  const latest = useMemo(
    () =>
      schemaJson === undefined || blank
        ? null
        : checkComputedColumn(schemaJson, table, name, text, prelude),
    [schemaJson, blank, table, name, text, prelude],
  );
  const problem = useSettledDiagnostic(latest);

  return (
    <div className="py-1 pr-1 pl-5" data-testid="computed-column-editor">
      {builtIn !== null && (
        <div className="flex items-center gap-1 pb-1">
          <button
            type="button"
            disabled={stored == null}
            className={TOOLBAR_BUTTON}
            onClick={() => setComputedColumnExpression(table, name, null)}
          >
            <Icons.Revert className="text-ink-weak size-4" />
            Reset to default
          </button>
        </div>
      )}
      <QuerydownEditor
        ref={ref}
        label={`Expression of ${name}`}
        value={text}
        context={{
          grammar: "conditions",
          baseTable: table,
          definitions: prelude.text,
        }}
        onChange={(next) => setComputedColumnExpression(table, name, next)}
        diagnostic={problem?.origin?.kind === "computedColumn" ? problem : null}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          props.onEscape();
        }}
      />
      {blank && (
        <p className="text-ink-weak px-1 pt-1 text-xs">
          {builtIn === null
            ? `Blank: ${name} isn’t defined yet.`
            : "Blank: the default is used."}
        </p>
      )}
      {problem && (
        <div className="pt-1">
          <DiagnosticMessage diagnostic={problem} place="Expression" />
        </div>
      )}
    </div>
  );
});

export default ComputedColumnEditor;
