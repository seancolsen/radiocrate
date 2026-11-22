// Structural equality for the plain data the backend's lists are made of:
// primitives, arrays and plain objects (JSON, give or take `undefined`).

/** Whether `a` and `b` hold the same plain data. Arrays compare in order;
 * objects by their own enumerable keys, so `{ x: undefined }` and `{}` differ,
 * as they would to `in`. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return (
      a.length === other.length && a.every((x, i) => deepEqual(x, other[i]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && deepEqual(left[key], right[key]))
  );
}

/** `next`, or `previous` when the two hold the same data — so a refetch that
 * changed nothing leaves state holding the reference it already had, and
 * nothing watching it by reference hears of it. */
export function keepIfEqual<T>(previous: T, next: T): T {
  return deepEqual(previous, next) ? previous : next;
}
