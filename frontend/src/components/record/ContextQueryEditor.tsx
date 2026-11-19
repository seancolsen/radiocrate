import { useLayoutEffect, useRef, type JSX } from "react";
import { useCheckContext } from "../builder/useDiagnostics";
import IconButton from "../ui/IconButton";
import { Icons } from "../../icons";
import {
  contextDefinitions,
  ID_VARIABLE,
  sectionText,
} from "../../query/contextualQuery";
import { SECTIONS, type Section } from "../../query/definition";
import type { ContextQueryField } from "../../query/recordForm";
import { selectContextualQuery } from "../../stores/app";
import {
  fieldItemId,
  selectQueryEditorFocusAsked,
  type RecordFormModel,
} from "../../stores/recordForm";
import { useApp, useAppActions, useFormState } from "../../stores/react";
import QuerySectionsEditor from "./QuerySectionsEditor";

/** What a contextual query's editor says about `@id`, behind its "?". */
export const CONTEXT_QUERY_HELP =
  `${ID_VARIABLE} is the id of the record this query is shown on. ` +
  `Filter with it to find what's related to the record: on an artist, a ` +
  `query of credits filtered by artist:=${ID_VARIABLE} lists the artist's ` +
  `credits. The query doesn't run until it has a filter.`;

/** The editor of a contextual query, under its field: a toolbar — the sections of
 * the query, one shown at a time, a "?" saying how `@id` works, and the way out —
 * over the Querydown of the section shown (`QuerySectionsEditor`).
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
  const definitions = contextDefinitions(
    useCheckContext()?.prelude ?? "",
    props.idValue ?? "",
  );

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
    <QuerySectionsEditor
      ref={editorRef}
      className="pr-1 pb-1 pl-5"
      testId="context-query-editor"
      sections={SECTIONS}
      section={section}
      onSection={(next) => model.openQueryEditor(recordId, field, next)}
      label={field.label}
      base={base}
      definitions={definitions}
      text={text}
      onChange={(next) =>
        setContextualQuerySection(field.queryId, section, next)
      }
      help={CONTEXT_QUERY_HELP}
      trailing={
        <IconButton
          icon={Icons.Close}
          label="Close query editor"
          size="sm"
          onClick={close}
        />
      }
      onEscape={close}
    />
  );
}
