import { useEffect, useState, type JSX } from "react";
import { Icons } from "../../icons";
import { castDraft } from "immer";
import {
  selectTab,
  type CurrentTrack,
  type PlaybackState,
  type Rating,
  type RecordRef,
} from "../../stores/app";
import type { Stores } from "../../stores/createStores";
import {
  defaultFieldMetadata,
  fieldRefKey,
  type FieldMetadata,
} from "../../query/fieldMetadata";
import type { FieldRef } from "api-client";
import { SETTINGS } from "../../state/settings";
import {
  FILTER_DEF,
  FULL_DEF,
  PLAYLIST_SOURCE,
  SOURCES_FIXTURE,
  SHUFFLE_DEF,
  VETTED_PRESET_ID,
} from "../fixtures";
import { failDml, STUB_VERSION } from "./mockApi";
import { useApp } from "../../stores/react";
import { emptyCountResult, lemonadeGridResult } from "../gridFixture";
import {
  FIXTURE_SCHEMA_JSON,
  fixtureQuery,
  installRecordFixture,
} from "../recordFixture";
import {
  defsEqual,
  emptyDefinition,
  type QueryDefinition,
} from "../../query/definition";
import type { ContextualQuery } from "../../query/contextualQuery";
import type { AnnotationValue } from "querydown-js";
import { columnMetadataFromAnnotation } from "../../query/columns";
import type { QueryDiagnostic } from "../../query/diagnostics";
import {
  checkpoint,
  EMPTY_HISTORY,
  stepBack,
  type UndoHistory,
} from "../../state/undoHistory";

import { AboutDialog } from "../../components/AboutModal";
import CommandPalette from "../../components/CommandPalette";
import AddToPlaylistModal from "../../components/AddToPlaylistModal";
import DeleteConfirmModal from "../../components/DeleteConfirmModal";
import PresetDeleteModal from "../../components/PresetDeleteModal";
import PresetManager from "../../components/PresetManager";
import PreludePage from "../../components/PreludePage";
import {
  ExportDataDialog,
  type ExportColumnOption,
} from "../../components/ExportDataModal";
import Explorer from "../../components/Explorer";
import NewQueryPrompt from "../../components/NewQueryPrompt";
import NowPlaying from "../../components/NowPlaying";
import PageActionsMenu from "../../components/PageActionsMenu";
import PlaybackActionsMenu from "../../components/PlaybackActionsMenu";
import QueryBuilder from "../../components/builder/QueryBuilder";
import QueryResults from "../../components/QueryResults";
import QueryToolbar from "../../components/QueryToolbar";
import TabBar from "../../components/TabBar";
import RecordEditorPanel from "../../components/RecordEditorPanel";
import RecordPicker from "../../components/RecordPicker";
import RowActionsMenu from "../../components/RowActionsMenu";
import SectionOptionsMenu from "../../components/builder/SectionOptionsMenu";
import EmbeddedRecord from "../../components/record/EmbeddedRecord";
import { ValueInput } from "../../components/record/FieldValue";
import { CaptureDialog } from "../../components/ShortcutsPage";
import { RpcErrorBar } from "../../components/RpcErrorBanner";
import { UpdateBar } from "../../components/UpdateBanner";
import { ContextMenu } from "../../components/ui/ContextMenu";
import {
  Menu,
  MenuItem,
  MenuLoader,
  MenuSeparator,
  MenuSubmenu,
  MenuToggleItem,
} from "../../components/ui/Menu";
import SettingsMenu from "../../components/SettingsMenu";
import ScrollArea from "../../components/ui/ScrollArea";
import SidebarLeft from "../../components/ui/SidebarLeft";
import NoTabsPage from "../../components/NoTabsPage";

// The visual-test harness's catalogue: one entry per snapshot, each putting a
// single component on screen with the state or props that snapshot is about —
// and nothing else. `tests/visual/*.spec.ts` navigate to
// `/harness.html?story=<id>` and shoot the stage (or, for a component that
// portals out of it, the dialog or menu it raised).
//
// Story ids are the baseline paths, so renaming one moves its baselines. A
// story's `setup(stores)` receives the whole store bundle.
//
// A story is meant to read as the shortest description of what the snapshot
// shows. When one can't — when reaching a state takes a chain of interactions
// against a stand-in backend — that's the sign the scenario belongs in an
// end-to-end test against a real one instead.

/** One catalogue entry. */
export interface Story {
  /** Stage width in CSS px. Omit to fill the viewport (which is then the
   * test's to size — what a component whose own layout responds to the
   * viewport, like `SidebarLeft`, needs). */
  width?: number;
  /** Stage height in CSS px. Omit to let the stage hug its contents. */
  height?: number;
  /** Extra classes for the stage — its flex direction, mostly. */
  frame?: string;
  /** Puts the stores into the state the story is about, once the canned
   * query and preset lists have loaded. */
  setup?: (stores: Stores) => void;
  render: () => JSX.Element;
}

const [LEMONADE, DEEP_CUTS] = SOURCES_FIXTURE;

/** Folder ids for the explorer-tree stories. */
const FAVORITES = "00000000-0000-0000-0000-0000000000f1";
const ROAD_TRIP = "00000000-0000-0000-0000-0000000000f2";
const ARCHIVE = "00000000-0000-0000-0000-0000000000f3";
const QUERIES = "00000000-0000-0000-0000-0000000000f4";
const PARTIES = "00000000-0000-0000-0000-0000000000f5";

/** Arranges the fixture sources into folders: "Favorites" (open) holds
 * Lemonade and a "Road trip" folder (closed) holding Workout Mix; Deep Cuts and
 * an empty "Archive" folder sit beside it at the top level. */
function arrangeSourceTree(stores: Stores): void {
  const [lemonade, deepCuts, workoutMix] = SOURCES_FIXTURE;
  stores.app.store.setState((s) => {
    s.folders.data = [
      { id: FAVORITES, name: "Favorites", parent: null, position: 0 },
      { id: ROAD_TRIP, name: "Road trip", parent: FAVORITES, position: 1 },
      { id: ARCHIVE, name: "Archive", parent: null, position: 2 },
    ];
    s.sources.data = [
      { ...lemonade, parent: FAVORITES, position: 0 },
      { ...deepCuts, parent: null, position: 1 },
      { ...workoutMix, parent: ROAD_TRIP, position: 0 },
    ];
  });
  stores.app.actions.toggleFolderExpanded(FAVORITES);
}

/** Opens the "Lemonade" fixture query in a tab and returns its id. */
function openLemonade(stores: Stores): string {
  stores.app.actions.openTab({
    id: LEMONADE.id,
    name: LEMONADE.name,
    definition: "",
  });
  return LEMONADE.id;
}

/** Opens the "Road Trip" fixture playlist in a tab and returns its id. */
function openRoadTrip(stores: Stores): string {
  stores.app.actions.openTab(PLAYLIST_SOURCE);
  return PLAYLIST_SOURCE.id;
}

/** Opens "Road Trip" on `sections` (a stored playlist definition's) with
 * twelve rows on screen, and opens its builder's `section`. */
function openRoadTripOn(
  stores: Stores,
  sections: object,
  section: "filter" | "sort",
): void {
  stores.app.actions.openTab({
    ...PLAYLIST_SOURCE,
    definition: JSON.stringify(sections),
  });
  stores.app.actions.setResults(PLAYLIST_SOURCE.id, emptyCountResult(12));
  stores.app.actions.toggleBuilderSection(PLAYLIST_SOURCE.id, section);
}

/** "Road Trip"'s sort options menu, open — mounted only once the story's setup
 * has opened the playlist, as a real menu is only ever opened on an open tab.
 * The setup runs in the harness's layout effect, after the story's own have
 * run, so a menu mounted alongside it would focus its first row before
 * "Playlist order" was there to be first. */
function RoadTripSortOptions(): JSX.Element | null {
  const open = useApp((s) => selectTab(s, PLAYLIST_SOURCE.id) !== undefined);
  if (!open) return null;
  return (
    <Menu defaultOpen width="240px" trigger={() => null}>
      <SectionOptionsMenu tabId={PLAYLIST_SOURCE.id} section="sort" />
    </Menu>
  );
}

/** Adds three `track` presets to the fixture's two — a default filter, a sort
 * and a default display — so the preset manager has a table with something
 * in every section, and one with an empty section or two. With no schema
 * loaded, those two are the tables it lists. */
/** The filter section's options menu on "Lemonade", once it's open. */
function LemonadeFilterOptions(): JSX.Element | null {
  const open = useApp((s) => selectTab(s, LEMONADE.id) !== undefined);
  if (!open) return null;
  return (
    <Menu defaultOpen width="240px" trigger={() => null}>
      <SectionOptionsMenu tabId={LEMONADE.id} section="filter" />
    </Menu>
  );
}

/** The id of "loved", the default filter {@link seedManagedPresets} adds. */
/** One column per annotation an embedded record reads: see
 * `embedded-record/annotated`. */
const EMBED_ANNOTATIONS: AnnotationValue[] = [
  { hide: "yes" },
  { width: 150 },
  {
    width: 60,
    align: "right",
    formatter: { type: "number", decimalPlaces: 2 },
  },
  { width: 60, align: "center", formatter: { type: "duration" } },
  { prefix: "#", suffix: " plays", color: "light" },
  { size: "small", color: "light" },
];
const ANNOTATED_EMBED_COLUMNS = EMBED_ANNOTATIONS.map(
  columnMetadataFromAnnotation,
);

const LOVED_PRESET_ID = "00000000-0000-0000-0000-0000000000b1";

function seedManagedPresets(stores: Stores): void {
  const preset = (
    n: number,
    name: string,
    section: string,
    definition: string,
    isDefault: boolean,
  ) => ({
    id: `00000000-0000-0000-0000-0000000000b${n}`,
    name,
    baseTable: "track",
    section,
    definition,
    isDefault,
    createdAt: 1_700_000_000,
    modifiedAt: 1_700_000_000,
  });
  stores.app.store.setState((s) => {
    s.presets.push(
      preset(1, "loved", "filter", "rating.value:>=5", true),
      preset(2, "by artist", "sort", "\\\\artist.name \\\\year", false),
      preset(3, "compact", "display", "$title $artist.name $year", true),
    );
  });
}

/** {@link seedManagedPresets}, with the two tables that have presets
 * expanded in the manager. */
function seedExpandedTables(stores: Stores): void {
  seedManagedPresets(stores);
  stores.app.actions.toggleManagedTable("album", false);
  stores.app.actions.toggleManagedTable("track", false);
}

/** Opens "Lemonade" carrying `def` as its (saved) query. */
function openWithDefinition(stores: Stores, def: QueryDefinition): string {
  const id = openLemonade(stores);
  stores.app.actions.setTabDefinitions(id, def, def);
  return id;
}

/** Puts the toolbar's whole conditional group on screen for tab `id`, showing
 * `def`: an undo history standing between the query as it was opened and an
 * edit that's since been undone (so both Undo and Redo apply), and a last save
 * that failed (so Save is back). Written straight into the store — reaching it
 * through the actions would take real runs and a real save. */
function undoableFailedSave(
  stores: Stores,
  id: string,
  def: QueryDefinition,
): void {
  const undone: QueryDefinition = {
    ...def,
    filter: { ...def.filter, custom: "" },
  };
  const history = [emptyDefinition(), def, undone].reduce(
    (h, d) => checkpoint(h, d, defsEqual),
    EMPTY_HISTORY as UndoHistory<QueryDefinition>,
  );
  stores.app.store.setState((s) => {
    const page = s.pages[id];
    if (page) page.undo = castDraft(stepBack(history));
    const tab = s.tabs.find((t) => t.id === id);
    if (tab?.kind === "query") {
      tab.saved = emptyDefinition();
      tab.saveFailed = true;
    }
  });
}

/** The filter builder with the "vetted" preset's inline editor open. */
function expandedVettedPreset(stores: Stores): string {
  const id = openWithDefinition(stores, FILTER_DEF);
  stores.app.actions.toggleBuilderSection(id, "filter");
  stores.app.actions.toggleExpandPreset(id, VETTED_PRESET_ID);
  return id;
}

/** Puts `diagnostic` on tab `id`'s error strip, written straight into the
 * store — turning it up through the actions would take the real compiler. */
function showProblem(
  stores: Stores,
  id: string,
  diagnostic: Omit<QueryDiagnostic, "hint" | "notes"> &
    Partial<QueryDiagnostic>,
): void {
  stores.app.store.setState((s) => {
    const page = s.pages[id];
    if (page) {
      page.diagnostic = castDraft({ hint: null, notes: [], ...diagnostic });
    }
  });
}

/** A prelude whose last definition is left open, as the prelude editor's
 * error story holds it. */
const BROKEN_PRELUDE = `${SETTINGS.querydown_prelude.default}\n#track.x = (`;

/** Opens "Lemonade" and seeds a playing track — the now-playing bar's stories'
 * shared setup. `rowIndex: null` leaves the track deliberately unlocated in
 * the results, which is what disables "Locate" in `now-playing/menu`. */
function seedPlayback(stores: Stores): void {
  const id = openLemonade(stores);
  const track: CurrentTrack = {
    sourceTabId: id,
    id: "seeded-track",
    rowIndex: null,
    title: "Uncatena",
    artists: ["Sylvan Esso", "Nick Sanborn"],
  };
  const playback: PlaybackState = {
    playing: true,
    position: 74,
    duration: 255,
    hasNext: true,
  };
  stores.app.actions.seedNowPlaying(track, playback);
}

/** The track a record story edits: a row of the seeded grid, keyed as
 * `?records=` keys them (row N is `track-N`). */
const trackRecord = (n: number): RecordRef => ({
  table: "track",
  key: [{ column: "id", value: `track-${n}` }],
});

/** The rating vocabulary the "Rate track" submenu lists — migration 0003's
 * seeded ratings, which is what a real database answers the ratings query with.
 * Put straight into the store rather than loaded, so the story needs no
 * stand-in backend for it. */
const RATINGS_FIXTURE: readonly Rating[] = [
  { id: "rating-1", value: "1", symbol: "🗑️", description: "Skip" },
  { id: "rating-2", value: "2", symbol: "✔️", description: "Like" },
  { id: "rating-3", value: "3", symbol: "⭐", description: "Prefer" },
  { id: "rating-4", value: "4", symbol: "❤️", description: "Love" },
];

/** The record of `table` with `id` `id`, as a result row identifies it. */
const idRecord = (table: string, id: string): RecordRef => ({
  table,
  key: [{ column: "id", value: id }],
});

/** A row context-menu story: the menu raised on a row carrying `records` —
 * a track and its album, unless it says otherwise — with the "Rate track"
 * submenu's ratings loaded (or, with `ratingsLoading`, still on their way).
 * The submenus that look records up (a track's artists, its album) ask the
 * record fixture, which holds every answer back `lookupDelay` ms. `playlist`
 * raises it on a playlist's page. */
function rowActionsMenu(
  opts: {
    records?: readonly RecordRef[];
    ratingsLoading?: boolean;
    lookupDelay?: number;
    playlist?: boolean;
    /** Rows of the grid to queue first, whose tracks the menu's own row
     * (row 0) goes before or after — or, for row 0 itself, comes out of. */
    queued?: readonly number[];
  } = {},
): Story {
  const records = opts.records ?? [
    trackRecord(1),
    idRecord("album", "album-1"),
  ];
  const groups = records.map((record) => ({
    table: record.table,
    records: [record],
  }));
  const tracks = records.some((record) => record.table === "track");
  return {
    setup: (stores) => {
      stores.app.actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
      installRecordFixture(opts.lookupDelay ?? 0);
      if (!opts.ratingsLoading) {
        stores.app.store.setState((s) => {
          s.ratings = { status: "ready", data: castDraft(RATINGS_FIXTURE) };
        });
      }
      // Rows of tracks, as the queue's entries read them: the menu is row 0's.
      if (tracks) {
        const id = openLemonade(stores);
        const { result, lineage } = lemonadeGridResult({
          trackIds: GRID_TRACK_IDS,
        });
        stores.app.actions.setResults(id, result, lineage);
        if (opts.queued) stores.app.actions.queueRows(id, opts.queued, "last");
      }
    },
    render: () => (
      <ContextMenu x={8} y={8} onClose={() => {}}>
        <RowActionsMenu
          tabId={tracks ? LEMONADE.id : "row-menu"}
          groups={groups}
          trackRows={tracks ? MENU_ROWS : undefined}
          onAddToPlaylist={tracks ? () => {} : undefined}
          onRemoveFromPlaylist={opts.playlist ? () => {} : undefined}
          onSelectMultiple={() => {}}
        />
      </ContextMenu>
    ),
  };
}

/** The track ids of the grid's rows, for stories about playing and queuing. */
const GRID_TRACK_IDS = ["t1", "t2", "t3", "t4", "t5"];

/** The rows a row-menu story's menu was raised on. */
const MENU_ROWS: readonly number[] = [0];

/** A record-editor story: the panel alone, on the tracks `ns` names (rows of
 * the seeded grid, selected), over the
 * canned schema and record data (`recordFixture.ts`) that stand in for a
 * backend. More than one track is the bulk case — the same form, on every record
 * the result-row selection covers. `saveFails` makes the next save come back
 * refused, with that message. */
function recordEditor(ns: readonly number[], saveFails?: string): Story {
  return {
    width: 340,
    height: 640,
    frame: "flex",
    setup: (stores) => {
      if (saveFails !== undefined) failDml(saveFails);
      stores.app.actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
      installRecordFixture(0);
      // Opened as the app opens it: on the result rows the tracks sit on,
      // selected — the editor follows the selection, and closes without one.
      const id = openLemonade(stores);
      const { result, lineage } = lemonadeGridResult({
        recordKeys: {
          track: ["track-1", "track-2", "track-3", "track-4", "track-5"],
        },
      });
      stores.app.actions.setResults(id, result, lineage);
      ns.forEach((n, i) =>
        stores.app.actions.clickRow(id, n - 1, { shift: false, ctrl: i > 0 }),
      );
      stores.app.actions.setRecordEditorRecords(
        id,
        "track",
        ns.map(trackRecord),
      );
    },
    // The panel leaves room beside it for the results, so its parent has to
    // have some to leave; the stage shows the panel alone.
    render: () => (
      <div className="flex h-full w-[500px] shrink-0">
        <RecordEditorPanel tabId={LEMONADE.id} />
      </div>
    ),
  };
}

/** Commonest first: every value held by a different number of records. */
const PAGED_VALUES = Array.from({ length: 120 }, (_, i) => ({
  value: `Value ${i + 1}`,
  count: 120 - i,
}));

/** A text box in edit mode with autocomplete on, over more values than fit on one
 * page. */
function PagedAutocomplete(): JSX.Element {
  const [text, setText] = useState("");
  return (
    <ValueInput
      text={text}
      label="title"
      editing={true}
      expanded={false}
      multiline={true}
      selectAll={false}
      autocomplete={{
        active: true,
        toggle: () => undefined,
        close: () => undefined,
        search: () => Promise.resolve(PAGED_VALUES),
      }}
      onBeginEdit={() => undefined}
      onInput={setText}
      onCommit={() => undefined}
    />
  );
}

/** `story`, on a `track` table the user has customized with `fields`, and
 * showing what they've hidden. */
function withFieldMetadata(
  story: Story,
  fields: readonly (readonly [FieldRef, FieldMetadata])[],
): Story {
  return {
    ...story,
    setup: (stores) => {
      stores.app.store.setState((s) => {
        s.fieldMetadata.data = {
          track: Object.fromEntries(
            fields.map(([field, metadata]) => [fieldRefKey(field), metadata]),
          ),
        };
        s.showHiddenFields = true;
      });
      story.setup?.(stores);
    },
  };
}

/** `story`, with `queries` as the contextual queries the app has loaded. */
function withContextualQueries(
  story: Story,
  queries: readonly ContextualQuery[],
): Story {
  return {
    ...story,
    setup: (stores) => {
      stores.app.store.setState((s) => {
        s.contextualQueries = { status: "ready", data: castDraft(queries) };
      });
      story.setup?.(stores);
    },
  };
}

/** A contextual query of tracks: the credits of the track it's shown on that
 * feature another artist. */
const FEATURED_QUERY: ContextualQuery = {
  id: "query-featured",
  tableName: "track",
  name: "featured",
  definition: {
    ...emptyDefinition(),
    base: "credit",
    filter: { custom: 'track:=@id\nrole:="role-featured"', presets: [] },
    sort: { custom: "\\\\order" },
    display: { custom: "$artist.name" },
  },
};

/** The toolbar of whichever query tab is active — for a story about a tab whose
 * id is minted as it opens (a new query's). */
function ActiveQueryToolbar(): JSX.Element | null {
  const id = useApp((s) => s.activeTabId);
  return id === null ? null : <QueryToolbar tabId={id} />;
}

function ActiveNewQueryPrompt(): JSX.Element | null {
  const id = useApp((s) => s.activeTabId);
  return id === null ? null : <NewQueryPrompt tabId={id} />;
}

/** Filler for the stories about a component's own layout rather than about
 * anything it holds. */
function Lorem(props: { heading: string; lines: number }): JSX.Element {
  const text =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do " +
    "eiusmod tempor incididunt ut labore et dolore magna aliqua.";
  return (
    <div className="text-ink flex flex-col gap-2 p-3 text-sm">
      <h2 className="font-semibold">{props.heading}</h2>
      {Array.from({ length: props.lines }, (_, i) => (
        <p key={i} className="text-ink-weak">
          {text}
        </p>
      ))}
    </div>
  );
}

/** A menu body with a submenu beside a plain row, a sibling submenu, and a
 * submenu nested inside the first — the shapes the menu specs drive the
 * pointer and the keyboard through. */
function NestedMenuBody(): JSX.Element {
  return (
    <>
      <MenuItem label="Alpha" />
      <MenuSubmenu label="Colors">
        <MenuItem label="Red" />
        <MenuItem label="Green" />
        <MenuItem label="Blue" />
        <MenuSubmenu label="More">
          <MenuItem label="Cyan" />
          <MenuItem label="Magenta" />
        </MenuSubmenu>
      </MenuSubmenu>
      <MenuSubmenu label="Sizes">
        <MenuItem label="Small" />
        <MenuItem label="Large" />
      </MenuSubmenu>
      <MenuItem label="Omega" />
    </>
  );
}

/** The event `menu/late-rows` waits for before its submenu's rows arrive, so a
 * test can look at the submenu while it's loading and then let them in. */
export const LATE_ROWS_EVENT = "story:late-rows";

/** A submenu body whose rows load late: a "Loading…" row until the window
 * sees {@link LATE_ROWS_EVENT}, then a dozen rows, each far wider than it. */
function LateRows(): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const load = () => setLoaded(true);
    window.addEventListener(LATE_ROWS_EVENT, load);
    return () => window.removeEventListener(LATE_ROWS_EVENT, load);
  }, []);
  return (
    <MenuLoader loading={!loaded}>
      {Array.from({ length: 12 }, (_, i) => (
        <MenuItem
          key={i}
          label={`A row much, much wider than the "Loading…" row it replaces — number ${i + 1}`}
        />
      ))}
    </MenuLoader>
  );
}

/** The export dialog's callbacks, all inert. */
const EXPORT_DIALOG_HANDLERS = {
  onRowsChange: () => {},
  onAllColumnsIncludedChange: () => {},
  onColumnIncludedChange: () => {},
  onColumnRawChange: () => {},
  onCopy: () => {},
  onDownload: () => {},
  onClose: () => {},
};

/** A track query's columns as the export dialog lists them. */
const EXPORT_COLUMNS: ExportColumnOption[] = [
  {
    index: 1,
    label: "Column 0",
    sample: "Hold Up",
    formatted: false,
    included: true,
    raw: false,
  },
  {
    index: 2,
    label: "Column 1",
    sample: "Beyoncé, Jack White",
    formatted: false,
    included: false,
    raw: false,
  },
  {
    index: 3,
    label: "Column 2",
    sample: "3:41",
    formatted: true,
    included: true,
    raw: false,
  },
  {
    index: 4,
    label: "Column 3",
    sample: "2026-09-14 08:12:55",
    formatted: true,
    included: true,
    raw: true,
  },
];

export const STORIES: Record<string, Story> = {
  // ── The app's left sidebar, as a general-purpose panel ────────────────────
  // Both stories are about `SidebarLeft`'s two layouts and nothing else, so
  // what it holds is filler. The layout it picks comes from the viewport, so
  // these stories take their size from the test rather than declaring one.
  "sidebar-left/open-persistent": {
    frame: "flex",
    render: () => (
      <SidebarLeft
        open
        onClose={() => {}}
        width={200}
        onResize={() => {}}
        onResizeEnd={() => {}}
        main={<Lorem heading="Main content" lines={3} />}
      >
        <Lorem heading="Sidebar" lines={2} />
      </SidebarLeft>
    ),
  },
  "sidebar-left/open-ephemeral": {
    frame: "flex",
    render: () => (
      <SidebarLeft
        open
        onClose={() => {}}
        width={200}
        onResize={() => {}}
        onResizeEnd={() => {}}
        main={<Lorem heading="Main content" lines={3} />}
      >
        <Lorem heading="Sidebar" lines={2} />
      </SidebarLeft>
    ),
  },

  // ── A sidebar's scrolling region, overflowing ─────────────────────────────
  "scroll-area/overflowing": {
    width: 240,
    height: 300,
    frame: "flex flex-col",
    render: () => (
      <ScrollArea>
        <Lorem heading="Scrolling" lines={12} />
      </ScrollArea>
    ),
  },

  // ── The explorer, without the panel it fills ─────────────────────────────
  // The "Opened" list only shows where the explorer is a drawer, so its test
  // takes a phone's viewport.
  "explorer/basic": {
    width: 200,
    height: 600,
    frame: "flex flex-col",
    setup: (stores) => {
      const active = openLemonade(stores);
      stores.app.actions.openTab({
        id: DEEP_CUTS.id,
        name: DEEP_CUTS.name,
        definition: "",
      });
      stores.app.actions.selectTab(active);
    },
    render: () => <Explorer />,
  },
  // The saved queries arranged in folders, one open and two closed. The
  // delete confirmation (an app-wide dialog) comes along for the explorer's
  // own "Delete", and draws nothing until it's raised.
  "explorer/tree": {
    width: 220,
    height: 360,
    frame: "flex flex-col",
    setup: arrangeSourceTree,
    render: () => (
      <>
        <Explorer />
        <DeleteConfirmModal />
      </>
    ),
  },
  // A filter that matches one query deep inside a closed folder: the folders
  // above it open to show it, and nothing else shows.
  "explorer/filter": {
    width: 220,
    height: 360,
    frame: "flex flex-col",
    setup: (stores) => {
      arrangeSourceTree(stores);
      stores.app.actions.toggleSourceFilter();
      stores.app.actions.setSourceFilter("workout");
    },
    render: () => <Explorer />,
  },
  // A folder's name being edited in place.
  "explorer/folder-rename": {
    width: 220,
    height: 360,
    frame: "flex flex-col",
    setup: (stores) => {
      arrangeSourceTree(stores);
      stores.app.actions.beginTreeRename({ kind: "folder", id: ROAD_TRIP });
    },
    render: () => <Explorer />,
  },

  // Result rows being dragged over a playlist in the tree: the playlist that
  // would take them is outlined, as a folder taking a dragged item is.
  "explorer/tracks-drop": {
    width: 220,
    height: 360,
    frame: "flex flex-col",
    setup: (stores) => {
      arrangeSourceTree(stores);
      stores.app.store.setState((s) => {
        s.sources.data = [...s.sources.data, PLAYLIST_SOURCE];
        s.rowDrag = {
          fromTabId: LEMONADE.id,
          trackIds: ["t1", "t2"],
          entryIds: [],
          over: PLAYLIST_SOURCE.id,
          gap: null,
        };
      });
    },
    render: () => <Explorer />,
  },

  // ── The tab bar ──────────────────────────────────────────────────────────
  // A saved query beside a new one, active: the new query has no name yet, so
  // its handle reads "new" in gray, with the ✱ of a query the backend
  // doesn't have.
  "tab-bar/new-query": {
    width: 520,
    frame: "flex flex-col",
    setup: (stores) => {
      openLemonade(stores);
      stores.app.actions.newQueryTab();
    },
    render: () => <TabBar />,
  },

  // A playlist tab, active, beside a query's: the playlist's handle carries the
  // `queue_music` icon, and never the ✱ (a playlist is always saved).
  "tab-bar/playlist": {
    width: 520,
    frame: "flex flex-col",
    setup: (stores) => {
      openLemonade(stores);
      openRoadTrip(stores);
    },
    render: () => <TabBar />,
  },

  // Three tabs to drag among: Lemonade, the Road Trip playlist, then a new
  // query, active.
  "tab-bar/reorder": {
    width: 520,
    frame: "flex flex-col",
    setup: (stores) => {
      openLemonade(stores);
      openRoadTrip(stores);
      stores.app.actions.newQueryTab();
    },
    render: () => <TabBar />,
  },

  // The explorer toggle hovered: its tooltip names it and shows the shortcut
  // that does the same, as keycaps. Tall enough to hold the tooltip below the
  // bar. (The hover is the test's.)
  "tab-bar/tooltip": {
    width: 320,
    height: 72,
    frame: "flex flex-col",
    setup: (stores) => {
      openLemonade(stores);
    },
    render: () => <TabBar />,
  },

  // ── The content area with no tab open ────────────────────────────────────
  // As narrow as a phone leaves it beside the explorer: each shortcut wraps
  // under its button's label.
  "no-tabs-page/narrow": {
    width: 180,
    height: 400,
    frame: "flex flex-col",
    render: () => <NoTabsPage />,
  },

  // ── Settings ─────────────────────────────────────────────────────────────
  "settings/menu": {
    width: 240,
    // Tall enough to clear the menu's bottom edge (its last row is "Re-scan
    // collection"), so the snapshot isn't cropping the panel.
    height: 400,
    render: () => (
      <Menu defaultOpen width="180px" trigger={() => null}>
        <SettingsMenu />
      </Menu>
    ),
  },
  // The same menu with a re-scan in flight: the row disabled, its icon replaced
  // by the spinner, and the menu still up — which is what a click on it leaves
  // behind until the call comes back.
  "settings/menu-rescanning": {
    width: 240,
    height: 400,
    setup: (stores) => {
      stores.app.store.setState((s) => {
        s.rescanning = true;
      });
    },
    render: () => (
      <Menu defaultOpen width="180px" trigger={() => null}>
        <SettingsMenu />
      </Menu>
    ),
  },
  // The Querydown prelude editor's page, holding the default value — the
  // state it opens in for anyone who hasn't customized it: Reset to default
  // and Save both disabled.
  "settings/prelude": {
    width: 720,
    height: 420,
    frame: "flex flex-col",
    setup: (stores) => {
      stores.app.actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
    },
    render: () => <PreludePage />,
  },
  // The prelude edited and not yet saved: the ✱ on Save, and Reset to default
  // enabled.
  "settings/prelude-unsaved": {
    width: 720,
    height: 420,
    frame: "flex flex-col",
    setup: (stores) => {
      stores.app.actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
      stores.app.actions.editPrelude(
        `${SETTINGS.querydown_prelude.default}\n#track.loud = rating.value:>=4`,
      );
    },
    render: () => <PreludePage />,
  },
  // The page with its "?" hovered: the help in a tooltip below it, kept
  // inside the right edge. (The hover is the test's.)
  "settings/prelude-help": {
    width: 720,
    height: 420,
    frame: "flex flex-col",
    render: () => <PreludePage />,
  },
  // The prelude holding a syntax error: the problem between the toolbar and
  // the editor — located, with the line marked — and Save disabled.
  "settings/prelude-problem": {
    width: 720,
    height: 420,
    frame: "flex flex-col",
    setup: (stores) => {
      stores.app.actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
      stores.app.actions.editPrelude(BROKEN_PRELUDE);
    },
    render: () => <PreludePage />,
  },
  // The rebind dialog holding a chord another command already owns, so the
  // "currently bound to" warning shows too (⌘/Ctrl+S is "Record editor: Save
  // changes").
  "settings/keyboard-shortcuts/modal-assign": {
    render: () => (
      <CaptureDialog
        cmd="explorer.toggle"
        pending={{ mod: true, ctrl: false, shift: false, alt: false, key: "S" }}
        onAssign={() => {}}
        onUnbind={() => {}}
        onReset={() => {}}
        onCancel={() => {}}
      />
    ),
  },

  // ── The now-playing bar ──────────────────────────────────────────────────
  "now-playing/playing": {
    width: 1280,
    frame: "flex flex-col",
    setup: (stores) => seedPlayback(stores),
    render: () => <NowPlaying />,
  },
  // The same menu with tracks queued, which adds "Clear queue".
  "now-playing/menu-queued": {
    width: 200,
    height: 120,
    setup: (stores) => {
      seedPlayback(stores);
      const { result, lineage } = lemonadeGridResult({
        trackIds: GRID_TRACK_IDS,
      });
      stores.app.actions.setResults(LEMONADE.id, result, lineage);
      stores.app.actions.queueRows(LEMONADE.id, [3], "last");
    },
    render: () => (
      <Menu defaultOpen width="130px" trigger={() => null}>
        <PlaybackActionsMenu />
      </Menu>
    ),
  },
  // Its overflow menu on its own. "Locate" is disabled: the seeded track is
  // deliberately left unlocated in the results (see `seedPlayback`).
  "now-playing/menu": {
    width: 160,
    height: 90,
    setup: (stores) => seedPlayback(stores),
    render: () => (
      <Menu defaultOpen width="130px" trigger={() => null}>
        <PlaybackActionsMenu />
      </Menu>
    ),
  },

  // ── The command palette ──────────────────────────────────────────────────
  // Filtered by a typed query, which also drops the non-matching commands.
  // Which commands are *available* comes from the store, so the story opens a
  // query tab with results the way the palette's `When` predicates expect.
  "command-palette/filtered": {
    setup: (stores) => {
      const id = openLemonade(stores);
      stores.app.actions.setResults(id, lemonadeGridResult().result);
      stores.commands.actions.togglePalette();
      stores.commands.actions.setPaletteQuery("tab");
    },
    render: () => <CommandPalette />,
  },

  // ── Client update + About ────────────────────────────────────────────────
  // The client-update bar in both of its notices: the dismissible "ready" one
  // over the persistent "stale" one.
  "update/banner": {
    width: 720,
    frame: "flex flex-col gap-2",
    render: () => (
      <>
        <UpdateBar notice="ready" onReload={() => {}} onDismiss={() => {}} />
        <UpdateBar notice="stale" onReload={() => {}} onDismiss={() => {}} />
      </>
    ),
  },
  // The failed-RPC bar: a first failure over one that has repeated, which
  // counts up instead of stacking.
  "error/banner": {
    width: 720,
    frame: "flex flex-col gap-2",
    render: () => (
      <>
        <RpcErrorBar
          notice={{
            method: "source.rename",
            message: "500 database is locked",
            count: 1,
          }}
          onDismiss={() => {}}
        />
        <RpcErrorBar
          notice={{
            method: "setting.set",
            message: "Failed to fetch",
            count: 3,
          }}
          onDismiss={() => {}}
        />
      </>
    ),
  },
  // The failed-RPC bar on a phone, given a message far longer than it has room
  // for: it stays a few lines tall, scrolls the rest, and keeps Dismiss in
  // reach.
  "error/banner-long": {
    width: 360,
    render: () => (
      <RpcErrorBar
        notice={{
          method: "dml",
          message: `500 ${"database is locked; ".repeat(60)}`,
          count: 1,
        }}
        onDismiss={() => {}}
      />
    ),
  },
  // The About dialog on a *mismatched* pair of build ids — the state it exists
  // to explain. Both ids are pinned here (the client's by prop, the server's by
  // `STUB_VERSION`) rather than read from `__BUILD_ID__`, so the baseline
  // doesn't churn with every commit.
  "about/modal": {
    render: () => (
      <AboutDialog
        clientBuildId="3c7ae10"
        version={STUB_VERSION}
        onCheck={() => {}}
        onReloadFresh={() => {}}
        onCopyPlaybackLog={() => Promise.resolve(0)}
        onClearPlaybackLog={() => {}}
        onClose={() => {}}
      />
    ),
  },

  // ── The query toolbar ────────────────────────────────────────────────────
  // Saved query with nothing to undo, redo or save, no builder open: the
  // wrench, the section toggles (inactive), and "12 results" with Refresh at
  // the far right.
  "query-builder/collapsed": {
    width: 1280,
    setup: (stores) => {
      const id = openWithDefinition(stores, FILTER_DEF);
      stores.app.actions.setResults(id, emptyCountResult(12));
    },
    render: () => <QueryToolbar tabId={LEMONADE.id} />,
  },
  // Filter section open on a query with a step to undo, one to redo, and a
  // failed save: the whole conditional group (separator, Undo, Redo, Save)
  // after the section toggles, the active split button with its ⋮, and the
  // builder line below it.
  "query-builder/filter-open": {
    width: 1280,
    setup: (stores) => {
      const id = openWithDefinition(stores, FILTER_DEF);
      stores.app.actions.setResults(id, emptyCountResult(12));
      stores.app.actions.toggleBuilderSection(id, "filter");
      undoableFailedSave(stores, id, FILTER_DEF);
    },
    render: () => <QueryToolbar tabId={LEMONADE.id} />,
  },
  // Compact (≤ 500px): the section buttons drop their labels.
  "query-builder/filter-open-narrow": {
    width: 460,
    setup: (stores) => {
      const id = openWithDefinition(stores, FILTER_DEF);
      stores.app.actions.setResults(id, emptyCountResult(12));
      stores.app.actions.toggleBuilderSection(id, "filter");
      undoableFailedSave(stores, id, FILTER_DEF);
    },
    render: () => <QueryToolbar tabId={LEMONADE.id} />,
  },
  // A syntax error in the open filter's own text: its input bordered in red
  // and the missing value's spot marked in it, the Filter toggle marked, and
  // the error strip under the builder with the line marked where the value is
  // missing. No "Show": it's on screen.
  "query-builder/filter-problem": {
    width: 1280,
    setup: (stores) => {
      const id = openWithDefinition(stores, {
        ...FILTER_DEF,
        filter: { ...FILTER_DEF.filter, custom: "jazz year:" },
      });
      stores.app.actions.setResults(id, emptyCountResult(12));
      stores.app.actions.toggleBuilderSection(id, "filter");
      showProblem(stores, id, {
        kind: "syntax",
        reason: "Unexpected end of input. Expected a value.",
        origin: { kind: "custom", section: "filter" },
        source: "jazz year:",
        range: { start: 10, end: 10 },
      });
    },
    render: () => <QueryToolbar tabId={LEMONADE.id} />,
  },
  // A problem in a collapsed filter preset: its row outlined in red, and the
  // strip offering "Show" to expand it, with the place the bracket opened and
  // the place it should have closed, and the compiler's hint.
  "query-builder/preset-problem": {
    width: 1280,
    setup: (stores) => {
      const id = openWithDefinition(stores, FILTER_DEF);
      stores.app.actions.setResults(id, emptyCountResult(12));
      stores.app.actions.toggleBuilderSection(id, "filter");
      const source = "rating.value:>=4 !++#tag{name:duplicate";
      showProblem(stores, id, {
        kind: "syntax",
        reason:
          "Unclosed `{`. Expected a matching `}` before the end of input.",
        hint: "Add a `}` where the group should end.",
        origin: { kind: "preset", id: VETTED_PRESET_ID, section: "filter" },
        source,
        range: { start: 24, end: 25 },
        notes: [
          {
            range: { start: source.length, end: source.length },
            message: "expected `}` here or earlier",
          },
        ],
      });
    },
    render: () => <QueryToolbar tabId={LEMONADE.id} />,
  },
  // A problem the compiler can't locate, with every builder closed: just the
  // strip, saying what's wrong — no section to mark, nothing to show. The base
  // table is the one thing it's handed apart from any section's text.
  "query-builder/compile-problem": {
    width: 1280,
    setup: (stores) => {
      const id = openWithDefinition(stores, FILTER_DEF);
      stores.app.actions.setResults(id, emptyCountResult(12));
      showProblem(stores, id, {
        kind: "compile",
        reason: "Base table `nope` does not exist.",
        origin: null,
        source: "",
        range: null,
      });
    },
    render: () => <QueryToolbar tabId={LEMONADE.id} />,
  },
  // A new query, never saved and not yet edited: of the conditional group,
  // just Save; no result count, since it hasn't run; and its filter builder
  // open, with the caret in the filter.
  "query-builder/new": {
    width: 1280,
    setup: (stores) => stores.app.actions.newQueryTab(),
    render: () => <ActiveQueryToolbar />,
  },
  // What a new query shows where its rows would be until it's touched: its
  // base table, beside its label, over the "Show all results" button.
  "query-page/new": {
    width: 640,
    height: 160,
    frame: "flex flex-col",
    setup: (stores) => {
      stores.app.actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
      stores.app.actions.newQueryTab();
    },
    render: () => <ActiveNewQueryPrompt />,
  },
  // Full-Querydown mode: the three section toggles collapse into one
  // "Querydown" toggle (no ⋮ — there are no sections to configure) over the
  // whole-query editor.
  "query-builder/querydown": {
    width: 1280,
    setup: (stores) => {
      const id = openWithDefinition(stores, FULL_DEF);
      stores.app.actions.setResults(id, emptyCountResult(12));
      stores.app.actions.toggleFullEditor(id);
    },
    render: () => <QueryToolbar tabId={LEMONADE.id} />,
  },
  // A playlist's toolbar, its Sort section open on "Playlist order": the same
  // controls as a query's, with no Save, and the built-in preset's tab in the
  // builder line.
  "query-builder/playlist": {
    width: 1280,
    setup: (stores) => {
      const id = openRoadTrip(stores);
      stores.app.actions.setResults(id, emptyCountResult(12));
      stores.app.actions.toggleBuilderSection(id, "sort");
    },
    render: () => <QueryToolbar tabId={PLAYLIST_SOURCE.id} />,
  },
  // The wrench menu, with its Base submenu open (the test opens it): the
  // schema's tables as an exclusive choice over the "Full Querydown" escape
  // hatch.
  "query-builder/actions-menu": {
    width: 440,
    height: 300,
    setup: (stores) => {
      stores.app.actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
      openWithDefinition(stores, FILTER_DEF);
    },
    render: () => (
      <Menu defaultOpen width="210px" trigger={() => null}>
        <PageActionsMenu tabId={LEMONADE.id} />
      </Menu>
    ),
  },
  // "Export results data" as it opens: all rows chosen, with some selected so
  // "Selected rows" is on offer too, and the columns folded away — three of
  // four checked.
  "export-data/modal": {
    render: () => (
      <ExportDataDialog
        {...EXPORT_DIALOG_HANDLERS}
        rows="all"
        selectedCount={3}
        columns={EXPORT_COLUMNS}
        canExport
        error={null}
      />
    ),
  },
  // Nothing selected, so no Rows field. The test unfolds the columns: one line
  // per column — one left out, two formatted ones offering raw data, one of
  // them switched to it.
  "export-data/columns": {
    render: () => (
      <ExportDataDialog
        {...EXPORT_DIALOG_HANDLERS}
        rows="all"
        selectedCount={0}
        columns={EXPORT_COLUMNS}
        canExport
        error={null}
      />
    ),
  },

  // A playlist's sort options: "Playlist order" first, and checked — what a
  // playlist's sort starts as — over the query's own entries.
  "sort-options/playlist": {
    width: 280,
    height: 160,
    setup: openRoadTrip,
    render: () => <RoadTripSortOptions />,
  },

  // ── The builders, without the toolbar above them ─────────────────────────
  // Preset expanded, no unsaved edits: the inline editor (name + apply-by-
  // default + definition), no star/revert/save, and how many queries use it at
  // the heading's far right.
  "filter-builder/preset-expanded": {
    width: 1280,
    setup: expandedVettedPreset,
    render: () => <QueryBuilder tabId={LEMONADE.id} />,
  },
  // Narrow: the checkbox and Inline button wrap together under the name.
  "filter-builder/preset-expanded-narrow": {
    width: 380,
    setup: expandedVettedPreset,
    render: () => <QueryBuilder tabId={LEMONADE.id} />,
  },
  // The same preset after a write of a change to it failed: red ✱ plus revert
  // and save appear, and the checkbox (the change) is checked.
  "filter-builder/preset-save-failed": {
    width: 1280,
    setup: (stores) => {
      expandedVettedPreset(stores);
      // Straight into the store: through the actions, the editor's mounting
      // under StrictMode would send the write, and the stand-in backend accept it.
      stores.app.store.setState((s) => {
        const preset = s.presets.find((p) => p.id === VETTED_PRESET_ID)!;
        s.presetSaves[VETTED_PRESET_ID] = {
          saved: { ...preset },
          failed: true,
        };
        preset.isDefault = true;
      });
    },
    render: () => <QueryBuilder tabId={LEMONADE.id} />,
  },
  // Three presets, each on its own line under the custom input: two closed
  // ones, as wide as their headings, with Remove beside the name, and one open,
  // with Inline in its editor.
  "filter-builder/presets": {
    width: 1280,
    setup: (stores) => {
      seedManagedPresets(stores);
      const id = openWithDefinition(stores, {
        ...FILTER_DEF,
        filter: {
          custom: "jazz playcount:<100",
          presets: [
            VETTED_PRESET_ID,
            LOVED_PRESET_ID,
            "00000000-0000-0000-0000-0000000000b4",
          ],
        },
      });
      stores.app.store.setState((s) => {
        s.presets.push({
          ...s.presets.find((p) => p.id === VETTED_PRESET_ID)!,
          id: "00000000-0000-0000-0000-0000000000b4",
          name: "a much longer preset name",
          definition: "year:>=1990",
        });
      });
      stores.app.actions.toggleBuilderSection(id, "filter");
      stores.app.actions.toggleExpandPreset(id, LOVED_PRESET_ID);
    },
    render: () => <QueryBuilder tabId={LEMONADE.id} />,
  },
  // Two presets open at once.
  "filter-builder/presets-expanded": {
    width: 1280,
    setup: (stores) => {
      seedManagedPresets(stores);
      const id = openWithDefinition(stores, {
        ...FILTER_DEF,
        filter: {
          custom: "",
          presets: [VETTED_PRESET_ID, LOVED_PRESET_ID],
        },
      });
      stores.app.actions.toggleBuilderSection(id, "filter");
      stores.app.actions.toggleExpandPreset(id, VETTED_PRESET_ID);
      stores.app.actions.toggleExpandPreset(id, LOVED_PRESET_ID);
    },
    render: () => <QueryBuilder tabId={LEMONADE.id} />,
  },
  // "Add new": a blank preset in force before it's ever been saved, open with
  // discard and a save that waits for a name.
  "filter-builder/new-preset": {
    width: 1280,
    setup: (stores) => {
      const id = openWithDefinition(stores, FILTER_DEF);
      stores.app.actions.addNewPreset(id, "filter");
    },
    render: () => <QueryBuilder tabId={LEMONADE.id} />,
  },
  // A sort section holding one preset, closed.
  "sort-builder/preset": {
    width: 1280,
    setup: (stores) => {
      seedManagedPresets(stores);
      const id = openWithDefinition(stores, {
        ...FILTER_DEF,
        sort: { preset: "00000000-0000-0000-0000-0000000000b2" },
      });
      stores.app.actions.toggleBuilderSection(id, "sort");
    },
    render: () => <QueryBuilder tabId={LEMONADE.id} />,
  },
  // The filter section's options menu: the presets, then "Add new" and "Manage
  // presets".
  "section-options/filter": {
    width: 320,
    height: 280,
    setup: (stores) => {
      seedManagedPresets(stores);
      openWithDefinition(stores, FILTER_DEF);
    },
    render: () => <LemonadeFilterOptions />,
  },
  // A playlist's filter, applying a condition: "Remove these tracks" and "Keep
  // only these tracks" at the builder's foot.
  "filter-builder/playlist": {
    width: 1280,
    setup: (stores) =>
      openRoadTripOn(
        stores,
        {
          filter: { custom: "artist:queen", presets: [] },
          sort: { builtin: { preset: "playlist_order" } },
          display: { custom: "" },
        },
        "filter",
      ),
    render: () => <QueryBuilder tabId={PLAYLIST_SOURCE.id} />,
  },
  // A playlist's custom sort: "Commit this track order to playlist" under it.
  "sort-builder/playlist": {
    width: 1280,
    setup: (stores) =>
      openRoadTripOn(
        stores,
        {
          filter: { custom: "", presets: [] },
          sort: { custom: "\\\\year \\\\title" },
          display: { custom: "" },
        },
        "sort",
      ),
    render: () => <QueryBuilder tabId={PLAYLIST_SOURCE.id} />,
  },
  // Sort built-in: the Shuffle preset beside its Reshuffle button.
  "sort-builder/shuffle": {
    width: 1280,
    setup: (stores) => {
      const id = openWithDefinition(stores, SHUFFLE_DEF);
      stores.app.actions.toggleBuilderSection(id, "sort");
    },
    render: () => <QueryBuilder tabId={LEMONADE.id} />,
  },

  // ── The preset manager ───────────────────────────────────────────────────
  // As it opens: every table of the schema collapsed, with its preset count.
  "preset-manager/collapsed": {
    width: 720,
    height: 520,
    frame: "flex flex-col",
    setup: (stores) => {
      stores.app.actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
      seedManagedPresets(stores);
    },
    render: () => <PresetManager />,
  },
  // Two tables' presets, by section: `album` with only a (default) sort,
  // `track` with something in every section.
  "preset-manager/basic": {
    width: 720,
    height: 640,
    frame: "flex flex-col",
    setup: seedExpandedTables,
    render: () => <PresetManager />,
  },
  // Phone width.
  "preset-manager/narrow": {
    width: 360,
    height: 720,
    frame: "flex flex-col",
    setup: seedExpandedTables,
    render: () => <PresetManager />,
  },
  // "vetted" and "loved" open at once in the builders' inline editor, with an
  // edit to the first on its way to the backend: nothing to do about it, so no
  // ✱ on the row and no save in the editor.
  "preset-manager/expanded": {
    width: 720,
    height: 640,
    frame: "flex flex-col",
    setup: (stores) => {
      seedExpandedTables(stores);
      stores.app.actions.toggleManagedPreset(VETTED_PRESET_ID);
      stores.app.actions.toggleManagedPreset(LOVED_PRESET_ID);
      stores.app.actions.patchPreset(VETTED_PRESET_ID, {
        definition: "rating.value:>=4",
      });
    },
    render: () => <PresetManager />,
  },
  // A new `track` filter being written at the top of its section, and a copy
  // of `album`'s default sort at the top of its own.
  "preset-manager/draft": {
    width: 720,
    height: 640,
    frame: "flex flex-col",
    setup: (stores) => {
      seedManagedPresets(stores);
      stores.app.actions.openPresetDraft("track", "filter");
      stores.app.actions.patchPreset(
        stores.app.store.getState().unsavedPresets[0].id,
        { name: "nineties", definition: "year:>=1990 year:<2000" },
      );
      const albumSort = stores.app.store
        .getState()
        .presets.find((p) => p.baseTable === "album");
      if (albumSort) stores.app.actions.duplicatePreset(albumSort.id);
    },
    render: () => <PresetManager />,
  },
  // Deleting "vetted", which a saved query and an open playlist both use.
  "preset-manager/delete": {
    setup: (stores) => {
      stores.app.store.setState((s) => {
        s.sources.data[0].definition = JSON.stringify(FILTER_DEF);
      });
      stores.app.actions.openTab(PLAYLIST_SOURCE);
      stores.app.actions.toggleFilterPreset(
        PLAYLIST_SOURCE.id,
        VETTED_PRESET_ID,
      );
      stores.app.actions.requestPresetDelete(VETTED_PRESET_ID);
    },
    render: () => <PresetDeleteModal />,
  },

  // ── The results grid ─────────────────────────────────────────────────────
  "results/basic": {
    width: 1280,
    height: 200,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openLemonade(stores);
      const { result, lineage } = lemonadeGridResult();
      stores.app.actions.setResults(id, result, lineage);
    },
    render: () => <QueryResults tabId={LEMONADE.id} />,
  },
  // The same rows in multi-select mode: the floating toolbar over them, two
  // rows selected, and the first rows scrolled clear of the bar.
  "results/multi-select": {
    width: 1280,
    height: 200,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openLemonade(stores);
      const { result, lineage } = lemonadeGridResult({
        recordKeys: {
          track: ["track-1", "track-2", "track-3", "track-4", "track-5"],
          album: ["album-1", "album-1", "album-2", "album-2", "album-3"],
        },
      });
      stores.app.actions.setResults(id, result, lineage);
      stores.app.actions.setMultiSelect(id, true);
      stores.app.actions.clickRow(id, 1, { shift: false, ctrl: false });
      stores.app.actions.clickRow(id, 3, { shift: false, ctrl: false });
    },
    render: () => <QueryResults tabId={LEMONADE.id} />,
  },
  // The playing row, ringed by its blue rectangle — seeded on row 1 so the rows
  // around it show the ring is a frame around one row, not a divider.
  "results/playing-row": {
    width: 1280,
    height: 200,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openLemonade(stores);
      const { result, lineage } = lemonadeGridResult();
      stores.app.actions.setResults(id, result, lineage);
      stores.app.actions.seedNowPlaying(
        {
          sourceTabId: id,
          id: "seeded-track",
          rowIndex: 1,
          title: "Uncatena",
          artists: ["Sylvan Esso", "Nick Sanborn"],
        },
        { playing: true, position: 74, duration: 255, hasNext: true },
      );
    },
    render: () => <QueryResults tabId={LEMONADE.id} />,
  },
  // The same playing row on a stage too short for all five rows, so the grid
  // shows its scrollbar: the ring stays full-width and the thumb rides over it,
  // rather than the ring pulling in and clipping the row's last column.
  "results/playing-row-scrollbar": {
    width: 1280,
    height: 110,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openLemonade(stores);
      const { result, lineage } = lemonadeGridResult();
      stores.app.actions.setResults(id, result, lineage);
      stores.app.actions.seedNowPlaying(
        {
          sourceTabId: id,
          id: "seeded-track",
          rowIndex: 1,
          title: "Uncatena",
          artists: ["Sylvan Esso", "Nick Sanborn"],
        },
        { playing: true, position: 74, duration: 255, hasNext: true },
      );
    },
    render: () => <QueryResults tabId={LEMONADE.id} />,
  },
  // Queued tracks' rows, dashed where the playing row is solid, each with a
  // badge giving its place in the queue: row 3 queued first, then row 0,
  // whose badge sits inside its ring for want of a row above. Row 3 is
  // selected too, and row 2 is playing.
  "results/queued-rows": {
    width: 1280,
    height: 200,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openLemonade(stores);
      const { result, lineage } = lemonadeGridResult({
        trackIds: GRID_TRACK_IDS,
      });
      stores.app.actions.setResults(id, result, lineage);
      stores.app.actions.seedNowPlaying(
        {
          sourceTabId: id,
          id: "t3",
          rowIndex: 2,
          title: "Uncatena",
          artists: ["Sylvan Esso", "Nick Sanborn"],
        },
        { playing: true, position: 74, duration: 255, hasNext: true },
      );
      stores.app.actions.queueRows(id, [3], "last");
      stores.app.actions.queueRows(id, [0], "last");
      stores.app.actions.clickRow(id, 3, { shift: false, ctrl: false });
    },
    render: () => <QueryResults tabId={LEMONADE.id} />,
  },
  // One queued track: its ring, but no badge, since there's no order to give.
  "results/queued-row": {
    width: 1280,
    height: 200,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openLemonade(stores);
      const { result, lineage } = lemonadeGridResult({
        trackIds: GRID_TRACK_IDS,
      });
      stores.app.actions.setResults(id, result, lineage);
      stores.app.actions.queueRows(id, [1], "last");
    },
    render: () => <QueryResults tabId={LEMONADE.id} />,
  },
  // A playlist's row being dragged to another place among its rows: the row
  // in hand stays selected where it is, and the drop line marks the gap
  // between the first two rows, where it would land. No pointer has moved, so
  // the "1 track" chip sits at the stage's top-left corner.
  "results/playlist-drop": {
    width: 1280,
    height: 200,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openRoadTrip(stores);
      const entryIds = ["e1", "e2", "e3", "e4", "e5"];
      const { result } = lemonadeGridResult({ entryIds });
      stores.app.actions.setResults(id, result, { records: [] });
      stores.app.actions.clickRow(id, 3, { shift: false, ctrl: false });
      stores.app.store.setState((s) => {
        s.rowDrag = {
          fromTabId: id,
          trackIds: [],
          entryIds: ["e4"],
          over: null,
          gap: 1,
        };
      });
    },
    render: () => <QueryResults tabId={PLAYLIST_SOURCE.id} />,
  },
  // Two selected rows of five, all identifying a track, for a test to swipe:
  // both come away together, over the band that names what letting go will do.
  "results/row-swipe": {
    width: 800,
    height: 200,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openLemonade(stores);
      const recordKeys = { track: ["t1", "t2", "t3", "t4", "t5"] };
      const { result, lineage } = lemonadeGridResult({ recordKeys });
      stores.app.actions.setResults(id, result, lineage);
      stores.app.actions.clickRow(id, 1, { shift: false, ctrl: false });
      stores.app.actions.clickRow(id, 2, { shift: false, ctrl: true });
    },
    render: () => <QueryResults tabId={LEMONADE.id} />,
  },
  // The same, with a track on every row, for a test to swipe right: the band
  // opens at the left, naming the queue.
  "results/row-swipe-right": {
    width: 800,
    height: 200,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openLemonade(stores);
      const { result, lineage } = lemonadeGridResult({
        trackIds: GRID_TRACK_IDS,
      });
      stores.app.actions.setResults(id, result, lineage);
      stores.app.actions.clickRow(id, 1, { shift: false, ctrl: false });
      stores.app.actions.clickRow(id, 2, { shift: false, ctrl: true });
    },
    render: () => <QueryResults tabId={LEMONADE.id} />,
  },
  // The rows for a test to pull down from the top, opening the gap the spinner
  // sits in.
  "results/pull-refresh": {
    width: 800,
    height: 200,
    frame: "flex flex-col",
    setup: (stores) => {
      const id = openLemonade(stores);
      const { result, lineage } = lemonadeGridResult();
      stores.app.actions.setResults(id, result, lineage);
    },
    render: () => <QueryResults tabId={LEMONADE.id} />,
  },
  // A row's context menu: one entry per table whose primary key the row
  // carries, the submenus leading on to related records, and the entry that
  // turns multi-select mode on.
  "result-row/context-menu": rowActionsMenu(),
  // A row's context menu on a playlist's page: "Edit track" (never the entry
  // itself), and "Remove from playlist" before the track's "Artists" and
  // "Album".
  "result-row/playlist-context-menu": rowActionsMenu({
    records: [trackRecord(1)],
    playlist: true,
  }),
  // A row's context menu while other tracks are queued, its own among them:
  // "Queue track next", "Queue after 2 queued tracks", "Remove from queue".
  "result-row/queue-context-menu": rowActionsMenu({ queued: [1, 0, 2] }),
  // Its "Rate track" submenu, opened out (the test does the opening): one entry
  // per record of the `rating` table, lowest value first.
  "result-row/rate-submenu": rowActionsMenu(),
  // The same submenu before its query has come back — what a menu raised in the
  // first moments of a session shows.
  "result-row/rate-submenu-loading": rowActionsMenu({ ratingsLoading: true }),
  // A track's "Artists" submenu, opened out: the two credited on the fixture's
  // third track, lead first.
  "result-row/artists-submenu": rowActionsMenu({
    records: [trackRecord(3)],
  }),
  // The same submenu while its credits are still loading.
  "result-row/artists-submenu-loading": rowActionsMenu({
    records: [trackRecord(3)],
    lookupDelay: 60_000,
  }),
  // One artist in it, opened out: the entries an artist's own row offers.
  "result-row/artist-submenu": rowActionsMenu({ records: [trackRecord(3)] }),
  // A track's "Album" submenu, opened out: the entries an album's own row
  // offers, for the album the track is on.
  "result-row/album-submenu": rowActionsMenu({ records: [trackRecord(3)] }),
  // An artist row's own context menu.
  "result-row/artist-context-menu": rowActionsMenu({
    records: [idRecord("artist", "artist-1")],
  }),
  // "Add to playlist…" for three tracks: the sources tree with only its
  // playlists. "Favorites" is open and holds a nested, open "Road trip"; the
  // closed "Parties" holds one more. The query Lemonade, and both "Archive"
  // (empty) and "Queries" (only a query in it), are left out.
  "add-to-playlist/modal": {
    setup: (stores) => {
      const [lemonade, deepCuts] = SOURCES_FIXTURE;
      const playlist = (n: number, name: string, parent: string | null) => ({
        ...PLAYLIST_SOURCE,
        id: `00000000-0000-0000-0000-00000000000${n}`,
        playlistId: `00000000-0000-0000-0000-0000000000d${n}`,
        name,
        parent,
        position: n,
      });
      stores.app.store.setState((s) => {
        s.folders.data = [
          { id: FAVORITES, name: "Favorites", parent: null, position: 0 },
          { id: ROAD_TRIP, name: "Road trip", parent: FAVORITES, position: 1 },
          { id: ARCHIVE, name: "Archive", parent: null, position: 2 },
          { id: QUERIES, name: "Queries", parent: null, position: 3 },
          { id: PARTIES, name: "Parties", parent: null, position: 4 },
        ];
        s.sources.data = [
          { ...lemonade, parent: FAVORITES, position: 0 },
          playlist(4, "Coast drive", ROAD_TRIP),
          playlist(5, "Desert night", ROAD_TRIP),
          playlist(6, "Sunday morning", FAVORITES),
          { ...deepCuts, parent: QUERIES, position: 0 },
          playlist(7, "Birthday", PARTIES),
          playlist(8, "Late night", null),
        ];
      });
      stores.app.actions.toggleFolderExpanded(FAVORITES);
      stores.app.actions.toggleFolderExpanded(ROAD_TRIP);
      stores.app.store.setState((s) => {
        s.pendingAddToPlaylist = {
          fromTabId: lemonade.id,
          trackIds: ["t1", "t2", "t3"],
        };
      });
    },
    render: () => <AddToPlaylistModal />,
  },

  // ── The record editor ────────────────────────────────────────────────────
  // As the form lands: every field of `track`, values and counts loaded,
  // everything collapsed.
  "record-editor/items-collapsed": recordEditor([1]),
  // …and opened out (the test does the opening): a long text field expanded
  // below its label, a multi-record field listing its records, and one of those
  // expanded into its own form.
  "record-editor/items-expanded": recordEditor([3]),
  // Mid-edit: an edited field and a record being created under `credit`, each
  // starred. On track 5, whose title is short — track 3's is the long one the
  // expansion story is about, and this story wants a plain single-line edit.
  "record-editor/modified": recordEditor([5]),
  // A save the database refused: what it said, above a form still holding the
  // change it couldn't write.
  "record-editor/save-error": recordEditor(
    [1],
    'Duplicate key "title: Sorry" violates unique constraint.',
  ),
  // Two records at once: the fields they agree on (`disc_number`) editable as
  // ever, the ones they don't showing how many values they hold between them —
  // openable, though nothing here opens them — instead of one value, the
  // `credit` count they happen to share drawn as one bubble, and the `play` and
  // `track_tag` counts they don't drawn as the range between two.
  "record-editor/bulk": recordEditor([3, 5]),
  // …and a multi-record field opened out on those same two tracks (the test
  // does the opening). Both are credited to Beyoncé at order 1, which is one
  // row standing for two records — the (2) beside it — over the one credit each
  // track holds alone.
  "record-editor/bulk-expanded": recordEditor([3, 5]),
  // Three records at once, with two of the fields they disagree on opened out
  // (the test does the opening): every value they hold, commonest first, with
  // how many records hold it and the paint roller that gives it to the rest.
  // `title` is three values of its own; `rating` is a link, so its values are
  // the records they point at — two tracks rated 4 and one rated 3.5 — and one
  // of those is opened into its own form, the way a field they agreed on would
  // open into the single record it points at.
  "record-editor/varied-expanded": recordEditor([1, 2, 3]),
  // …and those values edited where they stand (the test does the opening and
  // the editing): `title`'s long value expanded below its row, wrapped and
  // keeping its linebreak, and "Hold Up" in an open editor — an edit to the
  // one record holding it.
  "record-editor/varied-editing": recordEditor([1, 2, 3]),
  // A value in edit mode with autocomplete on (the test does the opening): the
  // chevron in its box, and the titles `track` holds below it.
  "record-editor/autocomplete": recordEditor([5]),
  // The same list with enough values to page through, on its text box alone.
  "value-autocomplete/paged": {
    width: 340,
    height: 420,
    frame: "flex items-start",
    render: () => <PagedAutocomplete />,
  },
  // A contextual query on tracks, opened out with its editor showing (the test
  // does the opening): the query's label in its own color, the count of what it
  // found, the editor's toolbar over its filter, and the record it found.
  "record-editor/contextual-query": withContextualQueries(recordEditor([3]), [
    FEATURED_QUERY,
  ]),
  // A contextual query being added (the test does the adding): the new field at
  // the bottom, its default name selected to be typed over, and the Base
  // selector beside it with no table chosen.
  "record-editor/provisional-query": withContextualQueries(
    recordEditor([5]),
    [],
  ),
  // The user's own arrangement of `track`: `title` moved up to the top, and
  // `disc_number` and the credits hidden but on show, their labels dimmed.
  "record-editor/fields-customized": withFieldMetadata(recordEditor([1]), [
    [{ columnName: "id" }, { ...defaultFieldMetadata(), order: 2 }],
    [{ columnName: "title" }, { ...defaultFieldMetadata(), order: 1 }],
    [
      { columnName: "disc_number" },
      { ...defaultFieldMetadata(), visible: false },
    ],
    [
      { multiLink: { relatedTableName: "credit", fkColumnName: "track" } },
      { ...defaultFieldMetadata(), visible: false },
    ],
  ]),
  // The Querydown behind a scalar linked record's embedded record, being edited
  // (the test opens the editor from the field's menu).
  "record-editor/embed-display": recordEditor([1]),
  // A multi-record field's display and sorting both being edited, above the
  // records they're about.
  "record-editor/embed-sorting": recordEditor([3]),
  // A problem in that Querydown, which the editor says under it.
  "record-editor/embed-problem": recordEditor([1]),
  // `title` being dragged (the test does the dragging): dimmed where it is, its
  // chip following the pointer, and the drop line in the gap it would land in.
  "record-editor/field-drag": recordEditor([1]),
  // The modal record picker on its own: the search box with its sort and
  // display buttons, the results as the embedded records they're about to
  // become, and the "New record" way out. `initialSort`/`initialDisplay` are
  // hard-coded to what `embedSpec` picks for `artist` (see
  // `query/embeddedRecord.test.ts`) — deriving them here would make this story
  // about the generator rather than about the picker.
  "record-picker/basic": {
    render: () => (
      <RecordPicker
        table="artist"
        keyColumn="id"
        initialSort="\\\\name \\\\id"
        initialDisplay="$name"
        runQuery={(q) =>
          Promise.resolve({ rows: fixtureQuery(q), columns: [] })
        }
        onPick={() => {}}
        onCancel={() => {}}
        onCreate={() => {}}
      />
    ),
  },

  // ── Embedded records ─────────────────────────────────────────────────────
  // One preview widget, from cells alone: a selected member of a multi-record
  // field, wearing the results grid's selected-row fill under its sheen.
  "embedded-record/selected": {
    width: 320,
    // The widget takes the whole width of the row it's given, and sizes itself
    // from it.
    frame: "flex p-2",
    render: () => <EmbeddedRecord cells={["Beyoncé"]} focusable selected />,
  },
  // Every annotation a result column reads, on an embedded record's columns: a
  // hidden one, fixed widths that wrap, alignment, a light small one, and text
  // reshaped by a prefix, a suffix and two formatters.
  "embedded-record/annotated": {
    width: 320,
    frame: "flex p-2",
    render: () => (
      <EmbeddedRecord
        cells={["hidden-id", "Beyoncé", "3.14159", "00:03:42", "12", "lead"]}
        columns={ANNOTATED_EMBED_COLUMNS}
        focusable
      />
    ),
  },
  // A `relativeTime` cell, which keeps counting while nothing else changes.
  "embedded-record/relative-time": {
    width: 320,
    frame: "flex p-2",
    render: () => (
      <EmbeddedRecord
        cells={["2020-01-01 00:00:00"]}
        columns={[
          columnMetadataFromAnnotation({
            formatter: { type: "relativeTime", units: ["minutes"] },
          }),
        ]}
      />
    ),
  },

  // ── Menus, on their own ──────────────────────────────────────────────────
  // The menu system's behavior, with filler rows: `menu.spec.ts` drives these
  // with the pointer and the keyboard rather than shooting them.
  "menu/nested": {
    width: 520,
    height: 300,
    frame: "p-4",
    render: () => (
      <Menu defaultOpen width="160px" trigger={() => null}>
        <NestedMenuBody />
      </Menu>
    ),
  },
  // A context menu raised in the viewport's bottom-right corner, where the
  // menu and every submenu have to pull back inside the edges.
  "menu/context-corner": {
    render: () => (
      <ContextMenu x={1275} y={895} onClose={() => {}}>
        <NestedMenuBody />
      </ContextMenu>
    ),
  },
  // Every column a menu row can fill — checkbox or radio, icon, label,
  // shortcut, submenu chevron — with rows that leave some out, so the snapshot
  // shows each kind of part lining up down the panel whichever rows have one.
  "menu/columns": {
    width: 420,
    height: 340,
    frame: "p-4",
    render: () => (
      <Menu defaultOpen trigger={() => null}>
        <MenuItem icon={Icons.Query} label="New query" command="query.new" />
        <MenuItem
          icon={Icons.ExplorerOpen}
          label="Toggle explorer"
          command="explorer.toggle"
        />
        <MenuItem label="No icon" />
        <MenuSeparator />
        <MenuToggleItem
          kind="checkbox"
          icon={Icons.Filter}
          label="Checked, with icon"
          checked
        />
        <MenuToggleItem
          kind="checkbox"
          label="Unchecked, no icon"
          command="palette.open"
          checked={false}
        />
        <MenuToggleItem
          kind="radio"
          icon={Icons.Querydown}
          label="Radio"
          checked
        />
        <MenuSeparator />
        <MenuSubmenu icon={Icons.Base} label="Submenu">
          <MenuItem label="Inside" />
        </MenuSubmenu>
        <MenuItem icon={Icons.Delete} label="Delete" danger />
      </Menu>
    ),
  },
  // A context menu low on the screen and right of center, with a submenu
  // ("Late") whose rows load after it opens. Its "Loading…" row fits beside
  // the menu, to its right; the dozen wide rows that replace it don't fit
  // there, nor below.
  "menu/late-rows": {
    render: () => (
      <ContextMenu x={760} y={780} width="160px" onClose={() => {}}>
        <MenuItem label="Alpha" />
        <MenuSubmenu label="Late">
          <LateRows />
        </MenuSubmenu>
      </ContextMenu>
    ),
  },
  // A dropdown whose trigger sits in the bottom-right corner: it asks to drop
  // below and left-aligned, and has room for neither.
  "menu/dropdown-corner": {
    render: () => (
      <div className="fixed right-2 bottom-2">
        <Menu
          width="160px"
          trigger={(api) => (
            <button type="button" onClick={() => api.toggle()}>
              Open
            </button>
          )}
        >
          <NestedMenuBody />
        </Menu>
      </div>
    ),
  },
};
