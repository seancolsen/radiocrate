import { useEffect, type JSX } from "react";
import { selectPresetsReady, selectSchemaReady } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import QueryToolbar from "./QueryToolbar";
import QueryResults from "./QueryResults";

/** The content of an open tab: a toolbar over the results pane, with the record
 * editor as a sidebar beside them when one is open. Runs the tab's saved query
 * once when it's first viewed (opening a query shows rows without a manual
 * refresh click); the refresh button re-runs it.
 *
 * The record editor is scoped to the page in both senses: its state is per-tab
 * (switching tabs switches editors) and so is its layout — it narrows this
 * page's toolbar and results, while the tab bar and the now-playing bar above
 * and below keep their full width.
 *
 * Two of the Solid version's three effects have left: the form-stash prune and
 * the record editor's "dynamic updates" resync are rules *between* stores, so
 * they're wired in `createStores()` rather than by whichever view happens to be
 * mounted (state management: "cross-store wiring"). What stays is the one effect
 * that fires because a view appeared. */
export default function QueryPage(props: { tabId: string }): JSX.Element {
  const schemaReady = useApp(selectSchemaReady);
  const presetsReady = useApp(selectPresetsReady);
  const { ensureRun } = useAppActions();

  // Auto-run the tab once, but only once both the schema and presets have
  // loaded so the compile can succeed — the effect re-runs as each resolves.
  // (Running before presets have loaded can throw "this query references a
  // preset that no longer exists" for a query that references one.)
  // `ensureRun` guards against duplicate runs (and against re-running on tab
  // switches).
  useEffect(() => {
    if (schemaReady && presetsReady) ensureRun(props.tabId);
  }, [props.tabId, schemaReady, presetsReady, ensureRun]);

  return (
    <div className="bg-panel flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <QueryToolbar tabId={props.tabId} />
        <QueryResults tabId={props.tabId} />
      </div>
      {/* The record editor's sidebar, when this tab has one open: `stage 8`
          ports `RecordEditorPanel`. Until then the page has no sidebar, which
          is what the record-editor specs are skipped for under the `react`
          Playwright project. */}
    </div>
  );
}
