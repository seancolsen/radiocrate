import type { JSX } from "react";
import { nounFor } from "../../query/entityNames";
import { selectContextualQuery } from "../../stores/app";
import type { RecordFormModel } from "../../stores/recordForm";
import { useApp, useAppActions, useFormState } from "../../stores/react";
import { Modal } from "../ui/Modal";

/** The confirmation before removing contextual query `queryId`, or nothing
 * while there's none to ask about. Removing it takes its field from every
 * record of its table, so it's asked about first; cancelling (button, scrim, or
 * Esc) leaves it. Raised from a contextual query's context menu: the record
 * editor's (below) and the Data structure page's. */
export function RemoveQueryModal(props: {
  queryId: string | null;
  onClose: () => void;
}): JSX.Element | null {
  const { queryId, onClose } = props;
  const query = useApp((s) =>
    queryId === null ? undefined : selectContextualQuery(s, queryId),
  );
  const { removeContextualQuery } = useAppActions();

  if (queryId === null || !query) return null;
  const noun = nounFor(query.tableName, 1) ?? query.tableName;

  return (
    <Modal onClose={onClose} width="300px">
      <h2 className="text-ink mb-3 text-base font-semibold">Remove query</h2>
      <p className="text-ink text-sm">
        Remove <span className="font-medium">&ldquo;{query.name}&rdquo;</span>{" "}
        from every {noun}?
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
            removeContextualQuery(queryId);
          }}
        >
          Remove
        </button>
      </div>
    </Modal>
  );
}

/** The record editor's confirmation, for the query its form was asked to
 * remove (`RecordFormActions.requestRemove`). Rendered once, at the form's
 * root. */
export default function ContextQueryRemoveModal(props: {
  model: RecordFormModel;
}): JSX.Element | null {
  const { model } = props;
  const queryId = useFormState(model, (s) => s.removing);
  return (
    <RemoveQueryModal queryId={queryId} onClose={() => model.cancelRemove()} />
  );
}
