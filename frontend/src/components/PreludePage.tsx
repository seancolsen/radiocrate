import { useLayoutEffect, useMemo, useRef, type JSX } from "react";
import { Icons } from "../icons";
import { checkPrelude } from "../query/compile";
import { selectPrelude } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { SETTINGS } from "../state/settings";
import DiagnosticMessage, {
  diagnosticPlace,
} from "./builder/DiagnosticMessage";
import QuerydownEditor from "./builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "./builder/useDiagnostics";
import IconButton from "./ui/IconButton";
import { Tooltip } from "./ui/Tooltip";

// The Querydown prelude editor: a tab holding the prelude in a page-filling
// editor, under a toolbar of Reset to default · Save … and, at the far right, a
// "?" whose tooltip says what the prelude is for.
//
// Edits are held in the app store's `preludeDraft` until Save, so switching
// tabs keeps them and closing the tab drops them. "Reset to default" only fills
// the editor with the default — saving that is what clears the customization,
// since the store records a value equal to the default as no override at all.
// The text is checked as it's typed: a problem shows between the toolbar and
// the editor, and keeps it from being saved.

const PRELUDE = SETTINGS.querydown_prelude;

const TOOLBAR_BUTTON =
  "text-ink hover:bg-hover flex h-[26px] shrink-0 items-center gap-1.5 rounded px-2 text-sm disabled:opacity-40 disabled:hover:bg-transparent";

export default function PreludePage(): JSX.Element {
  const value = useApp(selectPrelude);
  const draft = useApp((s) => s.preludeDraft);
  const { editPrelude, savePrelude } = useAppActions();
  const text = draft ?? value;
  const unsaved = text !== value;

  const schemaJson = useCheckContext()?.schemaJson;
  const latest = useMemo(
    () => (schemaJson === undefined ? null : checkPrelude(schemaJson, text)),
    [schemaJson, text],
  );
  const problem = useSettledDiagnostic(latest);

  // The caret goes to the editor whenever the page shows, as it would in any
  // editor's document tab.
  const editorRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    editorRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      data-testid="prelude-page"
      className="bg-panel flex min-h-0 flex-1 flex-col"
    >
      <div className="border-edge flex h-[38px] shrink-0 items-center gap-1 border-b px-1.5">
        <button
          type="button"
          disabled={text === PRELUDE.default}
          className={TOOLBAR_BUTTON}
          onClick={() => editPrelude(PRELUDE.default)}
        >
          <Icons.Revert className="text-ink-weak size-4" />
          Reset to default
        </button>
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
        <div className="flex-1" />
        <Tooltip align="end" content={PRELUDE.description}>
          {(describedBy) => (
            <IconButton
              icon={Icons.Help}
              label="Help"
              describedBy={describedBy}
            />
          )}
        </Tooltip>
      </div>
      {problem && (
        <div className="border-edge shrink-0 border-b px-2.5 py-2">
          <DiagnosticMessage
            diagnostic={problem}
            place={diagnosticPlace(problem)}
          />
        </div>
      )}
      <QuerydownEditor
        ref={editorRef}
        look="page"
        label={PRELUDE.name}
        value={text}
        onChange={editPrelude}
        diagnostic={problem}
      />
    </div>
  );
}
