// The `order` column of a multi-record field's records, when the user keeps them
// in an order of their own (`MultiRecordField.ordered`).
//
// The form never shows the column. It reads it to list the records in order,
// and writes it as they're added (at the end) and dragged to new places — so
// what's written is always just enough to say the order the user sees, and as
// few records as possible are changed by saying it.
//
// Pure: values in, values out — the form's values are the text the database
// gave it, and that's what comes back for anything left as it was.

/** The name of the column that orders a table's records. */
export const ORDER_COLUMN = "order";

/** A value as a number, or `undefined` when it isn't one (NULL, or text). */
function numberOf(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** The value for a record added at the end: one more than the greatest there
 * is, or 1 for the first. */
export function nextOrder(
  values: readonly (string | null | undefined)[],
): string {
  let max: number | undefined;
  for (const value of values) {
    const n = numberOf(value);
    if (n !== undefined && (max === undefined || n > max)) max = n;
  }
  return String(max === undefined ? 1 : Math.floor(max) + 1);
}

/** `ids` sorted by their values (`valueOf`), lowest first. The sort is stable,
 * and a record with no number sorts after every one that has. */
export function sortByOrder(
  ids: readonly string[],
  valueOf: (id: string) => string | null | undefined,
): string[] {
  return ids
    .map((id, at) => ({ id, at, n: numberOf(valueOf(id)) }))
    .sort((a, b) => {
      if (a.n === undefined || b.n === undefined) {
        if (a.n !== b.n) return a.n === undefined ? 1 : -1;
        return a.at - b.at;
      }
      return a.n - b.n || a.at - b.at;
    })
    .map(({ id }) => id);
}

/** The values that put records in the order given, from the values they have
 * now (in that same order): the same values, handed out again lowest first —
 * so a record moved between two others changes only itself and the ones it
 * passed, and nothing else. When they aren't all distinct numbers already,
 * there is no such reshuffle to make, and they're numbered 1, 2, 3… instead. */
export function reorderedValues(
  values: readonly (string | null | undefined)[],
): string[] {
  const numbers = values.map(numberOf);
  const distinct = new Set(numbers);
  if (
    numbers.some((n) => n === undefined) ||
    distinct.size !== numbers.length
  ) {
    return values.map((_, i) => String(i + 1));
  }
  return values
    .map((value, i) => ({ value: value as string, n: numbers[i] as number }))
    .sort((a, b) => a.n - b.n)
    .map(({ value }) => value);
}

/** The list `ids` with `moving` taken out and put back together, in the order
 * they had, at gap `gap` of the list as it was (0 before the first, its length
 * after the last). */
export function movedTo(
  ids: readonly string[],
  moving: readonly string[],
  gap: number,
): string[] {
  const taken = new Set(moving);
  const kept = (part: readonly string[]) => part.filter((id) => !taken.has(id));
  const inHand = ids.filter((id) => taken.has(id));
  return [...kept(ids.slice(0, gap)), ...inHand, ...kept(ids.slice(gap))];
}
