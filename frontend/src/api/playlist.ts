// Reads of a playlist's entries that the page hasn't loaded, and the one place
// a playlist's writes are sent from.
//
// Deleting and duplicating a playlist, adding tracks to one, and "Keep only
// these tracks" all need entries that no results page holds (the page may be
// filtered, or not open at all). They read them here as raw SQL: no Querydown
// is needed to list one table's rows.

import { dml, type DmlResult } from "api-client";
import {
  toDmlRequest,
  type PlaylistEntry,
  type PlaylistWrite,
} from "../query/playlistEntries";
import { runSql } from "./query";

/** Escapes a value for embedding in a single-quoted SQL literal. */
function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** The `where` clause selecting playlist `playlistId`'s entries. */
function entriesOf(playlistId: string): string {
  return `where playlist = TRY_CAST('${sqlLiteral(playlistId)}' AS UUID)`;
}

/** Every entry of playlist `playlistId`, in its stored order: by position, then
 * by track id as the playlist query breaks ties, then by entry id so that even
 * a duplicated track's entries come back in a stable order. */
export async function fetchPlaylistEntries(
  playlistId: string,
): Promise<PlaylistEntry[]> {
  const table = await runSql(
    `select id::text as id, track::text as track, position ` +
      `from playlist_track ${entriesOf(playlistId)} ` +
      `order by position, track, id;`,
  );
  const ids = table.getChild("id");
  const tracks = table.getChild("track");
  const positions = table.getChild("position");
  const entries: PlaylistEntry[] = [];
  for (let row = 0; row < table.numRows; row++) {
    entries.push({
      id: String(ids?.get(row)),
      track: String(tracks?.get(row)),
      position: Number(positions?.get(row)),
    });
  }
  return entries;
}

/** The greatest position among playlist `playlistId`'s entries, or `null` when
 * it has none — where tracks added to its end start from
 * (`appendPositions`). */
export async function fetchMaxPosition(
  playlistId: string,
): Promise<number | null> {
  const table = await runSql(
    `select max(position) as max from playlist_track ${entriesOf(playlistId)};`,
  );
  const max: unknown = table.getChild("max")?.get(0);
  return max == null ? null : Number(max);
}

/** Sends `writes` as one `dml` request, so that they apply in one transaction
 * or not at all. Every write to a playlist's records goes through here, so that
 * how they're sent (one request, for now, whatever its size) can change in one
 * place. */
export function sendPlaylistWrites(
  writes: readonly PlaylistWrite[],
): Promise<DmlResult> {
  return dml(toDmlRequest(writes));
}
