// The ways from some records to the records they lead to, each opening those
// records in a query tab of its own: an album's tracks, an artist's tracks or
// albums.
//
// They're offered wherever records are — a result row's context menu, the
// context menu of an embedded record in the record editor — and opening a row
// (double click, Enter) takes one of them. All of those read this one list, so
// a way added here is offered everywhere at once, under the same name, and
// does the same thing wherever it's chosen (`AppActions.navigateRecords`).
//
// Pure: a table name in, the ways out of it out.

/** One way from a table's records to others. */
export type RecordNavigationId =
  "album_tracks" | "artist_tracks" | "artist_albums";

export interface RecordNavigation {
  id: RecordNavigationId;
  /** The table whose records it starts from. */
  table: string;
  /** What a menu calls it. */
  label: string;
}

/** Every way, in the order a menu lists them. */
export const RECORD_NAVIGATIONS: readonly RecordNavigation[] = [
  { id: "album_tracks", table: "album", label: "Show album tracks" },
  { id: "artist_tracks", table: "artist", label: "Show artist tracks" },
  { id: "artist_albums", table: "artist", label: "Show artist albums" },
];

/** The ways out of records of `table`, in menu order — none for most tables. */
export function navigationsFor(table: string): RecordNavigation[] {
  return RECORD_NAVIGATIONS.filter((nav) => nav.table === table);
}

/** What opening a record of `table` does, when it's one of these ways: an
 * album opens onto its tracks, and an artist onto their albums. `undefined` for
 * any other table — a track row plays its track instead. */
export function openNavigationFor(
  table: string | undefined,
): RecordNavigationId | undefined {
  switch (table) {
    case "album":
      return "album_tracks";
    case "artist":
      return "artist_albums";
    default:
      return undefined;
  }
}
