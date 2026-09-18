// Track-level API calls behind the now-playing bar: the metadata a playing
// track shows, and the play log it writes.

import type { DmlOperation } from "api-client";
import { isListLikeValue, runSql, stringifyArrowValue } from "./query";

/** What the now-playing bar shows for a track. */
export interface TrackMetadata {
  title: string | null;
  /** Credited artists in credit order (joined with ", " for display). */
  artists: string[];
  /** The file's length in seconds, as the scanner measured it. A transcoded
   * stream carries no length of its own, so this is the only one it has. */
  duration: number | null;
}

/** Escapes a value for embedding in a single-quoted SQL literal. */
function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Fetches a track's title and credited artists. Returns `undefined` when the id
 * matches no row (or the query fails) — the bar just shows nothing rather than
 * an error. */
export async function fetchTrackMetadata(
  trackId: string,
): Promise<TrackMetadata | undefined> {
  const sql =
    `with a as (` +
    `select c.track, array_agg(ar.name order by c."order") as artists ` +
    `from credit c join artist ar on ar.id = c.artist ` +
    `group by c.track` +
    `) ` +
    // `epoch` turns the INTERVAL into seconds as a DOUBLE, which Arrow JS
    // decodes natively (it can't decode DuckDB's intervals).
    `select t.id::text as id, t.title, a.artists, ` +
    `epoch(f.duration) as duration ` +
    `from track t left join file f on f.id = t.file ` +
    `left join a on a.track = t.id ` +
    `where t.id = TRY_CAST('${sqlLiteral(trackId)}' as UUID);`;

  try {
    const table = await runSql(sql);
    const row = table.get(0);
    if (!row) return undefined;
    const title = row["title"];
    const artists = row["artists"];
    const duration: unknown = row["duration"];
    return {
      duration:
        typeof duration === "number" && Number.isFinite(duration)
          ? duration
          : null,
      title: title == null ? null : stringifyArrowValue(title),
      artists: isListLikeValue(artists)
        ? Array.from(artists as Iterable<unknown>)
            .filter((a) => a != null)
            .map((a) => stringifyArrowValue(a))
        : [],
    };
  } catch (err) {
    console.error("track metadata fetch failed", err);
    return undefined;
  }
}

/** Current local wall-clock as `YYYY-MM-DD HH:MM:SS` — the literal form DuckDB
 * casts into the `play.timestamp` (`timestamp_s`) column. `timestamp_s` is
 * timezone-naive, so this must be the listener's local time, not UTC — a UTC
 * stamp would silently drift by the local offset. */
function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** The DML operation logging a completed play of `trackId`, timestamped now.
 *
 * Building the operation rather than sending it is what lets the store run it
 * against the result row the track is playing from (see `query/rowDml.ts`), so
 * the row's play count moves with the log. */
export function playInsert(trackId: string): DmlOperation {
  return {
    id: "play",
    operation: "insert",
    table: "play",
    values: { track: trackId, timestamp: nowTimestamp() },
  };
}

/** The DML operations giving every track in `keys` the rating `ratingId` — the
 * results row menu's "Rate track", which acts on the whole row selection.
 *
 * Built rather than sent, for the same reason {@link playInsert} is: the store
 * runs them against the result rows those tracks sit on, so the rows show the
 * new rating (and anything the query derives from it) as soon as the write
 * lands. One operation per track, each with an id of its own — `DmlResult` is
 * keyed by operation id, so two operations sharing one would collide.
 */
export function ratingUpdates(
  keys: readonly (readonly { column: string; value: string }[])[],
  ratingId: string,
): DmlOperation[] {
  return keys.map((key, index) => ({
    id: `rating${index + 1}`,
    operation: "update",
    table: "track",
    where: Object.fromEntries(key.map((part) => [part.column, part.value])),
    values: { rating: ratingId },
  }));
}
