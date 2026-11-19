import { useMemo, useRef, useState, type JSX, type MouseEvent } from "react";
import type { ColumnSummary } from "api-client";
import { Icons } from "../../icons";
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
import FieldQueryEditor from "../record/FieldQueryEditor";
import { FieldPill } from "../record/FieldLabel";
import ProvisionalQueryRow from "../record/ProvisionalQueryRow";
import { ContextMenu } from "../ui/ContextMenu";
import IconButton from "../ui/IconButton";
import { Menu, MenuItem } from "../ui/Menu";
import { COUNT_BUBBLE_CLASS } from "../ui/cx";
import {
  TreeEmpty,
  TreeName,
  TreeNode,
  TreeNote,
  useFocusOnReveal,
} from "./Tree";

// A table's fields on the Data structure page: every field its record editor
// form has — the hidden ones too, faded — in the order the form shows them.
// What's set here is the form's: it's the same metadata and the same contextual
// queries, so a change shows in every record editor on the table at once.

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

/** One field: its label as the record editor draws it, what kind of field it
 * is, and for a column its type and what `SUMMARIZE` found in it. A contextual
 * query's and a related-records field's open into their query's editor; a
 * column has nothing to open into. */
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
          <FieldPill field={field} />
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
        </>
      }
    >
      {expandable && hasQueryEditor(field) && (
        <FieldNodeEditor itemId={id} table={table} field={field} />
      )}
    </TreeNode>
  );
}

/** A table's "Fields": how many it has, the "+" that adds one, and the fields.
 * A field's context menu hides it from the record editor, or brings it back. */
export function FieldsNode(props: { table: string }): JSX.Element {
  const { table } = props;
  const tables = useApp((s) => s.schema.tables);
  const queries = useApp((s) => s.contextualQueries.data);
  const metadata = useApp((s) => selectTableMetadata(s, table));
  const summary = useApp((s) => tableSummary(s.tableSummaries.data, table));
  const {
    addContextualQuery,
    revealStructureItem,
    setStructureExpanded,
    setFieldHidden,
  } = useAppActions();

  const fields = useMemo(
    () => structureFields(tables, table, queries, metadata),
    [tables, table, queries, metadata],
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
            <span
              className={COUNT_BUBBLE_CLASS}
              aria-label={`${fields.length} ${fields.length === 1 ? "field" : "fields"}`}
            >
              {fields.length}
            </span>
          </>
        }
        actions={
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
              icon={Icons.FieldQuery}
              label="Contextual query"
              disabled={!canQuery}
              onClick={() => {
                // It goes among the fields, which have to be on show for that.
                setStructureExpanded([id], true);
                setProvisional({
                  name: DEFAULT_CONTEXTUAL_QUERY_NAME,
                  naming: true,
                });
              }}
            />
          </Menu>
        }
      >
        {fields.map((field) => {
          const column =
            field.kind === "multiRecord" || field.kind === "contextQuery"
              ? undefined
              : field.column;
          return (
            <FieldNode
              key={field.key}
              table={table}
              field={field}
              hidden={isFieldHidden(metadata, fieldRef(field))}
              type={columns?.find((c) => c.name === column)?.type}
              stats={summary?.columns.find((c) => c.name === column)}
              rowCount={summary?.rowCount ?? 0}
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
        {fields.length === 0 && !provisional && <TreeEmpty>None</TreeEmpty>}
      </TreeNode>
      {menu && menuField && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
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
        </ContextMenu>
      )}
    </>
  );
}
