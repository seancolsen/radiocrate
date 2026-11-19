// The arithmetic of a list the user arranges by hand, whose items each may hold a
// sort key: a record editor's fields (`fieldMetadata.ts`), the app's tables
// (`tableSettings.ts`). An item without a key keeps its default place after
// those with one, and moving an item writes as few keys as it can. Pure.

import { dropPositions } from "./playlistEntries";

/** `items`, given in their default order, in the order the user has arranged
 * them: those with a sort key first, by that key, then those without, as they
 * came. */
export function byOrder<T>(
  items: readonly T[],
  orderOf: (item: T) => number | null | undefined,
): T[] {
  const rank = (item: T) => orderOf(item) ?? Infinity;
  // `sort` is stable, which is what keeps the rest in their default order. Not
  // a subtraction, because two infinities subtract to NaN.
  return [...items].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** One item's new sort key. */
export interface SortKeyChange<T> {
  item: T;
  order: number;
}

/** The sort keys that put item `moved` between the items shown just above and
 * just below where it was dropped, either of which is `undefined` at an edge.
 * `items` is every item in its default order, told apart by `keyOf`, and empty
 * is what comes back when `moved` would go nowhere.
 *
 * The list may be showing fewer items than there are, since hidden ones leave
 * gaps. The item goes right beside the neighbor it was dropped next to, ahead of
 * anything hidden between the two.
 *
 * When every item already has a sort key, only `moved` needs a new one, between
 * those of the items now on either side of it. Otherwise, or when those two are
 * too close for a value to fit between them, every item is resequenced to 1…n in
 * the new order, leaving out those already holding their new key. */
export function moveOrders<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  orderOf: (item: T) => number | null | undefined,
  moved: T,
  above: T | undefined,
  below: T | undefined,
): SortKeyChange<T>[] {
  const current = byOrder(items, orderOf);
  const indexOf = (list: readonly T[], item: T) =>
    list.findIndex((other) => keyOf(other) === keyOf(item));
  const from = indexOf(current, moved);
  if (from < 0) return [];
  const rest = current.filter((_, i) => i !== from);
  const at =
    above !== undefined
      ? indexOf(rest, above) + 1
      : below !== undefined
        ? indexOf(rest, below)
        : -1;
  // A neighbor that's gone leaves nothing to go by: the index is -1, or 0 once
  // `above` has added its 1.
  if (at < 0 || (above !== undefined && at === 0)) return [];
  if (at === from) return [];

  const keyed = (item: T | undefined) =>
    item === undefined ? undefined : (orderOf(item) ?? undefined);
  if (current.every((item) => keyed(item) !== undefined)) {
    const fit = dropPositions(keyed(rest[at - 1]), keyed(rest[at]), 1);
    if (fit) return [{ item: moved, order: fit[0] }];
  }
  const next = [...rest.slice(0, at), moved, ...rest.slice(at)];
  return next.flatMap((item, i) =>
    orderOf(item) === i + 1 ? [] : [{ item, order: i + 1 }],
  );
}
