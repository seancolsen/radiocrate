import { createEffect, Show } from "solid-js";
import { useAppState } from "../state/store";
import QueryToolbar from "./QueryToolbar";
import QueryResults from "./QueryResults";
import RecordEditorPanel from "./RecordEditorPanel";

/** The content of an open tab: a toolbar over the results pane, with the record
 * editor as a sidebar beside them when one is open. Runs the tab's saved query
 * once when it's first viewed (opening a query shows rows without a manual
 * refresh click); the refresh button re-runs it.
 *
 * The record editor is scoped to the page in both senses: its state is per-tab
 * (switching tabs switches editors) and so is its layout — it narrows this
 * page's toolbar and results, while the tab bar and the now-playing bar above
 * and below keep their full width. */
export default function QueryPage(props: { tabId: string }) {
  const store = useAppState();
  // Auto-run the tab once, but only once the schema has loaded so the compile
  // can succeed — the effect re-runs when introspection resolves. `ensureRun`
  // guards against duplicate runs (and against re-running on tab switches).
  createEffect(() => {
    if (store.schemaReady()) store.ensureRun(props.tabId);
  });
  return (
    <div class="bg-panel flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <QueryToolbar tabId={props.tabId} />
        <QueryResults tabId={props.tabId} />
      </div>
      <Show when={store.recordEditor(props.tabId)}>
        {(record) => (
          <RecordEditorPanel tabId={props.tabId} record={record()} />
        )}
      </Show>
    </div>
  );
}
