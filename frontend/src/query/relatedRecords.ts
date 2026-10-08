// The records the results row menu leads to from the records a row carries:
// the artists credited on a track or an album, a track's album, and an artist's
// tracks and albums. The menu offers each of those as a menu of its own, so the
// user can walk from one record to the next without writing a query.
//
// The lookups are Querydown queries run through the record editor's runner
// (`recordData.ts`), as the rating vocabulary is (`ratings.ts`) — which also
// carries the seam that lets the harness answer them without a backend. The
// "show …" entries are filters instead, for a query tab of their own.
//
// Everything here works on `id`s: what links a track to its credits and its
// album, and a credit to its artist, is the `id` of the record pointed at.

import { runRecordQuery, type RecordRows } from "./recordData";
import { linkConditions, type RecordQuery } from "./recordForm";

/** An artist the menu lists, by the name it shows. */
export interface CreditedArtist {
  id: string;
  name: string;
}

/** The tables whose records have credited artists to list. */
export type CreditedTable = "track" | "album";

/** The credits of the records `ids` of `table` name — a track's own, or those
 * of every track on an album — as `artist.id`, `artist.name`, `order` rows,
 * which is how {@link creditedArtists} reads them back. Sorted by credit order,
 * then name, so that the first credit of each artist is the one that ranks
 * it. */
export function creditsQuery(
  table: CreditedTable,
  ids: readonly string[],
): RecordQuery {
  return {
    base: "credit",
    filter: linkConditions(table === "track" ? "track" : "track.album", ids),
    // Two literal backslashes per term: Querydown's ascending sort.
    sort: "\\\\order \\\\artist.name",
    display: "$artist.id $artist.name $order",
  };
}

/** The distinct artists among {@link creditsQuery}'s rows, best-credited first:
 * by how many of the credits they hold (an album's most frequent artist leads),
 * then by the lowest total of those credits' `order`, then by name.
 *
 * On one track, an artist holds one credit, so that's the track's credit
 * order, then name. A credit with no `order` sorts after every one with an
 * order, as Querydown's `NULLS LAST` puts it — so an artist holding one counts
 * as having the highest total there is. */
export function creditedArtists(rows: RecordRows): CreditedArtist[] {
  const byId = new Map<
    string,
    { artist: CreditedArtist; credits: number; total: number }
  >();
  for (const [id, name, order] of rows) {
    if (id == null || id === "") continue;
    const value = order == null || order === "" ? NaN : Number(order);
    const position = Number.isFinite(value) ? value : Infinity;
    const seen = byId.get(id);
    if (seen) {
      seen.credits += 1;
      seen.total += position;
    } else {
      byId.set(id, {
        artist: { id, name: name ?? "" },
        credits: 1,
        total: position,
      });
    }
  }
  return [...byId.values()]
    .sort(
      (a, b) =>
        b.credits - a.credits ||
        // Two infinite totals are a tie, which `-` would make NaN.
        (a.total === b.total ? 0 : a.total < b.total ? -1 : 1) ||
        a.artist.name.localeCompare(b.artist.name),
    )
    .map((entry) => entry.artist);
}

/** Loads the artists credited on the records `ids` of `table`. Throws whatever
 * the runner throws. */
export async function fetchCreditedArtists(
  table: CreditedTable,
  ids: readonly string[],
  schemaJson: string,
): Promise<CreditedArtist[]> {
  // No condition at all would be every credit there is.
  if (ids.length === 0) return [];
  return creditedArtists(
    await runRecordQuery(creditsQuery(table, ids), schemaJson),
  );
}

/** The album of each of the tracks `ids` — one `album` cell per track, NULL for
 * a track on none. */
export function trackAlbumsQuery(ids: readonly string[]): RecordQuery {
  return {
    base: "track",
    filter: linkConditions("id", ids),
    sort: "",
    display: "$album",
  };
}

/** The distinct albums among {@link trackAlbumsQuery}'s rows, in row order —
 * none, when no track is on one. */
export function trackAlbumIds(rows: RecordRows): string[] {
  const ids = new Set<string>();
  for (const [album] of rows) if (album != null && album !== "") ids.add(album);
  return [...ids];
}

/** Loads the albums the tracks `ids` are on. Throws whatever the runner
 * throws. */
export async function fetchTrackAlbumIds(
  ids: readonly string[],
  schemaJson: string,
): Promise<string[]> {
  if (ids.length === 0) return [];
  return trackAlbumIds(await runRecordQuery(trackAlbumsQuery(ids), schemaJson));
}

/** A `track` filter finding every track credited to one of the artists `ids`:
 *
 * ```
 * ++#credit{artist.id:="…"}
 * ```
 */
export function artistTracksFilter(ids: readonly string[]): string {
  return `++#credit{${linkConditions("artist.id", ids)}}`;
}

/** An `album` filter finding every album holding a track credited to one of
 * the artists `ids`:
 *
 * ```
 * ++#track{++#credit{artist.id:="…"}}
 * ```
 */
export function artistAlbumsFilter(ids: readonly string[]): string {
  return `++#track{${artistTracksFilter(ids)}}`;
}
