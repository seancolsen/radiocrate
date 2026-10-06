// The writes behind every change to a playlist's entries (`playlist_track`
// records), and the `position` arithmetic they rest on.
//
// Each operation is sent as one `dml` request, so that all of its writes apply
// in one transaction (see "Writing playlist entries" in
// `specs/2026-10-playlists/specs.md`). The builders here only work out those
// writes, as plain data. Sending them is `api/playlist.ts`'s job, behind one
// function, so how they're sent can change in one place.
//
// `dml` constrains the shape of every write: an update or delete names its row
// by a non-null unique key, so each entry is addressed by its own `id`, one
// operation per row; and a delete fails while anything still references the
// row, so a playlist goes entries first, then its source, then itself. Every id
// is generated client-side, which keeps each builder's output complete without
// operation references, and lets an entry write carry its exact inverse for
// undo.

import type { DmlOperation, DmlRequest, JsonValue } from "api-client";
import type { QueryResult } from "./result";

/** One `playlist_track` record. */
export interface PlaylistEntry {
  id: string;
  track: string;
  position: number;
}

/** A `dml` operation before it's given its id within a request. The ids are
 * assigned only when a request is put together ({@link toDmlRequest}), since
 * they must be unique within it, and a request may combine several builders'
 * writes. */
export type PlaylistWrite = WithoutId<DmlOperation>;

/** `Omit<T, "id">` applied to each member of union `T` separately, so that the
 * union stays discriminated by `operation`. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** A change to a playlist's entries together with the writes that undo it. */
export interface EntryWrites {
  apply: PlaylistWrite[];
  revert: PlaylistWrite[];
}

/** Puts writes together into one `dml` request, giving each operation an id from
 * a counter (`e0`, `e1`, …). Row ids can't serve, because a request that
 * deletes and re-inserts an entry would hold its id twice. */
export function toDmlRequest(writes: readonly PlaylistWrite[]): DmlRequest {
  return {
    operations: writes.map(
      (write, index) => ({ ...write, id: `e${index}` }) as DmlOperation,
    ),
  };
}

// ── Result rows ──────────────────────────────────────────────────────────────

/** The entry a playlist page's result row lists: its `playlist_track` id and
 * position. */
export interface RowEntry {
  id: string;
  position: number;
}

/** Output columns 0 and 1 of every playlist query: the hidden `$id` and
 * `$position` (see `playlistQuerydown`). Result columns keep hidden ones, so
 * these index the result directly. */
const ENTRY_ID_COLUMN = 0;
const ENTRY_POSITION_COLUMN = 1;

/** The entry that row `row` of a playlist page's results lists, or `undefined`
 * when the row carries no entry id (a result that isn't a playlist's). */
export function rowEntry(
  result: QueryResult,
  row: number,
): RowEntry | undefined {
  if (row < 0 || row >= result.rowCount) return undefined;
  const id = result.keyText(row, ENTRY_ID_COLUMN);
  const raw = result.value(row, ENTRY_POSITION_COLUMN);
  const position = raw == null ? NaN : Number(raw);
  if (id === "" || !Number.isFinite(position)) return undefined;
  return { id, position };
}

// ── Positions ────────────────────────────────────────────────────────────────

/** `count` consecutive integers from `start`. */
function consecutive(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

/** The positions `count` tracks get when added to the end of a playlist whose
 * greatest position is `max` (`null` for an empty playlist): consecutive
 * integers from one above `max`'s integer ceiling, or from 1. */
export function appendPositions(max: number | null, count: number): number[] {
  return consecutive(max === null ? 1 : Math.ceil(max) + 1, count);
}

/** Positions 1…`count`: a new playlist's entries, and a renumbered one's. */
export function sequentialPositions(count: number): number[] {
  return consecutive(1, count);
}

/** The positions `count` entries dropped between two rows get, evenly spaced
 * between their positions `above` and `below`. Dropping three entries between
 * 6 and 7 gives 6.25, 6.5 and 6.75.
 *
 * At an edge, the missing neighbor is `undefined`: dropped at the very top, the
 * entries get consecutive integers ending one below the integer floor of
 * `below`; at the very bottom, consecutive integers from one above the integer
 * ceiling of `above`.
 *
 * `undefined` when the entries don't fit: the neighbors are too close together
 * (or out of order) for `count` distinct doubles to sit strictly between them,
 * or there's no neighbor at all. The caller then renumbers the whole playlist
 * instead ({@link renumberMoves}). */
export function dropPositions(
  above: number | undefined,
  below: number | undefined,
  count: number,
): number[] | undefined {
  if (above === undefined) {
    return below === undefined
      ? undefined
      : consecutive(Math.floor(below) - count, count);
  }
  if (below === undefined) return consecutive(Math.ceil(above) + 1, count);
  const step = (below - above) / (count + 1);
  const positions = Array.from(
    { length: count },
    (_, i) => above + step * (i + 1),
  );
  // Rounding can collapse neighbors onto one another, or onto a bound, long
  // before `step` itself reaches zero.
  let previous = above;
  for (const p of positions) {
    if (!(p > previous)) return undefined;
    previous = p;
  }
  return previous < below ? positions : undefined;
}

/** An entry's move from one position to another. */
export interface PositionMove {
  id: string;
  from: number;
  to: number;
}

/** The moves that renumber `entries`, given in their new order, to positions
 * 1…n. What committing a sort writes, and what a drop falls back to when its
 * neighbors are too close. Entries already at their new position are left out,
 * since writing them would change nothing. */
export function renumberMoves(
  entries: readonly Pick<PlaylistEntry, "id" | "position">[],
): PositionMove[] {
  const moves: PositionMove[] = [];
  entries.forEach((entry, index) => {
    if (entry.position !== index + 1) {
      moves.push({ id: entry.id, from: entry.position, to: index + 1 });
    }
  });
  return moves;
}

/** The moves that rearrange `moved` (in the order they're to keep) to sit
 * between the rows `above` and `below`, either of which is `undefined` at an
 * edge. When a filter hides some entries, the neighbors are the adjacent
 * *visible* rows, and the hidden entries keep their positions.
 *
 * The moved entries get positions between the neighbors' when they fit
 * ({@link dropPositions}). Otherwise every entry in `all` (the whole playlist,
 * in its stored order) is renumbered in the new order: `moved` placed just
 * after `above`, or at the top when there's none. */
export function rearrangeMoves(
  all: readonly PlaylistEntry[],
  moved: readonly PlaylistEntry[],
  above: PlaylistEntry | undefined,
  below: PlaylistEntry | undefined,
): PositionMove[] {
  const positions = dropPositions(
    above?.position,
    below?.position,
    moved.length,
  );
  if (positions) {
    return moved.flatMap((entry, i) =>
      entry.position === positions[i]
        ? []
        : [{ id: entry.id, from: entry.position, to: positions[i] }],
    );
  }
  const movedIds = new Set(moved.map((e) => e.id));
  const rest = all.filter((e) => !movedIds.has(e.id));
  const at =
    above === undefined ? 0 : rest.findIndex((e) => e.id === above.id) + 1;
  return renumberMoves([...rest.slice(0, at), ...moved, ...rest.slice(at)]);
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Epoch seconds `epoch` as the text a `source` timestamp column takes through
 * `dml`: `YYYY-MM-DD HH:MM:SS`, which DuckDB casts into `timestamp_s`. Read
 * in UTC, because the backend stores a source's epoch timestamps as UTC civil
 * time (`make_timestamp`), and `source.list` reads them back the same way. */
export function sourceTimestamp(epoch: number): string {
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** Everything a new playlist's `source` and `playlist` records hold. */
export interface NewPlaylist {
  sourceId: string;
  playlistId: string;
  name: string;
  /** Epoch seconds: the new source's `created_at`, `modified_at` and
   * `last_play`. */
  createdAt: number;
  /** The containing folder, or `null` at the top level. */
  folder: string | null;
  position: number;
  /** The stored `playlist.definition` JSON (`playlistDefinitionToStored`). */
  definition: string;
}

/** An entry's insert. */
function insertEntry(playlistId: string, entry: PlaylistEntry): PlaylistWrite {
  const values: Record<string, JsonValue> = {
    id: entry.id,
    playlist: playlistId,
    track: entry.track,
    position: entry.position,
  };
  return { operation: "insert", table: "playlist_track", values };
}

/** An entry's delete. */
function deleteEntry(id: string): PlaylistWrite {
  return { operation: "delete", table: "playlist_track", where: { id } };
}

/** An entry's move to another position. */
function updatePosition(id: string, position: number): PlaylistWrite {
  return {
    operation: "update",
    table: "playlist_track",
    where: { id },
    values: { position },
  };
}

/** The writes that create a playlist, with an entry for each of `entries` (a
 * track and its position), in one request: the `playlist` record, then the
 * `source` that wraps it, then the entries, each with an id from `newId`.
 * Creating an empty playlist, converting a query (positions 1…n, from
 * {@link sequentialPositions}) and duplicating a playlist (its entries'
 * positions, as they are) all come down to this. */
export function createPlaylistWrites(
  playlist: NewPlaylist,
  entries: readonly Omit<PlaylistEntry, "id">[],
  newId: () => string,
): PlaylistWrite[] {
  const at = sourceTimestamp(playlist.createdAt);
  return [
    {
      operation: "insert",
      table: "playlist",
      values: { id: playlist.playlistId, definition: playlist.definition },
    },
    {
      operation: "insert",
      table: "source",
      values: {
        id: playlist.sourceId,
        name: playlist.name,
        created_at: at,
        modified_at: at,
        last_play: at,
        source_folder: playlist.folder,
        position: playlist.position,
        playlist: playlist.playlistId,
      },
    },
    ...entries.map((entry) =>
      insertEntry(playlist.playlistId, { ...entry, id: newId() }),
    ),
  ];
}

/** The writes that delete a playlist: every one of its entries (`entryIds`,
 * which the caller reads first), then its source, then the playlist itself, in
 * the order `dml`'s reference checks require. */
export function deletePlaylistWrites(
  playlist: { sourceId: string; playlistId: string },
  entryIds: readonly string[],
): PlaylistWrite[] {
  return [
    ...entryIds.map(deleteEntry),
    { operation: "delete", table: "source", where: { id: playlist.sourceId } },
    {
      operation: "delete",
      table: "playlist",
      where: { id: playlist.playlistId },
    },
  ];
}

/** Adding `trackIds` to the end of a playlist whose greatest position is `max`
 * (`null` when it's empty), in the order given, each entry with an id from
 * `newId`. Undone by deleting those entries. */
export function addEntriesWrites(
  playlistId: string,
  trackIds: readonly string[],
  max: number | null,
  newId: () => string,
): EntryWrites {
  const positions = appendPositions(max, trackIds.length);
  const entries = trackIds.map((track, i) => ({
    id: newId(),
    track,
    position: positions[i],
  }));
  return {
    apply: entries.map((e) => insertEntry(playlistId, e)),
    revert: entries.map((e) => deleteEntry(e.id)),
  };
}

/** Removing `entries` from a playlist. Undone by re-inserting the same records,
 * with their original ids and positions — which is why this takes the entries
 * whole rather than their ids. */
export function removeEntriesWrites(
  playlistId: string,
  entries: readonly PlaylistEntry[],
): EntryWrites {
  return {
    apply: entries.map((e) => deleteEntry(e.id)),
    revert: entries.map((e) => insertEntry(playlistId, e)),
  };
}

/** Moving entries to new positions. Undone by moving them back. */
export function setPositionsWrites(
  moves: readonly PositionMove[],
): EntryWrites {
  return {
    apply: moves.map((m) => updatePosition(m.id, m.to)),
    revert: moves.map((m) => updatePosition(m.id, m.from)),
  };
}
