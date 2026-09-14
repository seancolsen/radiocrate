// Reads over one form's state — pure functions of a `FormState` snapshot, which
// is what the Solid model's read accessors (`value`, `count`, `isExpanded`,
// `isFieldModified`, …) became. Components call them inside
// `useFormState(model, (s) => …)`; the model's own actions call them on
// `get()`.
//
// Every one returns a primitive or a reference already in state, except
// `selectFormSummary`, which builds a fresh object (state management rule 2) —
// the forms store compares it shallowly, and nothing renders from it directly.

import type { FormField, ScalarLinkField } from "../../../query/recordForm";
import {
  fieldItemId,
  listId,
  ROOT_ID,
  scalarChildId,
} from "../../../record/formIds";
import {
  isShared,
  shared,
  VARIED,
  type SharedValue,
  type Varied,
} from "../../../record/formValues";
import type { RecordFormSummary } from "../forms";
import type { EmbedNode, FormState, ListNode, RecordNode } from "./state";

/** A record node by id — `undefined` before it exists (nothing expanded yet). */
export const selectRecord = (
  s: FormState,
  id: string,
): RecordNode | undefined => s.records[id];

/** A child list by id, likewise. */
export const selectList = (s: FormState, id: string): ListNode | undefined =>
  s.lists[id];

/** An embedded record's preview by id, likewise. */
export const selectEmbed = (s: FormState, id: string): EmbedNode | undefined =>
  s.embeds[id];

/** What one field of a node shows: the value its records share, `VARIED` when
 * they don't share one, `undefined` before it loads (see `formValues.ts`). */
export const selectSharedValue = (
  s: FormState,
  recordId: string,
  column: string,
): SharedValue => shared(s.records[recordId]?.values[column]);

/** Likewise for a multi-record field's count of related records. */
export const selectCount = (
  s: FormState,
  recordId: string,
  fieldKey: string,
): number | Varied | undefined => shared(s.records[recordId]?.counts[fieldKey]);

/** Whether an item (field or child record) is expanded. */
export const selectIsExpanded = (s: FormState, itemId: string): boolean =>
  s.expanded[itemId] === true;

/** Whether an embedded record is part of the selection. */
export const selectIsSelected = (s: FormState, itemId: string): boolean =>
  s.selection.includes(itemId);

/** A node's field by key. */
export const selectFieldOf = (
  s: FormState,
  recordId: string,
  fieldKey: string,
): FormField | undefined =>
  s.records[recordId]?.fields.find((f) => f.key === fieldKey);

/** Whether a field is beyond what the form will do to several records at once:
 * a multi-record field, whose child records bulk modification doesn't reach
 * yet, or a scalar field the records disagree on, which shows "(varied)" and
 * has no one value to edit from. False for a single record, which can neither
 * disagree with itself nor be a bulk anything — this is the whole of the
 * form's behavioral difference between one record and many. */
export function selectBeyondBulk(
  s: FormState,
  recordId: string,
  field: FormField,
): boolean {
  const node = s.records[recordId];
  if (!node || node.keys.length <= 1) return false;
  if (field.kind === "multiRecord") return true;
  return selectSharedValue(s, recordId, field.column) === VARIED;
}

/** Whether a field is out of reach for as long as the form is on more than one
 * record (see {@link selectBeyondBulk}). Always false on a single record. Every
 * modification asks this first; the context menu asks it to gray its entries
 * out. */
export function selectIsBulkBlocked(
  s: FormState,
  recordId: string,
  fieldKey: string,
): boolean {
  const field = selectFieldOf(s, recordId, fieldKey);
  return field !== undefined && selectBeyondBulk(s, recordId, field);
}

/** Whether a scalar linked record field has a record to show: one it points
 * at, or a new one the user is entering into it. */
export function selectHasLinkedRecord(
  s: FormState,
  recordId: string,
  field: ScalarLinkField,
): boolean {
  // Records pointing at *different* records have none to show between them.
  const value = selectSharedValue(s, recordId, field.column);
  if (isShared(value) && value != null && value !== "") return true;
  return s.records[scalarChildId(recordId, field.key)]?.isNew === true;
}

// ── Modification ───────────────────────────────────────────────────────────
//
// Nothing is written to the database until the user saves, so "modified" is a
// question the form answers by comparing what it holds against the baseline it
// loaded — and by remembering the structural edits that no single value
// records (a list gaining or losing a record, a record being created).
//
// The two functions below recurse into each other, so a field reports the
// edits made *inside* it as its own: a star on a collapsed field says there's
// something changed somewhere under it. The recursion only ever visits nodes
// that exist — what the user has opened — and node ids strictly grow as it
// descends, so it terminates.
//
// A record being *created* counts as modified here — its parent's field (a
// dirty list, a changed foreign key) is what a star on *that* field means.
// The record's own star, and its own fields', are a display-layer question:
// the record fields view suppresses those directly, since a record still being
// filled in to insert it has nothing of its own to compare against yet.
//
// Every visible row asks, on every keystroke, so answers are memoized per
// snapshot: Immer gives each write a new root object, so a `WeakMap` keyed on
// the root holds exactly one keystroke's answers, and the whole form's stars
// cost O(nodes) per write however many rows subscribe.

const modifiedCache = new WeakMap<FormState, Map<string, boolean>>();

function memoFor(s: FormState): Map<string, boolean> {
  let memo = modifiedCache.get(s);
  if (!memo) {
    memo = new Map();
    modifiedCache.set(s, memo);
  }
  return memo;
}

/** Whether one column has drifted from its baseline in any of the records the
 * node stands for. */
function columnModified(node: RecordNode, column: string): boolean {
  const values = node.values[column];
  const original = node.original[column];
  if (!values) return false;
  return values.some((value, i) => value !== original?.[i]);
}

function fieldModified(
  s: FormState,
  memo: Map<string, boolean>,
  recordId: string,
  field: FormField,
): boolean {
  const memoKey = `f ${fieldItemId(recordId, field.key)}`;
  const cached = memo.get(memoKey);
  if (cached !== undefined) return cached;
  let result: boolean;
  const node = s.records[recordId];
  if (!node) {
    result = false;
  } else if (field.kind === "multiRecord") {
    const list = s.lists[listId(recordId, field.key)];
    result =
      list !== undefined &&
      (list.dirty ||
        list.childIds.some((child) => recordModified(s, memo, child)));
  } else if (columnModified(node, field.column)) {
    result = true;
  } else {
    result =
      field.kind === "scalarLink" &&
      recordModified(s, memo, scalarChildId(recordId, field.key));
  }
  memo.set(memoKey, result);
  return result;
}

function recordModified(
  s: FormState,
  memo: Map<string, boolean>,
  recordId: string,
): boolean {
  const memoKey = `r ${recordId}`;
  const cached = memo.get(memoKey);
  if (cached !== undefined) return cached;
  const node = s.records[recordId];
  const result =
    node !== undefined &&
    (node.isNew ||
      node.fields.some((field) => fieldModified(s, memo, recordId, field)));
  memo.set(memoKey, result);
  return result;
}

/** Whether one record carries an unsaved edit, at any depth. */
export function selectRecordModified(s: FormState, recordId: string): boolean {
  return recordModified(s, memoFor(s), recordId);
}

/** Whether one field carries an unsaved edit — its own, or one anywhere in
 * what it expands into. What the red star is drawn from. */
export function selectFieldModified(
  s: FormState,
  recordId: string,
  fieldKey: string,
): boolean {
  const field = selectFieldOf(s, recordId, fieldKey);
  return field !== undefined && fieldModified(s, memoFor(s), recordId, field);
}

/** Whether the form as a whole has unsaved changes. */
export const selectFormModified = (s: FormState): boolean =>
  selectRecordModified(s, ROOT_ID);

/** What the forms store mirrors out of this form (see `RecordFormSummary`):
 * the pieces `formRegistry.ts`/`formStash.ts` read off the Solid model —
 * `focused()`, `selection()`, `picker()`, `isModified()`. A fresh object on
 * every call. */
export function selectFormSummary(s: FormState): RecordFormSummary {
  return {
    focused: s.focused !== null,
    selecting: s.selection.length > 0,
    pickerOpen: s.picker !== null,
    modified: selectFormModified(s),
  };
}
