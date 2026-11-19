import type { JSX } from "react";
import { nounFor } from "../../query/entityNames";
import type { RecordFormModel } from "../../stores/recordForm";
import { useAppActions, useFormState } from "../../stores/react";
import { Modal } from "../ui/Modal";

/** The confirmation before removing one of the user's computed columns, or
 * nothing while there's none to ask about. Removing it takes its field from
 * every record of its table, and its name out from under any query that uses
 * it, so it's asked about first; cancelling (button, scrim, or Esc) leaves it.
 * Raised from a computed column's context menu: the record editor's (below)
 * and the Data structure page's. */
export function RemoveComputedColumnModal(props: {
  column: { table: string; name: string } | null;
  onClose: () => void;
}): JSX.Element | null {
  const { column, onClose } = props;
  const { removeComputedColumn } = useAppActions();

  if (column === null) return null;
  const noun = nounFor(column.table, 1) ?? column.table;

  return (
    <Modal onClose={onClose} width="320px">
      <h2 className="text-ink mb-3 text-base font-semibold">
        Remove computed column
      </h2>
      <p className="text-ink text-sm">
        Remove <span className="font-medium">&ldquo;{column.name}&rdquo;</span>{" "}
        from every {noun}? A query that uses it will stop working.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="control text-ink hover:bg-hover rounded-md"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="control bg-danger rounded-md text-white"
          onClick={() => {
            onClose();
            removeComputedColumn(column.table, column.name);
          }}
        >
          Remove
        </button>
      </div>
    </Modal>
  );
}

/** The record editor's confirmation, for the computed column its form was
 * asked to remove (`RecordFormActions.requestRemoveComputed`). Rendered once,
 * at the form's root. */
export default function ComputedColumnRemoveModal(props: {
  model: RecordFormModel;
}): JSX.Element | null {
  const { model } = props;
  const column = useFormState(model, (s) => s.removingComputed);
  return (
    <RemoveComputedColumnModal
      column={column}
      onClose={() => model.cancelRemoveComputed()}
    />
  );
}
