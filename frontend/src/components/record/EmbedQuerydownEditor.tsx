import { useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import DiagnosticMessage from "../builder/DiagnosticMessage";
import QuerydownEditor from "../builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "../builder/useDiagnostics";
import IconButton from "../ui/IconButton";
import { Icons } from "../../icons";
import { checkFragment } from "../../query/compile";
import type { Section } from "../../query/definition";
import { defaultEmbedSections } from "../../query/embeddedRecord";
import type { EmbedSection } from "../../query/fieldMetadata";
import {
  fieldRef,
  type MultiRecordField,
  type ScalarLinkField,
} from "../../query/recordForm";
import { sectionGrammar } from "../../editor/querydownEditor";
import { selectFieldQuerydown } from "../../stores/app";
import {
  fieldItemId,
  selectEmbedEditorFocusAsked,
  selectEmbedEditorOpen,
  type RecordFormModel,
} from "../../stores/recordForm";
import { useApp, useAppActions, useFormState } from "../../stores/react";

const LABELS: Record<EmbedSection, string> = {
  display: "Display",
  sorting: "Sorting",
};

/** The query section each part of a field's embedded records is written in. */
const QUERY_SECTIONS: Record<EmbedSection, Section> = {
  display: "display",
  sorting: "sort",
};

/** The editor for the Querydown behind one part of a field's embedded records, on
 * the two rows under the field: a toolbar, and the text. It opens on what the query
 * runs by now, whether generated or written. What's typed shows at once, here and in
 * every form on the table (`setFieldQuerydown`), and the records follow as it settles
 * (`refreshEmbeds`).
 *
 * The text is checked as it's typed, as the form's queries are compiled: on the
 * field's own table, with no prelude. */
export default function EmbedQuerydownEditor(props: {
  model: RecordFormModel;
  recordId: string;
  /** The table of the record the field belongs to. */
  table: string;
  field: ScalarLinkField | MultiRecordField;
  section: EmbedSection;
}): JSX.Element {
  const { model, recordId, table, field, section } = props;
  const { setFieldQuerydown, flushFieldQuerydown } = useAppActions();
  const ref = useMemo(() => fieldRef(field), [field]);
  const stored = useApp((s) => selectFieldQuerydown(s, table, ref, section));

  // A field's table and columns are fixed for its life, and so is what's generated
  // from them.
  const [generated] = useState(() => {
    const multi = field.kind === "multiRecord";
    return defaultEmbedSections(
      model.previewSpec(field.table, multi ? field.column : undefined),
      multi ? field.keyColumns : [field.keyColumn],
    )[section];
  });
  const text = stored ?? generated;

  const schemaJson = useCheckContext()?.schemaJson;
  const querySection = QUERY_SECTIONS[section];
  const latest = useMemo(
    () =>
      schemaJson === undefined
        ? null
        : checkFragment(schemaJson, "", field.table, querySection, text, {
            kind: "custom",
            section: querySection,
          }),
    [schemaJson, field.table, querySection, text],
  );
  const problem = useSettledDiagnostic(latest);

  // One message for the field, under the last of its editors.
  const refused = useFormState(model, (s) =>
    section === "display" &&
    selectEmbedEditorOpen(s, recordId, field.key, "sorting")
      ? undefined
      : s.embedErrors[fieldItemId(recordId, field.key)],
  );

  // The caret comes here when the user asks for this editor, and only then. A
  // layout effect, so focus has moved before the context menu it's asked for from
  // restores its own.
  const editorRef = useRef<HTMLElement>(null);
  const focusAsked = useFormState(model, (s) =>
    selectEmbedEditorFocusAsked(s, recordId, field.key, section),
  );
  useLayoutEffect(() => {
    if (!focusAsked) return;
    editorRef.current?.focus();
    model.noteEmbedEditorFocused();
  }, [model, focusAsked]);

  /** The user has finished: no reason for what they wrote to wait any longer, and
   * the keyboard goes back to the field. */
  const close = () => {
    flushFieldQuerydown(table, ref, section);
    model.closeEmbedEditor(recordId, field.key, section);
    queueMicrotask(() => model.focusItem(fieldItemId(recordId, field.key)));
  };

  const label = LABELS[section];
  return (
    <div className="pr-1 pb-1 pl-5">
      <div className="flex items-center gap-1 pb-0.5">
        <span className="text-ink-weak flex-1 text-xs">{label}</span>
        <button
          type="button"
          className="text-ink hover:bg-hover h-[22px] shrink-0 rounded px-1.5 text-xs"
          onClick={() => {
            setFieldQuerydown(table, ref, section, null);
            close();
          }}
        >
          Restore default
        </button>
        <IconButton
          icon={Icons.Close}
          label={`Close ${label.toLowerCase()} editor`}
          size="sm"
          onClick={close}
        />
      </div>
      <QuerydownEditor
        ref={editorRef}
        label={`${label} of ${field.label}`}
        value={text}
        context={{
          grammar: sectionGrammar(querySection),
          baseTable: field.table,
        }}
        onChange={(next) => setFieldQuerydown(table, ref, section, next)}
        diagnostic={problem}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          close();
        }}
      />
      {problem && (
        <div className="pt-1">
          <DiagnosticMessage diagnostic={problem} place={label} />
        </div>
      )}
      {refused !== undefined && (
        <p className="text-danger px-1 py-0.5 text-xs">{refused}</p>
      )}
    </div>
  );
}
