import type { JSX } from "react";
import {
  selectBuilderSection,
  selectExpandedPreset,
  selectFullEditorOpen,
  selectPageDiagnostic,
  selectPresetName,
} from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import DiagnosticMessage, {
  diagnosticPlace,
} from "./builder/DiagnosticMessage";

/** The query page's error strip, under the toolbar (and the builder, when one
 * is open): the problem with the page's query, if it has one — wherever it
 * is, so one in a section that's closed, a collapsed preset or the prelude
 * still shows. While it does, the rows below are an earlier definition's.
 *
 * Its "Show" takes the user to the problem, when it's somewhere they aren't
 * already looking. Nothing dismisses it: it goes when the problem does — or
 * steps aside while the preset the problem is in has its editor open, which
 * checks the preset as it's edited and says the same thing under it. */
export default function QueryDiagnosticBar(props: {
  tabId: string;
}): JSX.Element | null {
  const diagnostic = useApp((s) => selectPageDiagnostic(s, props.tabId));
  const origin = diagnostic?.origin ?? null;
  const presetName = useApp((s) =>
    origin?.kind === "preset" ? selectPresetName(s, origin.id) : "",
  );
  // Whether the editor the problem is in is already on screen.
  const inView = useApp((s) => {
    if (origin === null || origin.kind === "prelude") return false;
    if (origin.kind === "full") return selectFullEditorOpen(s, props.tabId);
    if (selectBuilderSection(s, props.tabId) !== origin.section) return false;
    return (
      origin.kind === "custom" ||
      selectExpandedPreset(s, props.tabId) === origin.id
    );
  });
  const { revealDiagnostic } = useAppActions();
  if (!diagnostic || (origin?.kind === "preset" && inView)) return null;

  const action =
    origin?.kind === "prelude" ? "Edit prelude" : origin && !inView && "Show";

  return (
    <div
      data-testid="query-diagnostic"
      className="bg-panel border-edge border-b px-2.5 py-2"
    >
      <DiagnosticMessage
        diagnostic={diagnostic}
        place={diagnosticPlace(diagnostic, presetName)}
        actions={
          action && (
            <button
              type="button"
              className="border-edge text-ink hover:bg-hover rounded border px-2 py-0.5 text-xs"
              onClick={() => revealDiagnostic(props.tabId)}
            >
              {action}
            </button>
          )
        }
      />
    </div>
  );
}
