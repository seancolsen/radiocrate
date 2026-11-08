import { useLayoutEffect, useMemo, useRef, type JSX } from "react";
import DiagnosticMessage from "../builder/DiagnosticMessage";
import QuerydownEditor from "../builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "../builder/useDiagnostics";
import IconButton from "../ui/IconButton";
import { Icons, type IconComponent } from "../../icons";
import { checkFragment } from "../../query/compile";
import {
  contextDefinitions,
  ID_VARIABLE,
  sectionText,
} from "../../query/contextualQuery";
import {
  sectionLabel,
  sectionNoun,
  type Section,
} from "../../query/definition";
import type { ContextQueryField } from "../../query/recordForm";
import { sectionGrammar } from "../../editor/querydownEditor";
import { selectContextualQuery } from "../../stores/app";
import {
  fieldItemId,
  selectQueryEditorFocusAsked,
  type RecordFormModel,
} from "../../stores/recordForm";
import { useApp, useAppActions, useFormState } from "../../stores/react";

/** The section toggles, in the query builder's order. */
const SECTIONS: { section: Section; icon: IconComponent }[] = [
  { section: "filter", icon: Icons.Filter },
  { section: "sort", icon: Icons.Sort },
  { section: "display", icon: Icons.Display },
];

const HELP =
  `${ID_VARIABLE} is the id of the record this query is shown on. ` +
  `Filter with it to find what's related to the record: on an artist, a ` +
  `query of credits filtered by artist:=${ID_VARIABLE} lists the artist's ` +
  `credits. The query doesn't run until it has a filter.`;

/** The editor of a contextual query, under its field: a toolbar — the sections of
 * the query, one shown at a time, a "?" saying how `@id` works, and the way out —
 * over the Querydown of the section shown.
 *
 * What's typed is the query's at once, as a query page's builder text is: every
 * form showing the query runs it again as it settles, and it's written once the
 * app goes quiet (`setContextualQuerySection`), or as the editor closes. It's
 * checked as it's typed, under the definitions it runs with: the prelude, and
 * `@id` as this record's key. */
export default function ContextQueryEditor(props: {
  model: RecordFormModel;
  recordId: string;
  field: ContextQueryField;
  section: Section;
  /** What `@id` stands for on this record, while it's known. */
  idValue: string | null;
}): JSX.Element {
  const { model, recordId, field, section } = props;
  const { setContextualQuerySection, flushContextualQuery } = useAppActions();
  const definition = useApp(
    (s) => selectContextualQuery(s, field.queryId)?.definition,
  );
  const text = definition ? sectionText(definition, section) : "";
  const base = definition?.base ?? field.table;

  const check = useCheckContext();
  const schemaJson = check?.schemaJson;
  const definitions = contextDefinitions(
    check?.prelude ?? "",
    props.idValue ?? "",
  );
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

  // The caret comes here when the user asks for this editor, or another section
  // of it, and only then. A layout effect, so focus has moved before the context
  // menu it's asked for from restores its own.
  const editorRef = useRef<HTMLElement>(null);
  const focusAsked = useFormState(model, (s) =>
    selectQueryEditorFocusAsked(s, recordId, field.key),
  );
  useLayoutEffect(() => {
    if (!focusAsked) return;
    editorRef.current?.focus();
    model.noteEmbedEditorFocused();
  }, [model, focusAsked]);

  /** The user has finished: no reason for what they wrote to wait any longer, and
   * the keyboard goes back to the field. */
  const close = () => {
    flushContextualQuery(field.queryId);
    model.closeQueryEditor(recordId, field.key);
    queueMicrotask(() => model.focusItem(fieldItemId(recordId, field.key)));
  };

  return (
    <div className="pr-1 pb-1 pl-5" data-testid="context-query-editor">
      <div className="flex items-center gap-0.5 pb-0.5">
        {SECTIONS.map((s) => (
          <IconButton
            key={s.section}
            icon={s.icon}
            label={sectionLabel(s.section)}
            size="sm"
            active={section === s.section}
            onClick={() => model.openQueryEditor(recordId, field, s.section)}
          />
        ))}
        <IconButton
          icon={Icons.Help}
          label="Help"
          description={HELP}
          size="sm"
          tooltipAlign="start"
        />
        <div className="flex-1" />
        <IconButton
          icon={Icons.Close}
          label="Close query editor"
          size="sm"
          onClick={close}
        />
      </div>
      <QuerydownEditor
        // One editor per section, each opening on that section's text.
        key={section}
        ref={editorRef}
        label={`${sectionNoun(section)} of ${field.label}`}
        value={text}
        context={{
          grammar: sectionGrammar(section),
          baseTable: base,
          definitions,
        }}
        onChange={(next) =>
          setContextualQuerySection(field.queryId, section, next)
        }
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
          <DiagnosticMessage
            diagnostic={problem}
            place={sectionNoun(section)}
          />
        </div>
      )}
    </div>
  );
}
