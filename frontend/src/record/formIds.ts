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

/** The node id of the record one *distinct* value of a scalar linked record
 * field points at. A field the records the form is on disagree about expands
 * into one node per value rather than the single {@link scalarChildId} they
 * would share, so each of them can be previewed — and opened — on its own. */
export function variedChildId(
  recordId: string,
  fieldKey: string,
  value: string,
): string {
  return `${recordId}>${fieldKey}=${value}`;
}

/** Those ids for one field, in the order the values first appear. Derived from
 * the column's per-record values, so the save planner and the modification walk
 * find the nodes the form created under a disagreeing field without having to
 * be told about them. NULL and the empty string name no record, so they get no
 * node — the list offers them as values to apply, nothing to open. */
export function variedChildIds(
  recordId: string,
  fieldKey: string,
  values: readonly (string | null)[] | undefined,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (value == null || value === "" || seen.has(value)) continue;
    seen.add(value);
    ids.push(variedChildId(recordId, fieldKey, value));
  }
  return ids;
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
