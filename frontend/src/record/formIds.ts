// The record editor's node ids.
//
// The form's state lives in flat, id-keyed maps rather than a nested store (see
// `formModel.ts` for why), and these functions are the ids: each encodes a path
// through the tree, so every update is a single-key write and a node's identity
// survives being collapsed and expanded again.
//
// They sit apart from the model because the save planner (`formSave.ts`) walks
// the same tree without any of the model's reactive machinery.

/** The root record's node id — the record the sidebar was opened on. */
export const ROOT_ID = "r";

/** The node id of the record behind a scalar linked record field. Also the id of
 * that field's embedded record. */
export function scalarChildId(recordId: string, fieldKey: string): string {
  return `${recordId}>${fieldKey}`;
}

/** The node id of a multi-record field's child list. */
export function listId(recordId: string, fieldKey: string): string {
  return `${recordId}#${fieldKey}`;
}

/** The node id of the nth record within a child list. */
export function childId(list: string, index: number): string {
  return `${list}[${index}]`;
}

/** The node id of the nth record fetched from a child list *only to delete it* —
 * what clearing a multi-record field the user never opened has to look up. Kept
 * distinct from {@link childId} so a record on its way out can't land on top of
 * one the list is showing. */
export function deletedChildId(list: string, index: number): string {
  return `${list}[-${index}]`;
}

/** The node id of the nth record the form has *created* within a child list —
 * one that has no position in anything loaded to take an index from. */
export function newChildId(list: string, seq: number): string {
  return `${list}[new:${seq}]`;
}

/** The id an expandable/editable *field* is tracked under. Records have their
 * own ids; a field is one of its record's, qualified by field key. */
export function fieldItemId(recordId: string, fieldKey: string): string {
  return `${recordId}:${fieldKey}`;
}
