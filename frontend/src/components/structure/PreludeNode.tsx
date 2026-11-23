import { useMemo, useRef, type JSX } from "react";
import { Icons } from "../../icons";
import { checkPrelude } from "../../query/compile";
import { PRELUDE_ITEM } from "../../query/structure";
import { SETTINGS } from "../../state/settings";
import { selectUserPrelude } from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import DiagnosticMessage, {
  diagnosticPlace,
} from "../builder/DiagnosticMessage";
import QuerydownEditor from "../builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "../builder/useDiagnostics";
import IconButton from "../ui/IconButton";
import { TreeName, TreeNode, useFocusOnReveal } from "./Tree";

// The Querydown prelude, on the Data structure page: an item of the tree that
// opens into the prelude's editor, under a toolbar of Save · Discard changes
// (while there are any) · a "?" whose tooltip says what the prelude is for.
//
// The prelude is the user's own, and empty until they write one: what the app
// defines for every query — each table's computed columns and settings — has
// editors of its own, under the tables above.
//
// Edits are held in the app store's `preludeDraft` until Save, so closing the
// item or switching tabs keeps them, and closing the page's tab drops them.
// Saving it empty is what clears the customization, since the store records a
// value equal to the default as no override at all. The text is checked as
// it's typed: a problem shows between the toolbar and the editor, and keeps it
// from being saved.

const PRELUDE = SETTINGS.querydown_prelude;

const TOOLBAR_BUTTON =
  "text-ink hover:bg-hover flex h-[26px] shrink-0 items-center gap-1.5 rounded px-2 text-sm disabled:opacity-40 disabled:hover:bg-transparent";

/** The prelude's editor and its toolbar. Mounted only while the item is open. */
function PreludeEditor(): JSX.Element {
  const value = useApp(selectUserPrelude);
  const draft = useApp((s) => s.preludeDraft);
  const { editPrelude, savePrelude, discardPrelude } = useAppActions();
  const text = draft ?? value;
  const unsaved = text !== value;

  const schemaJson = useCheckContext()?.schemaJson;
  const latest = useMemo(
    () => (schemaJson === undefined ? null : checkPrelude(schemaJson, text)),
    [schemaJson, text],
  );
  const problem = useSettledDiagnostic(latest);

  // The caret comes here when the user was sent for the prelude: an error
  // strip's "Edit prelude".
  const editorRef = useRef<HTMLElement>(null);
  useFocusOnReveal(PRELUDE_ITEM, editorRef);

  return (
    <div className="py-1 pr-1 pl-5" data-testid="prelude-editor">
      <div className="flex items-center gap-1 pb-1">
        <button
          type="button"
          disabled={!unsaved || latest !== null}
          className={TOOLBAR_BUTTON}
          onClick={() => savePrelude()}
        >
          <Icons.Save className="text-ink-weak size-4" />
          Save
          {unsaved && (
            <Icons.Unsaved
              className="text-danger -ml-0.5 size-3.5"
              data-testid="prelude-unsaved"
              aria-hidden
            />
          )}
        </button>
        {unsaved && (
          <button
            type="button"
            className={TOOLBAR_BUTTON}
            onClick={() => discardPrelude()}
          >
            <Icons.Revert className="text-ink-weak size-4" />
            Discard changes
          </button>
        )}
        <IconButton
          icon={Icons.Help}
          label="Help"
          description={PRELUDE.description}
        />
      </div>
      {problem && (
        <div className="pb-1.5">
          <DiagnosticMessage
            diagnostic={problem}
            place={diagnosticPlace(problem)}
          />
        </div>
      )}
      <QuerydownEditor
        ref={editorRef}
        label={PRELUDE.name}
        value={text}
        context={{ grammar: "definitions" }}
        onChange={editPrelude}
        diagnostic={problem}
      />
    </div>
  );
}

/** The "Querydown prelude" item. Closed over text with an edit that isn't
 * saved, it wears the unsaved ✱ its Save button would be wearing. */
export function PreludeNode(): JSX.Element {
  const unsaved = useApp(
    (s) => s.preludeDraft !== null && !s.structure.expanded[PRELUDE_ITEM],
  );
  return (
    <TreeNode
      id={PRELUDE_ITEM}
      expandable
      label={
        <>
          <Icons.Querydown className="text-ink-weak size-4 shrink-0" />
          <TreeName>Querydown prelude</TreeName>
          {unsaved && (
            <Icons.Unsaved
              className="text-danger size-4 shrink-0"
              aria-label="Unsaved changes"
            />
          )}
        </>
      }
    >
      <PreludeEditor />
    </TreeNode>
  );
}
