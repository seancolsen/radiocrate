import { createEffect } from "solid-js";
import { useAppState } from "../state/store";
import QueryToolbar from "./QueryToolbar";
import QueryResults from "./QueryResults";

/** The content of an open tab: a refresh-only toolbar over a plain-text results
 * pane. Runs the tab's saved query once when it's first viewed (opening a query
 * shows rows without a manual refresh click); the refresh button re-runs it. */
export default function QueryPage(props: { tabId: string }) {
  const store = useAppState();
  // Auto-run the tab once, but only once the schema has loaded so the compile
  // can succeed — the effect re-runs when introspection resolves. `ensureRun`
  // guards against duplicate runs (and against re-running on tab switches).
  createEffect(() => {
    if (store.schemaReady()) store.ensureRun(props.tabId);
  });
  return (
    <div class="bg-panel flex min-h-0 flex-1 flex-col">
      <QueryToolbar tabId={props.tabId} />
      <QueryResults tabId={props.tabId} />
    </div>
  );
}
