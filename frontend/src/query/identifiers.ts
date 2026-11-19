// Names the user types for things a query refers to by name — a computed
// column, a custom comparison — made into names a query can say.

/** `typed` as Querydown's unquoted identifier, which begins with a letter or an
 * underscore and holds only letters, digits and underscores. Anything else in
 * it becomes an underscore ("last play" is `last_play`), and nothing at all is
 * `fallback`. */
export function legalIdentifier(typed: string, fallback: string): string {
  const name = typed
    .split(/[^A-Za-z0-9_]+/)
    .filter((part) => part !== "")
    .join("_");
  if (name === "") return fallback;
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** The name something gets for what the user `typed`: that, made legal
 * (`legalIdentifier`), and numbered when it's `taken` — lowercased names —
 * (`year_2`). */
export function availableIdentifier(
  typed: string,
  taken: ReadonlySet<string>,
  fallback: string,
): string {
  const base = legalIdentifier(typed, fallback);
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
