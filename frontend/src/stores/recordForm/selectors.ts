// Reads over one form's state — pure functions of a `FormState` snapshot.
// Components call them inside
// `useFormState(model, (s) => …)`; the model's own actions call them on
// `get()`.
//
// Every one returns a primitive or a reference already in state, except
// `selectFormSummary`, which builds a fresh object (state management rule 2) —
// the forms store compares it shallowly, and nothing renders from it directly.

import type { FormField, ScalarLinkField } from "../../query/recordForm";
import {
  fieldItemId,
  listId,
  ROOT_ID,
  scalarChildId,
  variedChildIds,
} from "../../record/formIds";
import {
  isShared,
  shared,
  VARIED,
  type ColumnValues,
  type SharedValue,
} from "../../record/formValues";
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

/** How many database records a node stands for: one, ordinarily; as many as the
 * result-row selection holds, at the root; and — for a row of a multi-record
 * field — as many as agreed on everything but which base record they hang off
 * (`record/childGroups.ts`). */
export const selectRecordCount = (s: FormState, recordId: string): number =>
  s.records[recordId]?.keys.length ?? 0;

/** The least and greatest number of related records a multi-record field has,
 * across the records its node stands for. `undefined` before the counts land.
 *
 * Two selectors over one private reading rather than one returning a range:
 * a selector returns a primitive (state management rule 2), and a fresh
 * `{ min, max }` would re-render its row on every write to the form. */
function countRange(
  s: FormState,
  recordId: string,
  fieldKey: string,
): [number, number] | undefined {
  const counts = s.records[recordId]?.counts[fieldKey];
  if (!counts || counts.length === 0) return undefined;
  return [Math.min(...counts), Math.max(...counts)];
}

export const selectCountMin = (
  s: FormState,
  recordId: string,
  fieldKey: string,
): number | undefined => countRange(s, recordId, fieldKey)?.[0];

export const selectCountMax = (
  s: FormState,
  recordId: string,
  fieldKey: string,
): number | undefined => countRange(s, recordId, fieldKey)?.[1];

/** One value a node's records hold in a column, and how many of them hold it. */
export interface DistinctValue {
  value: string | null;
  count: number;
}

/** Nothing to choose between — one shared reference, so a caller falling back
 * to it gets the same value every time. */
const NO_DISTINCT_VALUES: readonly DistinctValue[] = [];

/** The values a node's records hold in one column, when they don't all hold the
 * same one: the commonest first, ties broken by the values themselves. Empty
 * when they agree, or before the column loads — a value every record holds is
 * not a choice to be offered.
 *
 * Pure in the column's values rather than a selector over the whole state,
 * because it builds a list: a component reads the column — a reference already
 * in state (state management rule 2) — and `useMemo`s this over it, so the rows
 * it renders survive every write that isn't to that column. */
export function distinctValues(
  values: ColumnValues | undefined,
): readonly DistinctValue[] {
  if (!values || values.length === 0) return NO_DISTINCT_VALUES;
  const counts = new Map<string | null, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (counts.size === 1) return NO_DISTINCT_VALUES;
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort(
      (a, b) =>
        b.count - a.count || String(a.value).localeCompare(String(b.value)),
    );
}

/** How many of them there are — the primitive a row shows in place of the one
 * value it hasn't got. */
export const selectDistinctCount = (
  s: FormState,
  recordId: string,
  column: string,
): number => distinctValues(s.records[recordId]?.values[column]).length;

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
 * a scalar field the records disagree on, which has no one value to edit from,
 * clear, or point somewhere else. It still *expands* — into the distinct values
 * the records hold, any one of which the user can take for all of them
 * (`RecordFields.tsx`'s `DistinctValues`), which is how such a field gets a
 * value to edit in the first place. False for a single record, which can
 * neither disagree with itself nor be a bulk anything — this is the whole of
 * the form's behavioral difference between one record and many.
 *
 * A multi-record field is *not* among them: its records group into rows that
 * say the same thing about every base record they hang off, and editing one row
 * edits all of them (`record/childGroups.ts`). */
export function selectBeyondBulk(
  s: FormState,
  recordId: string,
  field: FormField,
): boolean {
  const node = s.records[recordId];
  if (!node || node.keys.length <= 1) return false;
  if (field.kind === "multiRecord") return false;
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

/** Whether a scalar linked record field has *one* record to show: one every
 * record the form is on points at, or a new one the user is entering into it.
 * False when they point at different records — that field shows its distinct
 * values instead (see {@link selectBeyondBulk}). */
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
  } else if (field.kind === "scalarLink") {
    // The record the field points at, or — when the form's records point at
    // different ones — any of the records its distinct values opened into.
    result =
      recordModified(s, memo, scalarChildId(recordId, field.key)) ||
      variedChildIds(recordId, field.key, node.values[field.column]).some(
        (id) => recordModified(s, memo, id),
      );
  } else {
    result = false;
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
 * whether it holds focus, a selection or its picker, and whether it's modified.
 * A fresh object on every call. */
export function selectFormSummary(s: FormState): RecordFormSummary {
  return {
    focused: s.focused !== null,
    selecting: s.selection.length > 0,
    pickerOpen: s.picker !== null,
    modified: selectFormModified(s),
  };
}
