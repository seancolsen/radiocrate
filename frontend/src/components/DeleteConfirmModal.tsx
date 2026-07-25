import { Show, type JSX } from "solid-js";
import { useAppState } from "../state/store";
import { Modal } from "./ui/Modal";

/** The delete-query confirmation dialog. Confirming deletes the query (backend
 * + tab); cancelling (button, scrim, or Esc) dismisses. A note flags a query
 * with unsaved edits so they aren't discarded unknowingly. */
export default function DeleteConfirmModal(): JSX.Element {
  const store = useAppState();
  const pending = () => store.state.pendingDelete;

  return (
    <Show when={pending()}>
      {(p) => (
        <Modal onClose={() => store.cancelDelete()} width="300px">
          <h2 class="text-ink mb-3 text-base font-semibold">Delete query</h2>
          <p class="text-ink text-sm">
            Delete <span class="font-medium">&ldquo;{p().name}&rdquo;</span>?
          </p>
          <Show when={p().unsaved}>
            <p class="text-accent mt-1 text-sm">
              This query has unsaved changes.
            </p>
          </Show>
          <div class="mt-4 flex justify-end gap-2">
            <button
              type="button"
              class="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
              onClick={() => store.cancelDelete()}
            >
              Cancel
            </button>
            <button
              type="button"
              class="bg-danger rounded-md px-3 py-1.5 text-sm text-white"
              onClick={() => store.confirmDelete()}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </Show>
  );
}
