import { Show, type JSX } from "solid-js";
import { useAppState } from "../state/store";
import { Modal } from "./ui/Modal";

/** The "View SQL" dialog: the working query compiled to DuckDB SQL (read-only).
 * Compilation happens in `openViewSql`; this just displays the result. */
export default function ViewSqlModal(): JSX.Element {
  const store = useAppState();
  return (
    <Show when={store.state.viewSql != null}>
      <Modal onClose={() => store.closeViewSql()} width="640px">
        <h2 class="text-ink mb-3 text-base font-semibold">SQL</h2>
        <pre class="bg-sheet text-ink max-h-[60vh] overflow-auto rounded-md p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
          {store.state.viewSql}
        </pre>
        <div class="mt-4 flex justify-end">
          <button
            type="button"
            class="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
            onClick={() => store.closeViewSql()}
          >
            Close
          </button>
        </div>
      </Modal>
    </Show>
  );
}
