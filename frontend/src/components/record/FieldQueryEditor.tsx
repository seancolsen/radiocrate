import { forwardRef, useEffect, useMemo, type ReactNode } from "react";
import { BaseTableItems } from "../BaseSubmenu";
import DiagnosticMessage from "../builder/DiagnosticMessage";
import InputActionsMenu from "../builder/InputActionsMenu";
import QuerydownEditor from "../builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "../builder/useDiagnostics";
import HelpPopover from "../ui/HelpPopover";
import IconButton from "../ui/IconButton";
import { Menu, MenuItem } from "../ui/Menu";
import { Icons, type IconComponent } from "../../icons";
import { checkFragment } from "../../query/compile";
import {
  contextDefinitions,
  ID_VARIABLE,
  listableTables,
  sectionText,
} from "../../query/contextualQuery";
import {
  sectionLabel,
  sectionNoun,
  type Section,
} from "../../query/definition";
import { defaultEmbedSections, embedSpec } from "../../query/embeddedRecord";
import {
  EMBED_PARTS,
  queryEditorSections,
  type QueryEditorField,
} from "../../query/fieldQuery";
import {
  fieldRef,
  type ContextQueryField,
  type MultiRecordField,
  type ScalarLinkField,
} from "../../query/recordForm";
import { sectionGrammar } from "../../editor/querydownEditor";
import { listedTables } from "../../query/tableSettings";
import { selectContextualQuery, selectFieldQuerydown } from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";

/** What a contextual query's editor says about `@id`, behind its "?". */
export const CONTEXT_QUERY_HELP =
  `${ID_VARIABLE} is the id of the record this query is shown on. ` +
  `Filter with it to find what's related to the record: on an artist, a ` +
  `query of credits filtered by artist.id:=${ID_VARIABLE} lists the artist's ` +
  `credits. The query doesn't run until it has a filter.`;

/** Each section's toggle, in the query builder's order. */
const SECTION_ICONS: Record<Section, IconComponent> = {
  filter: Icons.Filter,
  sort: Icons.Sort,
  display: Icons.Display,
};

interface FieldQueryEditorProps {
  /** The table of the record the field belongs to. */
  table: string;
  field: QueryEditorField;
  /** The section shown. One the field doesn't offer shows its first. */
  section: Section;
  onSection: (section: Section) => void;
  /** What `@id` stands for in a contextual query: the key of the record it's
   * shown on, or none in particular (`""`) with no record in hand. */
  idValue?: string;
  /** The way out, as an × at the toolbar's end. Absent, there's none: the
   * editor goes when what holds it closes. */
  onClose?: () => void;
  /** Escape, in the text. */
  onEscape: () => void;
  /** Why the database refused the field's records, said under the editor. */
  refused?: string;
}

/** The editor for the query behind a field, wherever it's edited: under a
 * field in the record editor, and under a field's row on the Data structure
 * page. A toolbar — a toggle for each section of the query the field offers
 * (`queryEditorSections`), the one shown pressed; then, at its end, a
 * contextual query's "Base table" and "?", and the × when there's a way out —
 * over the Querydown of the section shown.
 *
 * - A contextual query's sections are the query's own: filter, sorting and
 *   display, checked under the prelude and `@id`. Choosing another base table
 *   starts the query over on that table (`setContextualQueryBase`).
 * - A related-records or linked-record field's sections are its embedded
 *   records' sorting and display, kept in the field's metadata: what's
 *   generated for them until the user writes their own, which "Restore
 *   default", in the ⋮ inside the text, goes back to. They're checked as the
 *   form's queries are compiled: on the field's own table, with no prelude.
 *
 * What's typed is the query's at once, in every form that shows it, and is
 * written once the app goes quiet, or as the editor goes away.
 *
 * The ref forwards to the element that takes the caret, so a caller can focus
 * it. */
const FieldQueryEditor = forwardRef<HTMLElement, FieldQueryEditorProps>(
  function FieldQueryEditor(props, ref) {
    const { field } = props;
    return field.kind === "contextQuery" ? (
      <ContextQuerySource ref={ref} {...props} field={field} />
    ) : (
      <EmbedQuerySource ref={ref} {...props} field={field} />
    );
  },
);

export default FieldQueryEditor;

type SourceProps<F> = Omit<FieldQueryEditorProps, "field"> & { field: F };

/** A contextual query's sections, read from and written to the query. */
const ContextQuerySource = forwardRef<
  HTMLElement,
  SourceProps<ContextQueryField>
>(function ContextQuerySource(props, ref) {
  const { field } = props;
  const {
    setContextualQuerySection,
    flushContextualQuery,
    setContextualQueryBase,
  } = useAppActions();
  const definition = useApp(
    (s) => selectContextualQuery(s, field.queryId)?.definition,
  );
  const tables = useApp((s) => s.schema.tables);
  const settings = useApp((s) => s.tableSettings.data);
  const base = definition?.base ?? field.table;
  // The tables the user hasn't hidden, in their order, and the query's own.
  const listable = useMemo(
    () => listableTables(listedTables(tables, settings, { keep: base.trim() })),
    [tables, settings, base],
  );
  const definitions = contextDefinitions(
    useCheckContext()?.prelude.text ?? "",
    props.idValue ?? "",
  );
  // Nothing typed waits on the idle queue once the editor has gone.
  useEffect(
    () => () => flushContextualQuery(field.queryId),
    [field.queryId, flushContextualQuery],
  );

  return (
    <QuerySectionsView
      ref={ref}
      {...props}
      subject={field.label}
      sections={queryEditorSections(field)}
      base={base}
      definitions={definitions}
      text={definition ? sectionText(definition, props.section) : ""}
      onChange={(text) =>
        setContextualQuerySection(field.queryId, props.section, text)
      }
      tools={
        <Menu
          align="end"
          trigger={(api) => (
            <IconButton
              icon={Icons.Base}
              label="Base table"
              size="sm"
              active={api.open}
              onClick={() => api.toggle()}
            />
          )}
        >
          <BaseTableItems
            tables={listable}
            base={base.trim()}
            onChoose={(table) => setContextualQueryBase(field.queryId, table)}
          />
        </Menu>
      }
      help={CONTEXT_QUERY_HELP}
    />
  );
});

/** A related-records or linked-record field's sections: the Querydown behind
 * its embedded records, from the field's metadata or generated. */
const EmbedQuerySource = forwardRef<
  HTMLElement,
  SourceProps<MultiRecordField | ScalarLinkField>
>(function EmbedQuerySource(props, editorRef) {
  const { table, field } = props;
  const sections = queryEditorSections(field);
  // A field can lose its sorting while it's open: its table gains an `order`.
  const section = sections.includes(props.section)
    ? props.section
    : sections[0];
  const part = EMBED_PARTS[section === "sort" ? "sort" : "display"];
  const ref = useMemo(() => fieldRef(field), [field]);
  const stored = useApp((s) => selectFieldQuerydown(s, table, ref, part));
  const tables = useApp((s) => s.schema.tables);
  const generated = useMemo(() => {
    const multi = field.kind === "multiRecord";
    return defaultEmbedSections(
      embedSpec(tables, field.table, multi ? field.column : undefined),
      multi ? field.keyColumns : [field.keyColumn],
    );
  }, [tables, field]);
  const { setFieldQuerydown, flushFieldQuerydown } = useAppActions();
  // Nothing typed waits on the idle queue once the editor has gone.
  useEffect(
    () => () => {
      flushFieldQuerydown(table, ref, "display");
      flushFieldQuerydown(table, ref, "sorting");
    },
    [table, ref, flushFieldQuerydown],
  );

  return (
    <QuerySectionsView
      ref={editorRef}
      {...props}
      subject={field.label}
      sections={sections}
      section={section}
      base={field.table}
      definitions=""
      text={stored ?? generated[part]}
      onChange={(text) => setFieldQuerydown(table, ref, part, text)}
      inputActions={
        <MenuItem
          icon={Icons.Revert}
          label="Restore default"
          disabled={stored === null}
          onClick={() => setFieldQuerydown(table, ref, part, null)}
        />
      }
    />
  );
});

/** What the editor draws, whichever query is behind it — a field's, or a
 * table's record picker's (`structure/TableSettingNodes.tsx`). The text is
 * checked as it's typed, compiled as the section shown of a query on `base`
 * under `definitions`, and a problem with it shows below. `subject` names
 * whose query it is, for the editor's accessible names. */
export const QuerySectionsView = forwardRef<
  HTMLElement,
  {
    subject: string;
    section: Section;
    onSection: (section: Section) => void;
    onClose?: () => void;
    onEscape: () => void;
    refused?: string;
    sections: readonly Section[];
    /** The table the query lists. */
    base: string;
    /** The definitions the text runs under. */
    definitions: string;
    text: string;
    onChange: (text: string) => void;
    /** Buttons at the toolbar's end, ahead of the "?". */
    tools?: ReactNode;
    /** Help, in a tooltip on a "?" — or, given as more than a string, in a
     * popover. */
    help?: ReactNode;
    /** The rows of the ⋮ inside the text, when there are any. */
    inputActions?: ReactNode;
  }
>(function QuerySectionsView(props, editorRef) {
  const { subject, section, base, definitions, text, onEscape, onClose } =
    props;
  const schemaJson = useCheckContext()?.schemaJson;
  const latest = useMemo(
    () =>
      schemaJson === undefined
        ? null
        : checkFragment(schemaJson, definitions, base, section, text, {
            kind: "custom",
            section,
          }),
    [schemaJson, definitions, base, section, text],
  );
  const problem = useSettledDiagnostic(latest);
  const place = sectionNoun(section);

  return (
    <div className="py-1 pr-1 pl-5" data-testid="field-query-editor">
      <div className="flex items-center gap-0.5 pb-0.5">
        <div
          role="group"
          aria-label={`Sections of ${subject}`}
          className="flex items-center gap-0.5"
        >
          {props.sections.map((s) => (
            <IconButton
              key={s}
              icon={SECTION_ICONS[s]}
              label={sectionLabel(s)}
              size="sm"
              pressed={section === s}
              onClick={() => props.onSection(s)}
            />
          ))}
        </div>
        {/* With a × to close it (the record editor's), that's at the far end
            and the tools are by it; without one (the Data structure page's, a
            page wide enough to lose them at that end), they follow the
            sections. */}
        {onClose && <div className="flex-1" />}
        {props.tools}
        {typeof props.help === "string" ? (
          <IconButton
            icon={Icons.Help}
            label="Help"
            description={props.help}
            size="sm"
            tooltipAlign={onClose ? "end" : undefined}
          />
        ) : (
          props.help !== undefined && (
            <HelpPopover
              label="Help"
              size="sm"
              align={onClose ? "end" : undefined}
            >
              {props.help}
            </HelpPopover>
          )
        )}
        {onClose && (
          <IconButton
            icon={Icons.Close}
            label="Close query editor"
            size="sm"
            onClick={onClose}
          />
        )}
      </div>
      <div className="relative">
        <QuerydownEditor
          // One editor per section, each opening on that section's text.
          key={section}
          ref={editorRef}
          label={`${place} of ${subject}`}
          value={text}
          context={{
            grammar: sectionGrammar(section),
            baseTable: base,
            definitions,
          }}
          onChange={props.onChange}
          trailingSpace={props.inputActions !== undefined}
          diagnostic={problem}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            onEscape();
          }}
        />
        {props.inputActions !== undefined && (
          <InputActionsMenu>{props.inputActions}</InputActionsMenu>
        )}
      </div>
      {problem && (
        <div className="pt-1">
          <DiagnosticMessage diagnostic={problem} place={place} />
        </div>
      )}
      {props.refused !== undefined && (
        <p className="text-danger px-1 py-0.5 text-xs">{props.refused}</p>
      )}
    </div>
  );
});
