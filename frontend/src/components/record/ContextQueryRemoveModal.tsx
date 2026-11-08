import type { JSX } from "react";
import { nounFor } from "../../query/entityNames";
import { selectContextualQuery } from "../../stores/app";
import type { RecordFormModel } from "../../stores/recordForm";
import { useApp, useAppActions, useFormState } from "../../stores/react";
import { Modal } from "../ui/Modal";

/** The confirmation before removing a contextual query, raised from its field's
 * context menu (`RecordFormActions.requestRemove`). Removing it takes its field
 * from every record of its table, so it's asked about first; cancelling (button,
 * scrim, or Esc) leaves it. Rendered once, at the form's root. */
export default function ContextQueryRemoveModal(props: {
  model: RecordFormModel;
}): JSX.Element | null {
  const { model } = props;
  const queryId = useFormState(model, (s) => s.removing);
  const query = useApp((s) =>
    queryId === null ? undefined : selectContextualQuery(s, queryId),
  );
  const { removeContextualQuery } = useAppActions();

  if (queryId === null || !query) return null;
  const noun = nounFor(query.tableName, 1) ?? query.tableName;

  return (
    <Modal onClose={() => model.cancelRemove()} width="300px">
      <h2 className="text-ink mb-3 text-base font-semibold">Remove query</h2>
      <p className="text-ink text-sm">
        Remove <span className="font-medium">&ldquo;{query.name}&rdquo;</span>{" "}
        from every {noun}?
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="control text-ink hover:bg-hover rounded-md"
          onClick={() => model.cancelRemove()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="control bg-danger rounded-md text-white"
          onClick={() => {
            model.cancelRemove();
            removeContextualQuery(queryId);
          }}
        >
          Remove
        </button>
      </div>
    </Modal>
  );
}
