import { useEffect, useMemo, useState, type JSX } from "react";
import { Icons } from "../icons";
import { ratingLabel } from "../query/ratings";
import {
  fetchCreditedArtists,
  fetchTrackAlbumIds,
  type CreditedArtist,
} from "../query/relatedRecords";
import {
  selectRatings,
  selectRatingsLoading,
  trackIdsOfRows,
  type RecordGroup,
  type RecordRef,
} from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import {
  MenuItem,
  MenuLoader,
  MenuNote,
  MenuSeparator,
  MenuSubmenu,
} from "./ui/Menu";

/** A result row's context-menu body, over the records its rows identify (one
 * group per table — a track row joined to its album offers both):
 *
 * - what can be done *to* those records ({@link RecordActions}): one "Edit
 *   {table}" entry per table, then "Show album tracks" for albums, "Show
 *   artist tracks" and "Show artist albums" for artists, and "Rate track" for
 *   tracks;
 * - the queue's entries when the rows are tracks ({@link QueueActions}),
 *   "Add to playlist…" too, and "Remove from playlist" on a playlist's page;
 * - the records they lead to ({@link RecordNavigation}): the artists credited
 *   on tracks or albums, and a track's album — each a submenu offering the
 *   same entries for *its* records, so the user can walk from record to
 *   record;
 * - the "Select multiple" entry that turns multi-select mode on.
 *
 * The same body backs the multi-select toolbar's actions menu, which acts on
 * the whole selection; it passes no `onSelectMultiple`, because that mode is
 * already on. A row identifying nothing then leaves the menu with only "Select
 * multiple" to offer, which is still worth raising — that's how a touch device
 * reaches multi-select on results whose rows aren't editable. */
export default function RowActionsMenu(props: {
  tabId: string;
  /** The rows' records, by table (see `recordGroupsForRows`). */
  groups: readonly RecordGroup[];
  /** The rows themselves, when they're tracks: what the queue's entries act
   * on. Omitted otherwise, which hides those entries. */
  trackRows?: Iterable<number>;
  /** Opens the "Add to playlist…" dialog for the rows' tracks. Omitted when
   * the rows aren't tracks (no `trackIdColumn`), which hides the entry. */
  onAddToPlaylist?: () => void;
  /** Removes the rows' entries from the playlist whose page they're on.
   * Omitted anywhere else, which hides the entry. */
  onRemoveFromPlaylist?: () => void;
  /** Omitted when multi-select mode is already on, which hides the entry. */
  onSelectMultiple?: () => void;
}): JSX.Element {
  const navigation = navigationFor(props.groups);
  return (
    <>
      <RecordActions tabId={props.tabId} groups={props.groups} />
      {props.trackRows && (
        <QueueActions tabId={props.tabId} rows={props.trackRows} />
      )}
      {props.onAddToPlaylist && (
        <MenuItem
          icon={Icons.Playlist}
          label="Add to playlist…"
          onClick={props.onAddToPlaylist}
        />
      )}
      {props.onRemoveFromPlaylist && (
        <MenuItem
          icon={Icons.Delete}
          label="Remove from playlist"
          onClick={props.onRemoveFromPlaylist}
        />
      )}
      {navigation.length > 0 && (
        <>
          <MenuSeparator />
          <RecordNavigation tabId={props.tabId} navigation={navigation} />
        </>
      )}
      {props.onSelectMultiple && (
        <>
          {(props.groups.length > 0 ||
            props.onAddToPlaylist ||
            props.onRemoveFromPlaylist) && <MenuSeparator />}
          <MenuItem
            icon={Icons.SelectMultiple}
            label="Select multiple"
            onClick={props.onSelectMultiple}
          />
        </>
      )}
    </>
  );
}

/** Everything {@link RowActionsMenu} offers for `groups` other than what's
 * tied to the rows themselves — the body of a submenu leading to records the
 * rows don't carry (an artist credited on a track, the track's album). */
function RecordMenu(props: {
  tabId: string;
  groups: readonly RecordGroup[];
}): JSX.Element {
  const navigation = navigationFor(props.groups);
  return (
    <>
      <RecordActions tabId={props.tabId} groups={props.groups} />
      {navigation.length > 0 && (
        <>
          <MenuSeparator />
          <RecordNavigation tabId={props.tabId} navigation={navigation} />
        </>
      )}
    </>
  );
}

/** The entries acting on `groups`' records: editing them, opening related
 * records in a new tab, and rating tracks. */
function RecordActions(props: {
  tabId: string;
  groups: readonly RecordGroup[];
}): JSX.Element {
  const {
    rateTracks,
    setRecordEditorRecords,
    showArtistRecords,
    showChildRecords,
  } = useAppActions();
  const { tabId, groups } = props;
  const albums = groups.find((group) => group.table === "album")?.records;
  const artists = groups.find((group) => group.table === "artist")?.records;
  const tracks = groups.find((group) => group.table === "track")?.records;
  return (
    <>
      {groups.map((group) => (
        <MenuItem
          key={group.table}
          icon={Icons.Edit}
          label={`Edit ${group.table}`}
          onClick={() =>
            setRecordEditorRecords(tabId, group.table, group.records)
          }
        />
      ))}
      {albums && (
        <MenuItem
          icon={Icons.Query}
          label="Show album tracks"
          onClick={() => showChildRecords(tabId, "album", albums, "track")}
        />
      )}
      {artists && (
        <>
          <MenuItem
            icon={Icons.Query}
            label="Show artist tracks"
            onClick={() => showArtistRecords(tabId, artists, "track")}
          />
          <MenuItem
            icon={Icons.Query}
            label="Show artist albums"
            onClick={() => showArtistRecords(tabId, artists, "album")}
          />
        </>
      )}
      {tracks && <RateSubmenu onRate={(id) => rateTracks(tabId, tracks, id)} />}
    </>
  );
}

/** "1 track" or "3 tracks". */
function tracksLabel(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "track" : "tracks"}`;
}

/** The queue's entries for the tracks of `rows`. With nothing else queued,
 * "Queue track"; otherwise a choice of "Queue track next", ahead of what's
 * queued, and "Queue after 5 queued tracks", behind it. And "Remove from
 * queue", when any of them is queued. */
function QueueActions(props: {
  tabId: string;
  rows: Iterable<number>;
}): JSX.Element | null {
  const { queueRows, unqueueRows } = useAppActions();
  const { tabId, rows } = props;
  const result = useApp((s) => s.pages[tabId]?.result);
  const lineage = useApp((s) => s.pages[tabId]?.lineage);
  const queue = useApp((s) => s.queuedTracks);
  const trackIds = useMemo(
    () => trackIdsOfRows(result, lineage, rows),
    [result, lineage, rows],
  );
  const queued = useMemo(() => {
    const ids = new Set(queue.map((track) => track.id));
    return trackIds.filter((id) => ids.has(id)).length;
  }, [queue, trackIds]);
  const count = trackIds.length;
  if (count === 0) return null;
  // What's queued besides these tracks, which is what they'd go before or
  // after.
  const others = queue.length - queued;
  const tracks = count === 1 ? "track" : tracksLabel(count);
  return (
    <>
      {others === 0 && queued < count && (
        <MenuItem
          icon={Icons.QueueLast}
          label={`Queue ${tracks}`}
          command="queue.add_selected"
          onClick={() => queueRows(tabId, rows, "last")}
        />
      )}
      {others > 0 && (
        <>
          <MenuItem
            icon={Icons.QueueNext}
            label={`Queue ${tracks} next`}
            command="queue.add_selected_next"
            onClick={() => queueRows(tabId, rows, "next")}
          />
          <MenuItem
            icon={Icons.QueueLast}
            label={`Queue ${count === 1 ? "" : `${tracks} `}after ${others} queued ${others === 1 ? "track" : "tracks"}`}
            command="queue.add_selected"
            onClick={() => queueRows(tabId, rows, "last")}
          />
        </>
      )}
      {queued > 0 && (
        <MenuItem
          icon={Icons.Unqueue}
          label={
            count === 1
              ? "Remove from queue"
              : `Remove ${tracksLabel(queued)} from queue`
          }
          command="queue.remove_selected"
          onClick={() => unqueueRows(tabId, rows)}
        />
      )}
    </>
  );
}

/** "Rate track": the rating vocabulary, lowest value first — which loads the
 * first time a menu offering it is raised (see `loadRatings`), so it can still
 * be on its way. */
function RateSubmenu(props: {
  onRate: (ratingId: string) => void;
}): JSX.Element {
  const ratings = useApp(selectRatings);
  const loading = useApp(selectRatingsLoading);
  return (
    <MenuSubmenu icon={Icons.Rate} label="Rate track">
      {ratings.map((rating) => (
        <MenuItem
          key={rating.id}
          label={ratingLabel(rating)}
          onClick={() => props.onRate(rating.id)}
        />
      ))}
      {ratings.length === 0 && (
        <MenuNote text={loading ? "Loading…" : "No ratings"} />
      )}
    </MenuSubmenu>
  );
}

/** A submenu leading from some records to others: the artists credited on
 * `from` (tracks or albums), or the album of `from` (tracks). */
interface Navigation {
  kind: "artists" | "album";
  from: RecordGroup;
}

/** The submenus leading on from `groups`. A row carrying both a track and its
 * album already offers the album's own entries, so it isn't offered again as
 * the track's "Album"; and it lists the track's artists, as the narrower of
 * the two "Artists". */
function navigationFor(groups: readonly RecordGroup[]): Navigation[] {
  const tracks = groups.find((group) => group.table === "track");
  const albums = groups.find((group) => group.table === "album");
  const navigation: Navigation[] = [];
  const credited = tracks ?? albums;
  if (credited) navigation.push({ kind: "artists", from: credited });
  if (tracks && !albums) navigation.push({ kind: "album", from: tracks });
  return navigation;
}

function RecordNavigation(props: {
  tabId: string;
  navigation: readonly Navigation[];
}): JSX.Element {
  return (
    <>
      {props.navigation.map((nav) =>
        nav.kind === "artists" ? (
          <MenuSubmenu key={nav.kind} icon={Icons.Artists} label="Artists">
            <CreditedArtists tabId={props.tabId} from={nav.from} />
          </MenuSubmenu>
        ) : (
          <MenuSubmenu key={nav.kind} icon={Icons.Album} label="Album">
            <TrackAlbum tabId={props.tabId} tracks={nav.from.records} />
          </MenuSubmenu>
        ),
      )}
    </>
  );
}

/** A lookup's progress. */
type Loaded<T> =
  { status: "loading" } | { status: "ready"; value: T } | { status: "error" };

/** The `id`s of `records`, as the lookups take them. */
function idsOf(records: readonly RecordRef[]): string[] {
  return records.flatMap((record) => {
    const id = record.key.find((k) => k.column === "id")?.value;
    return id ? [id] : [];
  });
}

/** Runs `load` on `records`' ids as the calling submenu opens (it's mounted
 * then), and again should they change. `load` has to be stable — a
 * module-level function. */
function useLookup<T>(
  load: (ids: readonly string[], schemaJson: string) => Promise<T>,
  records: readonly RecordRef[],
): Loaded<T> {
  const schemaJson = useApp((s) => s.schema.json);
  const [loaded, setLoaded] = useState<Loaded<T>>({ status: "loading" });
  useEffect(() => {
    if (schemaJson === undefined) return;
    let live = true;
    load(idsOf(records), schemaJson).then(
      (value) => {
        if (live) setLoaded({ status: "ready", value });
      },
      (err: unknown) => {
        console.error("row menu lookup failed", err);
        if (live) setLoaded({ status: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [load, records, schemaJson]);
  return loaded;
}

const loadTrackArtists = (ids: readonly string[], schemaJson: string) =>
  fetchCreditedArtists("track", ids, schemaJson);
const loadAlbumArtists = (ids: readonly string[], schemaJson: string) =>
  fetchCreditedArtists("album", ids, schemaJson);

/** The "Artists" submenu's rows: every artist credited on `from`'s records,
 * best-credited first, each a submenu of its own entries. */
function CreditedArtists(props: {
  tabId: string;
  from: RecordGroup;
}): JSX.Element {
  const loaded = useLookup(
    props.from.table === "track" ? loadTrackArtists : loadAlbumArtists,
    props.from.records,
  );
  return (
    <MenuLoader loading={loaded.status === "loading"}>
      {loaded.status === "error" ? (
        <MenuNote text="Couldn't load artists" />
      ) : loaded.status === "ready" && loaded.value.length === 0 ? (
        <MenuNote text="No artists" />
      ) : (
        loaded.status === "ready" &&
        loaded.value.map((artist) => (
          <ArtistSubmenu key={artist.id} tabId={props.tabId} artist={artist} />
        ))
      )}
    </MenuLoader>
  );
}

/** One credited artist, named, opening onto the entries for that artist. */
function ArtistSubmenu(props: {
  tabId: string;
  artist: CreditedArtist;
}): JSX.Element {
  const groups: RecordGroup[] = [
    { table: "artist", records: [idRecord("artist", props.artist.id)] },
  ];
  return (
    <MenuSubmenu icon={Icons.Artist} label={props.artist.name}>
      <RecordMenu tabId={props.tabId} groups={groups} />
    </MenuSubmenu>
  );
}

const loadTrackAlbums = async (ids: readonly string[], schemaJson: string) =>
  (await fetchTrackAlbumIds(ids, schemaJson)).map((id) =>
    idRecord("album", id),
  );

/** The "Album" submenu's rows: the entries for the album the `tracks` are on —
 * or for every album they're on, as the menu's entries for several rows act
 * on all of them. */
function TrackAlbum(props: {
  tabId: string;
  tracks: readonly RecordRef[];
}): JSX.Element {
  const loaded = useLookup(loadTrackAlbums, props.tracks);
  return (
    <MenuLoader loading={loaded.status === "loading"}>
      {loaded.status === "error" ? (
        <MenuNote text="Couldn't load album" />
      ) : loaded.status === "ready" && loaded.value.length === 0 ? (
        <MenuNote text="No album" />
      ) : (
        loaded.status === "ready" && (
          <RecordMenu
            tabId={props.tabId}
            groups={[{ table: "album", records: loaded.value }]}
          />
        )
      )}
    </MenuLoader>
  );
}

/** The record of `table` whose `id` is `id`. */
function idRecord(table: string, id: string): RecordRef {
  return { table, key: [{ column: "id", value: id }] };
}
