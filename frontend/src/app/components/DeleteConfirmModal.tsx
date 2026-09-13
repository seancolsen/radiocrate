import type { JSX } from "react";
import { useApp, useAppActions } from "../stores/react";
import { Modal } from "./ui/Modal";

/** The delete-query confirmation dialog. Confirming deletes the query (backend
 * + tab); cancelling (button, scrim, or Esc) dismisses. A note flags a query
 * with unsaved edits so they aren't discarded unknowingly. */
export default function DeleteConfirmModal(): JSX.Element | null {
  const pending = useApp((s) => s.pendingDelete);
  const { cancelDelete, confirmDelete } = useAppActions();

  if (!pending) return null;

  return (
    <Modal onClose={() => cancelDelete()} width="300px">
      <h2 className="text-ink mb-3 text-base font-semibold">Delete query</h2>
      <p className="text-ink text-sm">
        Delete <span className="font-medium">&ldquo;{pending.name}&rdquo;</span>
        ?
      </p>
      {pending.unsaved && (
        <p className="text-accent mt-1 text-sm">
          This query has unsaved changes.
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => cancelDelete()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="bg-danger rounded-md px-3 py-1.5 text-sm text-white"
          onClick={() => confirmDelete()}
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}
