// Ignoring albums as they're deleted: a record that the user decided against
// an album, so they know not to download it again (migration 0022).
//
// The planner (`deletePlan.ts`) knows no table by name; this module knows the
// three ignoring takes. An ignored album is planned as a deletion that keeps
// the `album` records asked for (`PlanOptions.keep`): their tracks and the rest
// go as the dialog's choices say, the album stays with its title and year, and
// the request goes on to write an `ignored_album` record for it, and an
// `artist_ignored_album` record for each of its artists. Its artists are its
// tracks' credits, which may be going, so they're read before anything is
// written, and spared from deletion as orphans: the new records refer to them.

import type { DmlOperation } from "api-client";
import type { RecordKey } from "../query/recordForm";
import type { PlanOptions } from "./deletePlan";

/** The table whose records can be ignored as they're deleted. */
export const IGNORABLE_TABLE = "album";

/** The tables ignoring an album reads or writes, besides its own. */
const TABLES = ["ignored_album", "artist_ignored_album", "track", "credit"];

/** Whether deleting records of `table` can ignore them instead: albums, in a
 * library whose migrations made the tables for it. */
export function canIgnore(
  table: string,
  tables: readonly { name: string }[],
): boolean {
  if (table !== IGNORABLE_TABLE) return false;
  const names = new Set(tables.map((t) => t.name));
  return TABLES.every((name) => names.has(name));
}

/** What ignoring some albums needs to know of them. */
export interface IgnoreInfo {
  /** By album id: the artists an `artist_ignored_album` record ties it to. */
  artists: ReadonlyMap<string, readonly string[]>;
  /** The albums among them that are ignored already, which keep the record
   * they have. */
  ignored: ReadonlySet<string>;
}

/** Runs a query, giving every cell as text, `null` for NULL. */
export type SqlLoader = (
  sql: string,
) => Promise<readonly (readonly (string | null)[])[]>;

/** How many albums one query's `IN (…)` lists. */
const CHUNK = 1000;

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** The SQL listing the artists to tie each of `albums` to: `[album, artist]`
 * rows. They're the artists credited on its tracks without a role (featured,
 * remix and the like), or, for an album whose credits all have one, every
 * artist credited on it. */
export function ignoreArtistsSql(albums: readonly string[]): string {
  return (
    `SELECT album, artist FROM (` +
    `SELECT t.album::text AS album, c.artist::text AS artist, ` +
    `bool_or(c.role IS NULL) AS main ` +
    `FROM main.track t JOIN main.credit c ON c.track = t.id ` +
    `WHERE t.album IN (${albums.map(literal).join(", ")}) ` +
    `GROUP BY ALL) ` +
    `QUALIFY main OR NOT bool_or(main) OVER (PARTITION BY album) ` +
    `ORDER BY album, artist`
  );
}

/** The SQL listing which of `albums` are ignored already. */
export function ignoredAlbumsSql(albums: readonly string[]): string {
  return (
    `SELECT album::text FROM main.ignored_album ` +
    `WHERE album IN (${albums.map(literal).join(", ")})`
  );
}

/** The album ids `keys` name. */
export function albumIds(keys: readonly RecordKey[]): string[] {
  return keys.flatMap(
    (key) => key.find((part) => part.column === "id")?.value ?? [],
  );
}

/** Reads what ignoring the albums `keys` name needs, through `load`. */
export async function loadIgnoreInfo(
  keys: readonly RecordKey[],
  load: SqlLoader,
): Promise<IgnoreInfo> {
  const ids = albumIds(keys);
  const artists = new Map<string, string[]>();
  const ignored = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    for (const [album, artist] of await load(ignoreArtistsSql(chunk))) {
      if (album == null || artist == null) continue;
      const list = artists.get(album) ?? [];
      list.push(artist);
      artists.set(album, list);
    }
    for (const [album] of await load(ignoredAlbumsSql(chunk))) {
      if (album != null) ignored.add(album);
    }
  }
  return { artists, ignored };
}

/** The records a deletion that ignores albums mustn't delete as orphans: the
 * artists the new records tie the albums to. */
export function ignoreSpare(info: IgnoreInfo): PlanOptions["spare"] {
  return { artist: new Set([...info.artists.values()].flat()) };
}

/** The DML operations ignoring the albums `kept` names (the plan's kept
 * records), after the deletion's own: an `ignored_album` record for each one
 * that isn't ignored already, with `reason` (none when it's blank) and
 * `timestamp` (UTC, `nowUtcText()`), and its artists tied to it. */
export function ignoreOperations(
  kept: readonly RecordKey[],
  info: IgnoreInfo,
  reason: string,
  timestamp: string,
): DmlOperation[] {
  const why = reason.trim() === "" ? null : reason.trim();
  const operations: DmlOperation[] = [];
  albumIds(kept).forEach((album, i) => {
    if (info.ignored.has(album)) return;
    const id = `ignore${i}`;
    operations.push({
      operation: "insert",
      id,
      table: "ignored_album",
      values: { album, timestamp, reason: why },
    });
    (info.artists.get(album) ?? []).forEach((artist, j) => {
      operations.push({
        operation: "insert",
        id: `${id}.artist${j}`,
        table: "artist_ignored_album",
        values: { artist, ignored_album: { id } },
      });
    });
  });
  return operations;
}
