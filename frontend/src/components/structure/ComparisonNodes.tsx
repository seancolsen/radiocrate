import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from "react";
import { Icons } from "../../icons";
import { checkComparison } from "../../query/compile";
import {
  builtInComparison,
  COMPARED_VARIABLE,
  DEFAULT_COMPARISON_NAME,
  hasCondition,
  isComparisonCustomized,
  tableComparisons,
} from "../../query/customComparisons";
import { comparisonItemId, comparisonsItemId } from "../../query/structure";
import { composePrelude, generatedPrelude } from "../../query/tableSettings";
import {
  selectComparisonExpression,
  selectUserPrelude,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import DiagnosticMessage from "../builder/DiagnosticMessage";
import QuerydownEditor from "../builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "../builder/useDiagnostics";
import {
  LabelNameInput,
  type LabelRename,
  type RenameEnd,
} from "../record/FieldLabel";
import { ContextMenu } from "../ui/ContextMenu";
import HelpPopover from "../ui/HelpPopover";
import IconButton from "../ui/IconButton";
import { MenuItem } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import {
  TreeCount,
  TreeEmpty,
  TreeNode,
  TreeNote,
  useFocusOnReveal,
} from "./Tree";

// A table's custom comparisons, under "Query settings" on the Data structure
// page (`query/customComparisons.ts`): the app's own, which can be given a
// condition of the user's but not renamed or removed, then the user's. The
// list's "+" adds one, named first; each opens into its condition's editor, and
// one of the user's is renamed or removed from its context menu.
//
// What's typed is the comparison's at once, and written once the app goes
// quiet, or as the editor goes away. "Reset to default" goes back to the app's
// own condition.

const TOOLBAR_BUTTON =
  "text-ink hover:bg-hover flex h-[26px] shrink-0 items-center gap-1.5 rounded px-2 text-sm disabled:opacity-40 disabled:hover:bg-transparent";

/** The name of a comparison, as a filter says it, or the input it's being
 * renamed in. */
const NAME_CLASS = "text-ink min-w-0 truncate font-mono text-sm";

/** Gives the keyboard back to the row of the item `el` is under: the way out of
 * an editor, on Escape. */
function focusOwnRow(el: HTMLElement | null): void {
  el?.closest("[data-tree-node]")
    ?.querySelector<HTMLElement>("[data-tree-item]")
    ?.focus();
}

/** A comparison's help, behind its "?". */
function ComparisonHelp(props: { table: string; name: string }): JSX.Element {
  const code = (text: string) => (
    <code className="bg-hover rounded px-0.5 font-mono text-xs">{text}</code>
  );
  return (
    <p>
      When a Querydown filter for {code(props.table)} records compares{" "}
      {code(props.name)} with a value, as in {code(`${props.name}:foo`)}, this
      condition is what's tested, with {code(COMPARED_VARIABLE)} standing for
      the value.
    </p>
  );
}

/** The editor of a comparison's condition: its toolbar, the condition, and a
 * problem with it. The condition is checked as it's typed, compiled into a
 * query on the table that compares by it, under the rest of the prelude. */
function ComparisonEditor(props: {
  itemId: string;
  table: string;
  name: string;
}): JSX.Element {
  const { table, name } = props;
  const stored = useApp((s) => selectComparisonExpression(s, table, name));
  const builtIn = builtInComparison(table, name);
  const text = stored ?? builtIn ?? "";
  const tables = useApp((s) => s.schema.tables);
  const settings = useApp((s) => s.tableSettings.data);
  const computed = useApp((s) => s.computedColumns.data);
  const comparisons = useApp((s) => s.customComparisons.data);
  const user = useApp(selectUserPrelude);
  const { setCustomComparisonExpression, flushCustomComparison } =
    useAppActions();
  // Nothing typed waits on the idle queue once the editor has gone.
  useEffect(
    () => () => flushCustomComparison(table, name),
    [table, name, flushCustomComparison],
  );

  // Everything the comparison runs under, but for its own definition, which
  // the check puts last.
  const prelude = useMemo(
    () =>
      composePrelude(
        generatedPrelude(tables, settings, computed, comparisons, {
          table,
          comparison: name,
        }),
        user,
      ),
    [tables, settings, computed, comparisons, table, name, user],
  );
  const schemaJson = useCheckContext()?.schemaJson;
  const blank = !hasCondition(text);
  const latest = useMemo(
    () =>
      schemaJson === undefined || blank
        ? null
        : checkComparison(schemaJson, table, name, text, prelude),
    [schemaJson, blank, table, name, text, prelude],
  );
  const problem = useSettledDiagnostic(latest);

  // The caret comes here when the user was sent for the comparison: an error
  // strip's "Edit custom comparison", or one just added.
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  useFocusOnReveal(props.itemId, editorRef);

  return (
    <div
      ref={wrapRef}
      className="py-1 pr-1 pl-5"
      data-testid="comparison-editor"
    >
      <div className="flex items-center gap-1 pb-1">
        {builtIn !== null && (
          <button
            type="button"
            disabled={stored == null}
            className={TOOLBAR_BUTTON}
            onClick={() => setCustomComparisonExpression(table, name, null)}
          >
            <Icons.Revert className="text-ink-weak size-4" />
            Reset to default
          </button>
        )}
        <HelpPopover label="About custom comparisons">
          <ComparisonHelp table={table} name={name} />
        </HelpPopover>
      </div>
      <QuerydownEditor
        ref={editorRef}
        label={`Condition of ${name} on ${table}`}
        value={text}
        context={{
          grammar: "conditions",
          baseTable: table,
          definitions: prelude.text,
        }}
        onChange={(next) => setCustomComparisonExpression(table, name, next)}
        diagnostic={
          problem?.origin?.kind === "customComparison" ? problem : null
        }
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          focusOwnRow(wrapRef.current);
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
          <DiagnosticMessage diagnostic={problem} place="Condition" />
        </div>
      )}
    </div>
  );
}

/** What's said beside one of the app's own comparisons: whether the condition
 * in force is the user's or the app's. */
function ComparisonNote(props: { table: string; name: string }): JSX.Element {
  const customized = useApp((s) =>
    isComparisonCustomized(s.customComparisons.data, props.table, props.name),
  );
  return <TreeNote>{customized ? "Customized" : "Built-in"}</TreeNote>;
}

/** One comparison: its name — or, while it's being renamed, the input it's
 * typed in — opening into its condition's editor. */
function ComparisonNode(props: {
  table: string;
  name: string;
  builtIn: boolean;
  rename?: LabelRename;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
}): JSX.Element {
  const { table, name } = props;
  const id = comparisonItemId(table, name);
  return (
    <TreeNode
      id={id}
      expandable
      onContextMenu={props.onContextMenu}
      label={
        <>
          <Icons.CustomComparison className="text-ink-weak size-4 shrink-0" />
          {props.rename ? (
            <span className={NAME_CLASS}>
              <LabelNameInput
                label={`Name of ${name}`}
                name={name}
                rename={props.rename}
              />
            </span>
          ) : (
            <span className={NAME_CLASS}>{name}</span>
          )}
          {props.builtIn && <ComparisonNote table={table} name={name} />}
        </>
      }
    >
      <ComparisonEditor itemId={id} table={table} name={name} />
    </TreeNode>
  );
}

/** A comparison being added: its name, being typed where its row will be.
 * Settling on one makes the comparison; Escape drops it, and so does leaving it
 * without having typed anything. */
function ProvisionalComparisonRow(props: {
  onName: (name: string, end: RenameEnd) => void;
  onDiscard: () => void;
}): JSX.Element {
  return (
    <div
      className="flex h-[30px] items-center gap-1.5"
      data-testid="provisional-comparison"
    >
      <span className="size-4 shrink-0" aria-hidden="true" />
      <Icons.CustomComparison className="text-ink-weak -ml-0.5 size-4 shrink-0" />
      <span className={NAME_CLASS}>
        <LabelNameInput
          label="Name of the new custom comparison"
          name={DEFAULT_COMPARISON_NAME}
          rename={{
            onCommit: (name, end) => {
              // Focus going elsewhere with the name as it was offered is the
              // user thinking better of it, not naming it that.
              if (end === "blur" && name === DEFAULT_COMPARISON_NAME) {
                props.onDiscard();
              } else {
                props.onName(name, end);
              }
            },
            onCancel: () => props.onDiscard(),
          }}
        />
      </span>
    </div>
  );
}

/** The confirmation before removing one of the user's comparisons. */
function RemoveComparisonModal(props: {
  comparison: { table: string; name: string } | null;
  onClose: () => void;
}): JSX.Element | null {
  const { comparison, onClose } = props;
  const { removeCustomComparison } = useAppActions();
  if (comparison === null) return null;
  return (
    <Modal onClose={onClose} width="320px">
      <h2 className="text-ink mb-3 text-base font-semibold">
        Remove custom comparison
      </h2>
      <p className="text-ink text-sm">
        Remove{" "}
        <span className="font-medium">&ldquo;{comparison.name}&rdquo;</span>{" "}
        from {comparison.table}? A query that compares by it will stop working.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="control text-ink hover:bg-hover rounded-md"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="control bg-danger rounded-md text-white"
          onClick={() => {
            onClose();
            removeCustomComparison(comparison.table, comparison.name);
          }}
        >
          Remove
        </button>
      </div>
    </Modal>
  );
}

/** A table's "Custom comparisons": how many it has, the "+" that adds one,
 * and the comparisons. */
export function CustomComparisonsNode(props: { table: string }): JSX.Element {
  const { table } = props;
  const rows = useApp((s) => s.customComparisons.data);
  const comparisons = useMemo(
    () => tableComparisons(table, rows),
    [table, rows],
  );
  const {
    addCustomComparison,
    renameCustomComparison,
    revealStructureItem,
    setStructureExpanded,
  } = useAppActions();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);
  const menuComparison = comparisons.find((c) => c.name === menu?.name);

  /** Ends a rename: the keyboard goes back to the row of the comparison —
   * unless the user went somewhere else, which is where it stays. */
  const renamed = (name: string, end: RenameEnd | null) => {
    setRenaming(null);
    if (end === "blur") return;
    const selector = `[data-item-id="${CSS.escape(comparisonItemId(table, name))}"] > [data-tree-item]`;
    queueMicrotask(() =>
      document.querySelector<HTMLElement>(selector)?.focus(),
    );
  };

  const id = comparisonsItemId(table);
  return (
    <>
      <TreeNode
        id={id}
        expandable
        label={
          <>
            <Icons.CustomComparisons className="text-ink-weak size-4 shrink-0" />
            <span className="text-ink min-w-0 truncate text-sm">
              Custom comparisons
            </span>
            <TreeCount
              n={comparisons.length}
              one="comparison"
              many="comparisons"
            />
          </>
        }
        actions={
          <IconButton
            icon={Icons.Add}
            size="sm"
            label={`New custom comparison for ${table}`}
            onClick={() => {
              // It goes in the list, which has to be on show for that.
              setStructureExpanded([id], true);
              setAdding(true);
            }}
          />
        }
      >
        {comparisons.map((c) => (
          <ComparisonNode
            key={c.name}
            table={table}
            name={c.name}
            builtIn={c.builtIn}
            rename={
              renaming === c.name
                ? {
                    onCommit: (typed, end) =>
                      renamed(
                        renameCustomComparison(table, c.name, typed),
                        end,
                      ),
                    onCancel: () => renamed(c.name, null),
                  }
                : undefined
            }
            onContextMenu={(e) => {
              e.preventDefault();
              // The app's own can't be renamed or removed: there's nothing to
              // offer.
              if (c.builtIn) return;
              // The menu key raises it with no pointer to place it by.
              const at = e.currentTarget.getBoundingClientRect();
              const keyed = e.clientX === 0 && e.clientY === 0;
              setMenu({
                name: c.name,
                x: keyed ? at.left + 24 : e.clientX,
                y: keyed ? at.bottom : e.clientY,
              });
            }}
          />
        ))}
        {adding && (
          <ProvisionalComparisonRow
            onName={(typed) => {
              const name = addCustomComparison(table, typed);
              setAdding(false);
              // It opens on its editor, with the caret in it: the condition is
              // the one thing left to write.
              revealStructureItem(comparisonItemId(table, name));
            }}
            onDiscard={() => setAdding(false)}
          />
        )}
        {comparisons.length === 0 && !adding && <TreeEmpty>None</TreeEmpty>}
      </TreeNode>
      {menu && menuComparison && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem
            icon={Icons.Rename}
            label="Rename"
            onClick={() => setRenaming(menuComparison.name)}
          />
          <MenuItem
            icon={Icons.Delete}
            label="Remove"
            danger
            onClick={() => setRemoving(menuComparison.name)}
          />
        </ContextMenu>
      )}
      <RemoveComparisonModal
        comparison={removing === null ? null : { table, name: removing }}
        onClose={() => setRemoving(null)}
      />
    </>
  );
}
