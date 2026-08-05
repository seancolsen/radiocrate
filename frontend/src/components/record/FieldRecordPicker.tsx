import { Show, untrack } from "solid-js";
import RecordPicker from "../RecordPicker";
import { fieldItemId, type RecordFormModel } from "./formModel";
import { runRecordQuery } from "../../query/recordData";
import type { ScalarLinkField } from "../../query/recordForm";

/** The record picker for whichever field has one open, or nothing. Rendered
 * once per form, beside its context menu. Adapts the generic `RecordPicker` to
 * the record editor: resolves the field the open picker belongs to, seeds it
 * from the form's own preview generator, and wires its callbacks back into the
 * form model. */
export default function FieldRecordPicker(props: {
  model: RecordFormModel;
  schemaJson: string;
}) {
  /** The field the open picker belongs to — only ever a scalar linked record
   * field, which is the only kind that points at a single existing record. */
  const field = (recordId: string, fieldKey: string) => {
    const found = props.model
      .record(recordId)
      ?.fields.find((f) => f.key === fieldKey);
    return found?.kind === "scalarLink" ? found : undefined;
  };

  return (
    // Keyed on the target, so each opening starts from a fresh search rather
    // than from where the last one left off.
    <Show when={props.model.picker()} keyed>
      {(open) => (
        <Show when={field(open.recordId, open.fieldKey)}>
          {(target) => (
            <PickerAdapter
              model={props.model}
              schemaJson={props.schemaJson}
              recordId={open.recordId}
              field={target()}
            />
          )}
        </Show>
      )}
    </Show>
  );
}

function PickerAdapter(props: {
  model: RecordFormModel;
  schemaJson: string;
  recordId: string;
  field: ScalarLinkField;
}) {
  // One instance belongs to one field for its whole life (the `keyed` Show
  // above rebuilds it otherwise), so its subject is read once.
  const itemId = untrack(() => fieldItemId(props.recordId, props.field.key));
  const spec = untrack(() => props.model.previewSpec(props.field.table));

  /** Puts the user back on the field they came from, once the modal is gone.
   * Deferred a tick, since the field's row only regains its focusable label as
   * this modal unmounts. */
  const restoreFocus = () =>
    untrack(() => {
      const model = props.model;
      queueMicrotask(() => model.focusItem(itemId));
    });

  return (
    <RecordPicker
      table={props.field.table}
      keyColumn={props.field.keyColumn}
      initialSort={spec.sort}
      initialDisplay={spec.display.join(" ")}
      runQuery={(query) => runRecordQuery(query, props.schemaJson)}
      onPick={(keyValue, cells) => {
        props.model.pickRecord(props.recordId, props.field, keyValue, cells);
        restoreFocus();
      }}
      onCancel={() => {
        props.model.closePicker();
        restoreFocus();
      }}
      onCreate={(seed) => {
        props.model.closePicker();
        props.model.addLinkedRecord(props.recordId, props.field, seed);
      }}
    />
  );
}
