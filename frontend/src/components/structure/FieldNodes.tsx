import { useMemo, useRef, useState, type JSX, type MouseEvent } from "react";
import type { ColumnSummary, FieldRef } from "api-client";
import { Icons } from "../../icons";
import { isComputedCustomized } from "../../query/computedColumns";
import {
  contextKeyColumn,
  DEFAULT_CONTEXTUAL_QUERY_NAME,
} from "../../query/contextualQuery";
import type { Section } from "../../query/definition";
import { isFieldHidden } from "../../query/fieldMetadata";
import {
  hasQueryEditor,
  queryEditorSections,
  type QueryEditorField,
} from "../../query/fieldQuery";
import { fieldRef, type FormField } from "../../query/recordForm";
import {
  columnStatsLabel,
  FIELD_KIND_LABELS,
  fieldsItemId,
  isFieldExpandable,
  structureFieldId,
  structureFieldKind,
  structureFields,
  tableSummary,
} from "../../query/structure";
import { selectTableMetadata } from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import ComputedColumnEditor from "../record/ComputedColumnEditor";
import { RemoveComputedColumnModal } from "../record/ComputedColumnRemoveModal";
import FieldQueryEditor from "../record/FieldQueryEditor";
import {
  FieldPill,
  type LabelRename,
  type RenameEnd,
} from "../record/FieldLabel";
import { RemoveQueryModal } from "../record/ContextQueryRemoveModal";
import ProvisionalComputedRow from "../record/ProvisionalComputedRow";
import ProvisionalQueryRow from "../record/ProvisionalQueryRow";
import { ContextMenu } from "../ui/ContextMenu";
import IconButton from "../ui/IconButton";
import { Menu, MenuItem } from "../ui/Menu";
import {
  TreeCount,
  TreeEmpty,
  TreeName,
  TreeNode,
  TreeNote,
  useFocusOnReveal,
} from "./Tree";

// A table's fields on the Data structure page: every field its record editor
// form has, in the order the form shows them. The ones the user has hidden are
// left out, unless they've asked to see those (the app's one "show hidden
// fields", which the record editor's follows too), when they're there, faded.
// What's set here is the form's: it's the same metadata, the same computed
// columns and the same contextual queries, so a change shows in every record
// editor on the table at once.

/** Gives the keyboard back to the row of the item `el` is under: the way out of
 * an editor, on Escape. */
function focusOwnRow(el: HTMLElement | null): void {
  el?.closest("[data-tree-node]")
    ?.querySelector<HTMLElement>("[data-tree-item]")
    ?.focus();
}

/** A field's query editor, under its row: the one the record editor shows
 * under the field (`FieldQueryEditor`), with nothing to close — closing the
 * row does that, and Escape gives the row back the keyboard. No record is in
 * hand here, so a contextual query's `@id` is checked as standing for no value
 * in particular.
 *
 * What's typed is the field's at once, in every record editor on the table, and
 * is written once the app goes quiet, or as the editor goes away. */
function FieldNodeEditor(props: {
  itemId: string;
  table: string;
  field: QueryEditorField;
}): JSX.Element {
  const [section, setSection] = useState<Section>(
    () => queryEditorSections(props.field)[0] ?? "display",
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  useFocusOnReveal(props.itemId, editorRef);

  return (
    <div ref={wrapRef}>
      <FieldQueryEditor
        ref={editorRef}
        table={props.table}
        field={props.field}
        section={section}
        onSection={setSection}
        onEscape={() => focusOwnRow(wrapRef.current)}
      />
    </div>
  );
}

/** A computed column's expression editor, under its row: the one the record
 * editor shows under the column's field (`ComputedColumnEditor`), with nothing
 * to close — closing the row does that, and Escape gives the row back the
 * keyboard. */
function ComputedNodeEditor(props: {
  itemId: string;
  table: string;
  name: string;
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  useFocusOnReveal(props.itemId, editorRef);
  return (
    <div ref={wrapRef}>
      <ComputedColumnEditor
        ref={editorRef}
        table={props.table}
        name={props.name}
        onEscape={() => focusOwnRow(wrapRef.current)}
      />
    </div>
  );
}

/** What's said beside one of the app's own computed columns: whether the
 * expression in force is the user's or the app's. One of the user's own says
 * nothing: it's theirs, whatever it holds. */
function ComputedNote(props: { table: string; name: string }): JSX.Element {
  const customized = useApp((s) =>
    isComputedCustomized(s.computedColumns.data, props.table, props.name),
  );
  return <TreeNote>{customized ? "Customized" : "Built-in"}</TreeNote>;
}

/** One field: its label as the record editor draws it, what kind of field it
 * is, and for a column its type and what `SUMMARIZE` found in it. A contextual
 * query's and a related-records field's open into their query's editor, and a
 * computed column's into its expression's; a column has nothing to open
 * into. */
function FieldNode(props: {
  table: string;
  field: FormField;
  /** Whether the user has hidden the field from the record editor. */
  hidden: boolean;
  /** A column's type. */
  type: string | undefined;
  /** A column's statistics, once they're read, and the rows they're of. */
  stats: ColumnSummary | undefined;
  rowCount: number;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  /** Set while the name of a contextual query, or of a computed column of the
   * user's, is being typed in place of it. */
  rename?: LabelRename;
}): JSX.Element {
  const { table, field } = props;
  const kind = structureFieldKind(field);
  const id = structureFieldId(table, fieldRef(field));
  const expandable = isFieldExpandable(field);
  return (
    <TreeNode
      id={id}
      expandable={expandable}
      dimmed={props.hidden}
      onContextMenu={props.onContextMenu}
      label={
        <>
          <FieldPill field={field} rename={props.rename} />
          <span className="text-ink-weak shrink-0 text-[10px] font-semibold tracking-wider uppercase">
            {FIELD_KIND_LABELS[kind]}
          </span>
          {kind === "column" && props.type !== undefined && (
            <span className="text-ink min-w-0 shrink truncate font-mono text-xs">
              {props.type}
            </span>
          )}
          {props.stats && (
            <TreeNote>{columnStatsLabel(props.stats, props.rowCount)}</TreeNote>
          )}
          {field.kind === "computed" && field.builtIn && (
            <ComputedNote table={table} name={field.name} />
          )}
        </>
      }
    >
      {field.kind === "computed" ? (
        <ComputedNodeEditor itemId={id} table={table} name={field.name} />
      ) : (
        expandable &&
        hasQueryEditor(field) && (
          <FieldNodeEditor itemId={id} table={table} field={field} />
        )
      )}
    </TreeNode>
  );
}

/** A table's "Fields": how many are listed, the "+" that adds one — a computed
 * column or a contextual query — the toggle that lists the hidden ones too
 * (while the table has any), and the fields. A field's context menu hides it
 * from the record editor, or brings it back; a contextual query's renames and
 * removes it too, and so does that of a computed column of the user's own. */
export function FieldsNode(props: { table: string }): JSX.Element {
  const { table } = props;
  const tables = useApp((s) => s.schema.tables);
  const queries = useApp((s) => s.contextualQueries.data);
  const computed = useApp((s) => s.computedColumns.data);
  const metadata = useApp((s) => selectTableMetadata(s, table));
  const summary = useApp((s) => tableSummary(s.tableSummaries.data, table));
  const showHidden = useApp((s) => s.showHiddenFields);
  const {
    addComputedColumn,
    addContextualQuery,
    renameComputedColumn,
    renameContextualQuery,
    revealStructureItem,
    setStructureExpanded,
    setFieldHidden,
    setShowHiddenFields,
  } = useAppActions();

  const fields = useMemo(
    () => structureFields(tables, table, computed, queries, metadata),
    [tables, table, computed, queries, metadata],
  );
  const hiddenCount = useMemo(
    () =>
      fields.filter((field) => isFieldHidden(metadata, fieldRef(field))).length,
    [fields, metadata],
  );
  const listed = useMemo(
    () =>
      showHidden
        ? fields
        : fields.filter((field) => !isFieldHidden(metadata, fieldRef(field))),
    [fields, metadata, showHidden],
  );
  const columns = tables.find((t) => t.name === table)?.columns;
  /** A table with no one column for `@id` to hold can't have a query. */
  const canQuery = contextKeyColumn(tables, table) !== undefined;

  // A contextual query being added: named, and waiting for its table.
  const [provisional, setProvisional] = useState<{
    name: string;
    naming: boolean;
  } | null>(null);
  // The field whose context menu is up, by key.
  const [menu, setMenu] = useState<{
    fieldKey: string;
    x: number;
    y: number;
  } | null>(null);
  const menuField = fields.find((field) => field.key === menu?.fieldKey);
  // A computed column being added: its name being typed.
  const [addingComputed, setAddingComputed] = useState(false);
  // The contextual query or computed column whose name is being typed, by its
  // field's key.
  const [renaming, setRenaming] = useState<string | null>(null);
  // The contextual query whose removal is being asked about.
  const [removing, setRemoving] = useState<string | null>(null);
  // The computed column whose removal is being asked about.
  const [removingComputed, setRemovingComputed] = useState<string | null>(null);

  /** Ends a rename: the keyboard goes back to the row of `field` — unless the
   * user went somewhere else, which is where it stays. */
  const renamed = (field: FieldRef, end: RenameEnd | null) => {
    setRenaming(null);
    if (end === "blur") return;
    const selector = `[data-item-id="${CSS.escape(structureFieldId(table, field))}"] > [data-tree-item]`;
    // Once the name's input, which has the keyboard, is gone — and the row is
    // there under the name it was just given.
    queueMicrotask(() =>
      document.querySelector<HTMLElement>(selector)?.focus(),
    );
  };

  /** What a contextual query's name, typed in place, does: it's the query's
   * once it's settled on. */
  const renameOf = (queryId: string): LabelRename => ({
    onCommit: (name, end) => {
      renameContextualQuery(queryId, name);
      renamed({ contextualQuery: queryId }, end);
    },
    onCancel: () => renamed({ contextualQuery: queryId }, null),
  });

  /** The same for a computed column, whose row goes by its name. */
  const renameOfComputed = (name: string): LabelRename => ({
    onCommit: (typed, end) => {
      const next = renameComputedColumn(table, name, typed);
      renamed({ computedColumn: next }, end);
    },
    onCancel: () => renamed({ computedColumn: name }, null),
  });

  const id = fieldsItemId(table);
  return (
    <>
      <TreeNode
        id={id}
        expandable
        label={
          <>
            <Icons.Fields className="text-ink-weak size-4 shrink-0" />
            <TreeName>Fields</TreeName>
            <TreeCount n={listed.length} one="field" many="fields" />
          </>
        }
        actions={
          <>
            <Menu
              align="end"
              trigger={(api) => (
                <IconButton
                  icon={Icons.Add}
                  size="sm"
                  label="Add field"
                  active={api.open}
                  onClick={() => api.toggle()}
                />
              )}
            >
              <MenuItem
                icon={Icons.FieldComputed}
                label="Computed column"
                onClick={() => {
                  // It goes among the fields, which have to be on show for that.
                  setStructureExpanded([id], true);
                  setProvisional(null);
                  setAddingComputed(true);
                }}
              />
              <MenuItem
                icon={Icons.FieldQuery}
                label="Contextual query"
                disabled={!canQuery}
                onClick={() => {
                  setStructureExpanded([id], true);
                  setAddingComputed(false);
                  setProvisional({
                    name: DEFAULT_CONTEXTUAL_QUERY_NAME,
                    naming: true,
                  });
                }}
              />
            </Menu>
            {hiddenCount > 0 && (
              <IconButton
                icon={Icons.Show}
                size="sm"
                label="Show hidden fields"
                pressed={showHidden}
                onClick={() => setShowHiddenFields(!showHidden)}
              />
            )}
          </>
        }
      >
        {listed.map((field) => {
          const column =
            field.kind === "primitive" || field.kind === "scalarLink"
              ? field.column
              : undefined;
          let rename: LabelRename | undefined;
          if (renaming === field.key) {
            if (field.kind === "contextQuery") rename = renameOf(field.queryId);
            if (field.kind === "computed")
              rename = renameOfComputed(field.name);
          }
          return (
            <FieldNode
              key={field.key}
              table={table}
              field={field}
              hidden={isFieldHidden(metadata, fieldRef(field))}
              type={columns?.find((c) => c.name === column)?.type}
              stats={summary?.columns.find((c) => c.name === column)}
              rowCount={summary?.rowCount ?? 0}
              rename={rename}
              onContextMenu={(e) => {
                e.preventDefault();
                // The menu key raises it with no pointer to place it by.
                const at = e.currentTarget.getBoundingClientRect();
                const keyed = e.clientX === 0 && e.clientY === 0;
                setMenu({
                  fieldKey: field.key,
                  x: keyed ? at.left + 24 : e.clientX,
                  y: keyed ? at.bottom : e.clientY,
                });
              }}
            />
          );
        })}
        {provisional && (
          <ProvisionalQueryRow
            name={provisional.name}
            naming={provisional.naming}
            onName={(name) => setProvisional((p) => p && { ...p, name })}
            onNaming={(naming) => setProvisional((p) => p && { ...p, naming })}
            onChoose={(base) => {
              const queryId = addContextualQuery(table, provisional.name, base);
              setProvisional(null);
              // Its field opens on its editor, with the caret in its filter.
              revealStructureItem(
                structureFieldId(table, { contextualQuery: queryId }),
              );
            }}
            onDiscard={() => setProvisional(null)}
          />
        )}
        {addingComputed && (
          <ProvisionalComputedRow
            onName={(typed) => {
              const name = addComputedColumn(table, typed);
              setAddingComputed(false);
              // Its field opens on its editor, with the caret in it: the
              // expression is the one thing left to write.
              revealStructureItem(
                structureFieldId(table, { computedColumn: name }),
              );
            }}
            onDiscard={() => setAddingComputed(false)}
          />
        )}
        {listed.length === 0 && !provisional && !addingComputed && (
          <TreeEmpty>
            {fields.length === 0 ? "None" : "Every field is hidden"}
          </TreeEmpty>
        )}
      </TreeNode>
      {menu && menuField && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(menuField.kind === "contextQuery" ||
            (menuField.kind === "computed" && !menuField.builtIn)) && (
            <MenuItem
              icon={Icons.Rename}
              label="Rename"
              onClick={() => setRenaming(menuField.key)}
            />
          )}
          {isFieldHidden(metadata, fieldRef(menuField)) ? (
            <MenuItem
              icon={Icons.Show}
              label="Un-hide field"
              onClick={() => setFieldHidden(table, fieldRef(menuField), false)}
            />
          ) : (
            <MenuItem
              icon={Icons.Hide}
              label="Hide field"
              onClick={() => setFieldHidden(table, fieldRef(menuField), true)}
            />
          )}
          {menuField.kind === "contextQuery" && (
            <MenuItem
              icon={Icons.Delete}
              label="Remove"
              danger
              onClick={() => setRemoving(menuField.queryId)}
            />
          )}
          {menuField.kind === "computed" && !menuField.builtIn && (
            <MenuItem
              icon={Icons.Delete}
              label="Remove"
              danger
              onClick={() => setRemovingComputed(menuField.name)}
            />
          )}
        </ContextMenu>
      )}
      <RemoveQueryModal queryId={removing} onClose={() => setRemoving(null)} />
      <RemoveComputedColumnModal
        column={
          removingComputed === null ? null : { table, name: removingComputed }
        }
        onClose={() => setRemovingComputed(null)}
      />
    </>
  );
}
