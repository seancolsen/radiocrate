import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
} from "react";
import type { ColumnSummary } from "api-client";
import { Icons } from "../../icons";
import {
  contextDefinitions,
  contextKeyColumn,
  DEFAULT_CONTEXTUAL_QUERY_NAME,
  sectionText,
} from "../../query/contextualQuery";
import { SECTIONS, type Section } from "../../query/definition";
import { defaultEmbedSections, embedSpec } from "../../query/embeddedRecord";
import { isFieldHidden, type EmbedSection } from "../../query/fieldMetadata";
import {
  fieldRef,
  type ContextQueryField,
  type FormField,
  type MultiRecordField,
} from "../../query/recordForm";
import {
  columnStatsLabel,
  FIELD_KIND_LABELS,
  fieldsItemId,
  relatedFieldSections,
  structureFieldId,
  structureFieldKind,
  structureFields,
  tableSummary,
} from "../../query/structure";
import {
  selectContextualQuery,
  selectFieldQuerydown,
  selectTableMetadata,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import { useCheckContext } from "../builder/useDiagnostics";
import { CONTEXT_QUERY_HELP } from "../record/ContextQueryEditor";
import { FieldPill } from "../record/FieldLabel";
import ProvisionalQueryRow from "../record/ProvisionalQueryRow";
import QuerySectionsEditor from "../record/QuerySectionsEditor";
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

/** A contextual query's editor, under its field: the one the record editor
 * shows there, with nothing to close — closing the field does that. No record
 * is in hand here, so `@id` is checked as standing for no value in particular.
 *
 * What's typed is the query's at once, and is written once the app goes quiet,
 * or as the editor goes away. */
function ContextQueryNodeEditor(props: {
  itemId: string;
  field: ContextQueryField;
}): JSX.Element {
  const { field } = props;
  const [section, setSection] = useState<Section>("filter");
  const { setContextualQuerySection, flushContextualQuery } = useAppActions();
  const definition = useApp(
    (s) => selectContextualQuery(s, field.queryId)?.definition,
  );
  const definitions = contextDefinitions(useCheckContext()?.prelude ?? "", "");
  useEffect(
    () => () => flushContextualQuery(field.queryId),
    [field.queryId, flushContextualQuery],
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  useFocusOnReveal(props.itemId, editorRef);

  return (
    <div ref={wrapRef}>
      <QuerySectionsEditor
        ref={editorRef}
        className="py-1 pr-1 pl-5"
        testId="context-query-editor"
        sections={SECTIONS}
        section={section}
        onSection={setSection}
        label={field.label}
        base={definition?.base ?? field.table}
        definitions={definitions}
        text={definition ? sectionText(definition, section) : ""}
        onChange={(next) =>
          setContextualQuerySection(field.queryId, section, next)
        }
        help={CONTEXT_QUERY_HELP}
        onEscape={() => focusOwnRow(wrapRef.current)}
      />
    </div>
  );
}

/** The part of a field's metadata each section of its records' query is kept
 * in. */
const EMBED_SECTIONS: Record<"sort" | "display", EmbedSection> = {
  sort: "sorting",
  display: "display",
};

/** A related-records field's editor, under the field: the same editor as a
 * contextual query's, without a filter — which records a field lists is what
 * the field is. It edits the Querydown behind the field's embedded records, in
 * every record editor on the table: what's generated for them until the user
 * writes their own, which "Restore default" goes back to. */
function RelatedFieldEditor(props: {
  table: string;
  field: MultiRecordField;
  sections: readonly ("sort" | "display")[];
}): JSX.Element {
  const { table, field, sections } = props;
  const [chosen, setSection] = useState(sections[0]);
  // A field can lose its sorting while it's open: its table gains an `order`.
  const section = sections.includes(chosen) ? chosen : sections[0];
  const part = EMBED_SECTIONS[section];
  const ref = useMemo(() => fieldRef(field), [field]);
  const stored = useApp((s) => selectFieldQuerydown(s, table, ref, part));
  const tables = useApp((s) => s.schema.tables);
  const generated = useMemo(
    () =>
      defaultEmbedSections(
        embedSpec(tables, field.table, field.column),
        field.keyColumns,
      ),
    [tables, field],
  );
  const { setFieldQuerydown, flushFieldQuerydown } = useAppActions();
  useEffect(
    () => () => {
      flushFieldQuerydown(table, ref, "display");
      flushFieldQuerydown(table, ref, "sorting");
    },
    [table, ref, flushFieldQuerydown],
  );
  const wrapRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={wrapRef}>
      <QuerySectionsEditor
        className="py-1 pr-1 pl-5"
        testId="related-field-editor"
        sections={sections}
        section={section}
        onSection={(next) => {
          if (next !== "filter") setSection(next);
        }}
        label={field.label}
        base={field.table}
        // As the form's queries are compiled: on the field's own table, with
        // no prelude.
        definitions=""
        text={stored ?? generated[part]}
        onChange={(next) => setFieldQuerydown(table, ref, part, next)}
        trailing={
          <button
            type="button"
            disabled={stored === null}
            className="text-ink hover:bg-hover h-[22px] shrink-0 rounded px-1.5 text-xs disabled:opacity-40 disabled:hover:bg-transparent"
            onClick={() => setFieldQuerydown(table, ref, part, null)}
          >
            Restore default
          </button>
        }
        onEscape={() => focusOwnRow(wrapRef.current)}
      />
    </div>
  );
}

/** One field: its label as the record editor draws it, what kind of field it
 * is, and for a column its type and what `SUMMARIZE` found in it. A contextual
 * query's and a related-records field's open into their editors; a column has
 * nothing to open into. */
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
  const sections = relatedFieldSections(field);
  return (
    <TreeNode
      id={id}
      expandable={field.kind === "contextQuery" || sections.length > 0}
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
      {field.kind === "contextQuery" && (
        <ContextQueryNodeEditor itemId={id} field={field} />
      )}
      {field.kind === "multiRecord" && sections.length > 0 && (
        <RelatedFieldEditor table={table} field={field} sections={sections} />
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
