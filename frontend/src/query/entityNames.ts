// How the UI speaks of database tables in English: "1 track", "10 artists",
// "Edit 2 credits".
//
// Pure data and two lookups, so the framework-free modules can use it.

/** Table name → `[singular, plural]` noun. Multi-word tables drop their
 * underscores (`playlist_track` → "playlist track").
 *
 * KEEP THIS IN STEP WITH THE SCHEMA: every migration that adds, renames or
 * drops a user-facing table (backend/src/migrations/) updates this table in
 * the same change. Internal bookkeeping tables (`meta`, `migration_`) are
 * deliberately absent. A table missing here — a user-created table the
 * introspection system discovered, say — is expected; callers go through
 * {@link entityNames} and fall back gracefully. */
export const ENTITY_NAMES: Readonly<Record<string, readonly [string, string]>> =
  {
    album: ["album", "albums"],
    artist: ["artist", "artists"],
    contextual_query: ["contextual query", "contextual queries"],
    credit: ["credit", "credits"],
    deletion: ["deletion", "deletions"],
    file: ["file", "files"],
    play: ["play", "plays"],
    playlist: ["playlist", "playlists"],
    playlist_track: ["playlist track", "playlist tracks"],
    preset: ["preset", "presets"],
    query: ["query", "queries"],
    query_folder: ["query folder", "query folders"],
    rating: ["rating", "ratings"],
    role: ["role", "roles"],
    settings: ["setting", "settings"],
    source: ["source", "sources"],
    tag: ["tag", "tags"],
    track: ["track", "tracks"],
    track_tag: ["track tag", "track tags"],
  };

/** The `[singular, plural]` nouns for `table`, or `undefined` when the mapping
 * doesn't know it. */
export function entityNames(
  table: string | null | undefined,
): readonly [string, string] | undefined {
  if (!table) return undefined;
  const key = table.trim().toLowerCase();
  return Object.hasOwn(ENTITY_NAMES, key) ? ENTITY_NAMES[key] : undefined;
}

/** `table`'s noun for a count of `n`, or `undefined` for an unknown table. */
export function nounFor(
  table: string | null | undefined,
  n: number,
): string | undefined {
  const names = entityNames(table);
  return names && names[n === 1 ? 0 : 1];
}

/** `table`'s plural noun, falling back to the raw table name when unknown. */
export function pluralOrRaw(table: string): string {
  return entityNames(table)?.[1] ?? table;
}
