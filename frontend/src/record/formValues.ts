// One column, across the records a form node stands for.
//
// The record editor is always on a *set* of records — one, ordinarily, but the
// result-row selection can widen it to any number, and it's the same form either
// way (spec: "Dynamic updates"). So a node doesn't hold a value per field: it
// holds one value per field *per record*, index-aligned to the record's key
// (`RecordNode.keys`), and what the form shows is whatever those records agree
// on.
//
// That agreement is the form's one real question about how many records it's
// editing, and it's asked here rather than at any branch above: a field whose
// records agree is a field the user edits exactly as they always have, and the
// edit lands on all of them; a field they disagree on shows "(varied)" and, for
// now, isn't editable at all.

/** Stands for a column the records don't agree on. */
export const VARIED = Symbol("varied");
export type Varied = typeof VARIED;

/** What one field shows: the value every record holds (`null` for a NULL they
 * all hold), {@link VARIED} when they differ, or `undefined` when nothing has
 * loaded for it yet. */
export type SharedValue = string | null | Varied | undefined;

/** One column's value in each of the records a node stands for, index-aligned to
 * its keys. */
export type ColumnValues = readonly (string | null)[];

/** What a column's per-record values come to: the one they share, or
 * {@link VARIED}. `undefined` for values that haven't loaded — which is what a
 * node holds for every field but its key until its data lands. */
export function shared<T>(
  values: readonly T[] | undefined,
): T | Varied | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const first = values[0];
  return values.every((value) => value === first) ? first : VARIED;
}

/** Whether a shared reading is a value the form can render and edit, rather than
 * a disagreement or a blank. Narrows {@link VARIED} away. */
export function isShared<T>(value: T | Varied | undefined): value is T {
  return value !== VARIED && value !== undefined;
}
