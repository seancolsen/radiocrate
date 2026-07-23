import { useAppState } from "../state/store";

/** The results pane: the query's rows rendered as plain text (fields
 * space-joined, rows newline-joined; see api/query.ts) in a scrollable
 * monospace block. No headers, columns, or formatting — plain text is the whole
 * renderer this phase (§6). */
export default function QueryResults(props: { tabId: string }) {
  const store = useAppState();
  return (
    <pre class="text-ink min-h-0 flex-1 overflow-auto p-3 font-mono text-sm whitespace-pre">
      {store.state.resultsByTab[props.tabId] ?? ""}
    </pre>
  );
}
