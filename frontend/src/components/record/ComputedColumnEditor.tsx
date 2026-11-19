import { forwardRef, useEffect, useMemo, type JSX } from "react";
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
import HelpPopover from "../ui/HelpPopover";
import IconButton from "../ui/IconButton";

const TOOLBAR_BUTTON =
  "text-ink hover:bg-hover flex h-[26px] shrink-0 items-center gap-1.5 rounded px-2 text-sm disabled:opacity-40 disabled:hover:bg-transparent";

/** A computed column's help: what its expression is, behind the "?". */
function ComputedColumnHelp(props: {
  table: string;
  name: string;
  builtIn: boolean;
}): JSX.Element {
  const { table, name } = props;
  const code = (text: string) => (
    <code className="bg-hover rounded px-0.5 font-mono text-xs">{text}</code>
  );
  return (
    <>
      <p>
        What {code(name)} is, for each record of {table}: one Querydown
        expression, written as it would be in a query on {table}. With{" "}
        {code("album.year")}, a query can display {code(`$${name}`)} or filter
        by {code(`${name}:>2000`)}, as if it were a column.
      </p>
      <p className="mt-2">
        It can count or summarize related records ({code("#play")},{" "}
        {code("#play.timestamp%max")}), and use the table’s other computed
        columns by name.
      </p>
      <p className="mt-2">
        {props.builtIn
          ? `Left blank, or reset, it’s the app’s own expression for ${name}.`
          : `Left blank, ${name} isn’t defined, and a query that uses it won’t run.`}
      </p>
    </>
  );
}

/** The editor of a computed column's expression, wherever it's edited: under
 * the column's field in the record editor, and under its row on the Data
 * structure page. A toolbar — "Reset to default", for one of the app's own
 * columns; a "?"; and the × when there's a way out — over the expression, with
 * a problem with it below.
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
    /** The way out, as an × at the toolbar's end. Absent, there's none: the
     * editor goes when what holds it closes. */
    onClose?: () => void;
    /** Escape, in the text. */
    onEscape: () => void;
  }
>(function ComputedColumnEditor(props, ref) {
  const { table, name, onClose } = props;
  const stored = useApp((s) => selectComputedExpression(s, table, name));
  const builtIn = builtInExpression(table, name);
  const text = stored ?? builtIn ?? "";
  const tables = useApp((s) => s.schema.tables);
  const settings = useApp((s) => s.tableSettings.data);
  const computed = useApp((s) => s.computedColumns.data);
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
        generatedPrelude(tables, settings, computed, {
          table,
          computedColumn: name,
        }),
        user,
      ),
    [tables, settings, computed, table, name, user],
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
      <div className="flex items-center gap-1 pb-1">
        {builtIn !== null && (
          <button
            type="button"
            disabled={stored == null}
            className={TOOLBAR_BUTTON}
            onClick={() => setComputedColumnExpression(table, name, null)}
          >
            <Icons.Revert className="text-ink-weak size-4" />
            Reset to default
          </button>
        )}
        {onClose && <div className="flex-1" />}
        <HelpPopover
          label="About computed columns"
          align={onClose ? "end" : undefined}
        >
          <ComputedColumnHelp
            table={table}
            name={name}
            builtIn={builtIn !== null}
          />
        </HelpPopover>
        {onClose && (
          <IconButton
            icon={Icons.Close}
            label="Close expression editor"
            onClick={onClose}
          />
        )}
      </div>
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
