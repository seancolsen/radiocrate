import { useState, type JSX } from "react";
import RecordPicker from "../RecordPicker";
import {
  fieldItemId,
  selectFieldOf,
  type RecordFormModel,
} from "../../stores/recordForm";
import { useFormState } from "../../stores/react";
import { runRecordQuery } from "../../query/recordData";
import type { ScalarLinkField } from "../../query/recordForm";

/** The record picker for whichever field has one open, or nothing. Rendered
 * once per form, beside its context menu. Adapts the generic `RecordPicker` to
 * the record editor: resolves the field the open picker belongs to, seeds it
 * with what the field's embedded record shows, so what's picked already reads as
 * one, and wires its callbacks back into the form model. */
export default function FieldRecordPicker(props: {
  model: RecordFormModel;
  schemaJson: string;
}): JSX.Element | null {
  const { model } = props;
  const open = useFormState(model, (s) => s.picker);
  /** The field the open picker belongs to — only ever a scalar linked record
   * field, which is the only kind that points at a single existing record. */
  const field = useFormState(model, (s) => {
    if (!s.picker) return undefined;
    const found = selectFieldOf(s, s.picker.recordId, s.picker.fieldKey);
    return found?.kind === "scalarLink" ? found : undefined;
  });

  if (!open || !field) return null;
  return (
    // Keyed on the target, so each opening starts from a fresh search rather
    // than from where the last one left off. (The picker is modal, so it always
    // closes — unmounting this — before it can be opened again.)
    <PickerAdapter
      key={`${open.recordId}\n${open.fieldKey}\n${open.distinct ? `=${open.distinct.value}` : ""}`}
      model={model}
      schemaJson={props.schemaJson}
      recordId={open.recordId}
      field={field}
      distinct={open.distinct}
    />
  );
}

function PickerAdapter(props: {
  model: RecordFormModel;
  schemaJson: string;
  recordId: string;
  field: ScalarLinkField;
  /** The distinct value whose records the pick re-points, when the field's
   * records disagree — absent for an ordinary pick, which re-points them all. */
  distinct?: { value: string | null };
}): JSX.Element {
  const { model, schemaJson, recordId, field, distinct } = props;
  // One instance belongs to one field for its whole life (the key above
  // rebuilds it otherwise), so its subject is read once.
  const [itemId] = useState(() => fieldItemId(recordId, field.key));
  const [spec] = useState(() => model.fieldSpec(recordId, field));

  /** Puts the user back on the field they came from, once the modal is gone.
   * Deferred a tick, since the field's row only regains its focusable label as
   * this modal unmounts — the store write that closes the picker has already
   * queued React's re-render ahead of this. */
  const restoreFocus = () => queueMicrotask(() => model.focusItem(itemId));

  return (
    <RecordPicker
      table={field.table}
      keyColumn={field.keyColumn}
      initialSort={spec.sort}
      initialDisplay={spec.display.join(" ")}
      runQuery={(query) => runRecordQuery(query, schemaJson)}
      onPick={(keyValue, cells) => {
        if (distinct) {
          model.pickDistinctRecord(
            recordId,
            field,
            distinct.value,
            keyValue,
            cells,
          );
        } else {
          model.pickRecord(recordId, field, keyValue, cells);
        }
        restoreFocus();
      }}
      onCancel={() => {
        model.closePicker();
        restoreFocus();
      }}
      // A record created for a field points every record the form is on at
      // it (`planSave` references the insert from all of them), so it isn't
      // offered for a pick meant to re-point only some of them.
      onCreate={
        distinct
          ? undefined
          : (seed) => {
              model.closePicker();
              model.addLinkedRecord(recordId, field, seed);
            }
      }
    />
  );
}
