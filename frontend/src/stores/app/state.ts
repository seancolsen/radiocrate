import type {
  DmlOperation,
  DmlResult,
  Preset,
  Query,
  QueryFolder,
} from "api-client";
import type { AudioQualityPref } from "../../audio/engine";
import type { TreeItemRef } from "../../query/explorerTree";
import type { LineageMapping } from "../../query/lineage";
import type { QueryDefinition, Section } from "../../query/definition";
import type { Rating } from "../../query/ratings";
import type { QueryResult } from "../../query/result";
import type { SchemaTable } from "../../query/schema";
import type { SettingKey, SettingOverrides } from "../../state/settings";
import type { AppEnv } from "../env";
import {
  storedAudioQuality,
  storedExpandedFolders,
  storedRecordSidebarWidth,
  storedSidebarOpen,
  storedTabs,
  storedTheme,
} from "./persistence";
import type { ThemePref } from "./theme";

export type { ThemePref };
export type { AudioQualityPref };

/** An in-progress, uncommitted edit of a saved preset's fields. Keyed by preset
 * id in `presetEdits`; persists across collapse / tab navigation. This session
 * it commits only to local state. */
export interface PresetEdit {
  name: string;
  definition: string;
  isDefault: boolean;
}

/** The "Save as preset" naming-dialog state. */
export interface PresetSave {
  section: Section;
  definition: string;
  name: string;
  isDefault: boolean;
}

/** A fixed sentinel id for the singleton Keyboard Shortcuts tab, so it flows
 * through the same id-keyed tab machinery (select / close / reorder) as
 * queries. Namespaced so it can't collide with a query id. */
export const SHORTCUTS_TAB_ID = "settings:keyboard-shortcuts";

/** The Keyboard Shortcuts tab's handle text — its "name", so every generic tab
 * surface (the tab bar, the explorer's "Opened" list) reads one field. */
export const SHORTCUTS_TAB_NAME = "Keyboard Shortcuts";

/** An open query tab. Tab id == query id. Carries both the saved query
 * definition and an independent working (`live`) copy the builder mutates; the
 * two diverging is what shows the unsaved-changes indicator.
 *
 * `persisted` is false for an ephemeral query — a never-saved tab (e.g. a
 * Duplicate) that exists only in this session until Save writes it to the
 * backend. An ephemeral tab always reads as unsaved. */
export interface QueryTab {
  kind: "query";
  id: string;
  name: string;
  saved: QueryDefinition;
  live: QueryDefinition;
  persisted: boolean;
}

/** The keyboard-shortcuts editor tab. There is at most one, and its transient UI
 * state (search text, record mode, the capture dialog) lives in the command
 * store — so the tab itself carries no data beyond its identity. */
export interface ShortcutsTab {
  kind: "shortcuts";
  id: typeof SHORTCUTS_TAB_ID;
  name: string;
}

/** An open tab: a query page or the singleton keyboard-shortcuts editor. More
 * page kinds (playlists, artists, …) slot in here as further variants — the tab
 * bar, the explorer's "Opened" list and the tab commands all work off the shared
 * `kind` / `id` / `name` fields, and only {@link queryTab} narrows to the
 * query-only state. */
export type Tab = QueryTab | ShortcutsTab;

/** Which kind of page a tab holds — the discriminant every kind-aware surface
 * switches on. */
export type TabKind = Tab["kind"];

/** The track shown in the now-playing bar, and where it came from. */
export interface CurrentTrack {
  /** The tab whose results this track was played from (results are per-tab).
   * "Locate" jumps back here; `null` once that tab has been closed. */
  sourceTabId: string | null;
  id: string;
  /** The track's row within that tab's results, when it can be found — re-derived
   * after an auto-advance or a re-run. `null` disables "Locate". */
  rowIndex: number | null;
  /** Filled in asynchronously by the metadata fetch (null until it lands). */
  title: string | null;
  artists: string[];
}

/** Live transport state, mirrored out of the audio engine on its events so the
 * bar can render it. The engine remains the source of truth. */
export interface PlaybackState {
  playing: boolean;
  position: number;
  /** Seconds, or `null` before the stream's metadata has loaded. */
  duration: number | null;
  /** Whether anything is queued after the current track ("Next" enabled). */
  hasNext: boolean;
}

/** A request to bring a result row into view (the "Locate" action). Carried as a
 * seq-stamped state slot rather than a one-shot signal: it's an event, and
 * `seq` makes two locates of the *same* row still register as two events; a
 * late mounter can still read the pending value. */
export interface RowReveal {
  tabId: string;
  row: number;
  seq: number;
}

/** Notice that one result row's cells have just been rewritten in place — the
 * re-read that follows a DML write (see `query/rowDml.ts`). Carried the same
 * way as {@link RowReveal}: the results grid consumes it (the result object
 * itself doesn't change, precisely so that the grid *doesn't* treat this as a
 * new result set). */
export interface RowPatch {
  tabId: string;
  row: number;
  seq: number;
}

/** A one-shot request to open a builder section *and* put the caret in its
 * custom input — what the `query.focus_*` commands do. Carried the same way as
 * {@link RowReveal}: the builder that owns the section consumes it. */
export interface BuilderFocus {
  tabId: string;
  section: Section;
  seq: number;
}

/** One record identified by a result row: the table plus a fully-resolved key.
 * What the context menu offers and the record editor opens. */
export interface RecordRef {
  table: string;
  /** The identifying column/value pairs, in constraint order. */
  key: readonly { column: string; value: string }[];
}

/** What's open in a tab's record-editor sidebar: the table being edited and the
 * records the current result-row selection identifies for it. A single entry is
 * the ordinary case; more than one is the multi-row "bulk" case, which the form
 * edits as one (see `record/formValues.ts`). The sidebar stays open and resyncs
 * to the selection as it changes (the "Dynamic updates" behavior). */
export interface RecordEditorTarget {
  table: string;
  records: readonly RecordRef[];
}

/** The status of a boot-time load. `"loading"` covers both "hasn't started" and
 * "in flight" — nothing in this app distinguishes them. */
export type ResourceStatus = "loading" | "ready" | "error";

/** A value loaded once at boot, plus whether that load has landed. `data`
 * carries a sensible empty default so a consumer never has to branch on
 * `undefined` before the load finishes. */
export interface ResourceState<T> {
  status: ResourceStatus;
  data: T;
}

/** The enriched introspection schema: the raw JSON (as fetched, or as a dev/test
 * seam installs it directly — see `setSchemaJson`) and the tables parsed out of
 * it, computed together so no consumer needs its own memo (mapping table:
 * "computed at write time"). `json` is `undefined` until something has been
 * installed, which is what {@link import("./selectors").selectSchemaReady} tests
 * — independently of `status`, so a dev/test override reads as ready even if the
 * real fetch is still in flight or failed. */
export interface SchemaState {
  status: ResourceStatus;
  json: string | undefined;
  tables: readonly SchemaTable[];
}

/** A failed RPC call, as the error bar shows it: which method failed, with what
 * message, and how many times in a row that same failure has happened. */
export interface RpcErrorNotice {
  method: string;
  message: string;
  count: number;
}

/** Everything a query tab's page holds beyond the tab itself: its results and
 * how the user is looking at them. */
export interface QueryPageState {
  /** The decoded, render-ready result (absent until a run lands). */
  result?: QueryResult;
  /** Whether the result now in `result` is a *refresh* of the one before it —
   * a re-run that compiled to the very same SQL (the Refresh button; a revert
   * or preset edit that changed nothing), as against the rows of a query the
   * user has just changed.
   *
   * A refresh leaves the row selection, the record editor standing on it and
   * the results' scroll position alone: same query, same rows, same place in
   * them. Anything else is a new set of rows, and all three are reset. The flag
   * is what tells the grid which of the two swaps it's being handed, so it's
   * read the moment the swap is observed rather than rendered. */
  resultIsRefresh: boolean;
  /** Where the results pane was scrolled to, in logical px — kept so switching
   * tabs and coming back lands where the user left off. A hidden page tears
   * its `CanvasGrid` down (its effects are cleaned up; see `TabContent`), so
   * this is the handoff: the pane writes the live offset here as the tab is
   * hidden, and restores it as it's shown again. It isn't live while the tab
   * is on screen (the grid owns the offset there), and a new result set puts
   * it back to the top. */
  scrollOffset: number;
  /** The result-row selection: a set of row indexes (absent = none). Replaced
   * wholesale on every change so subscribers observe a new reference; cleared
   * when the result changes. Treated as opaque by Immer: a `Set` is always
   * swapped in whole, never mutated through a draft, so no `enableMapSet()`
   * plugin is needed. */
  selection?: ReadonlySet<number>;
  /** Whether the results pane is in multi-select mode: the floating
   * multi-select toolbar is up, and a plain click toggles a row in or out of
   * the selection rather than replacing it (what a touch device has instead of
   * Ctrl+click). Turning it off leaves the selection as it stands; a new result
   * set turns it off along with clearing the selection. */
  multiSelect: boolean;
  /** The lineage mapping: which output column (if any) carries `track.id`
   * (drives double-click-to-play) and which tables the rows carry a full
   * primary key for (drives the results context menu's "Edit {table}"
   * entries). A positional mapping into `result`, not a snapshot of row data —
   * absent while the analysis hasn't landed (or found nothing), same as an
   * empty mapping. */
  lineage?: LineageMapping;
  /** The record(s) open in the record-editor sidebar (`null` when it's closed).
   * Per tab — the sidebar belongs to the query page. It's also what keeps the
   * form alive: the forms store holds the form this names for as long as it
   * names it (`FormsActions.retain`). */
  recordEditor: RecordEditorTarget | null;
  /** Whether a run is in flight. */
  running: boolean;
  /** The open builder section (null = builder closed). */
  builderSection: Section | null;
  /** Whether the whole-query Querydown editor is open. Kept apart from
   * `builderSection` because it belongs to the other mode: a full-mode query
   * has no sections to open, and a query converted back to sections finds its
   * section state where it left it. */
  fullEditorOpen: boolean;
  /** The expanded preset id (null = none expanded). */
  expandedPreset: string | null;
}

/** A page with nothing in it yet — what a tab's first page write starts from. */
export function emptyPage(): QueryPageState {
  return {
    resultIsRefresh: false,
    scrollOffset: 0,
    multiSelect: false,
    recordEditor: null,
    running: false,
    builderSection: null,
    fullEditorOpen: false,
    expandedPreset: null,
  };
}

export interface AppState {
  sidebarOpen: boolean; // explorer open/closed (persisted, like theme)
  theme: ThemePref; // light/dark/system (persisted), drives the `data-theme` attribute
  tabs: Tab[]; // open tabs, in tab-bar order
  activeTabId: string | null;
  queryFilter: string; // "Filter" input text in the Queries section
  /** Whether the Queries section's filter input is shown. Hiding it clears
   * `queryFilter`, so a filter is never in force out of sight. */
  queryFilterOpen: boolean;
  /** The explorer folders showing their contents (persisted). Replaced
   * wholesale on every change, like a page's `selection`. */
  expandedFolders: ReadonlySet<string>;
  /** The explorer item (folder or saved query) whose name is being edited in
   * place, if any. */
  renamingTreeItem: TreeItemRef | null;
  /** Each query tab's page state, keyed by tab id. An entry is created by the
   * first write for its tab and dropped whole when the tab closes. */
  pages: Record<string, QueryPageState>;
  /** Whether the initial `preset.list` load has landed. */
  presetsStatus: ResourceStatus;
  /** Saved query-section presets — a mutable copy of `preset.list` so local
   * "Save as preset" / inline edits can add and update entries this session. */
  presets: Preset[];
  /** In-progress preset edits, keyed by preset id. */
  presetEdits: Record<string, PresetEdit>;
  /** The "Save as preset" dialog, when open. */
  presetSave: PresetSave | null;
  /** The compiled SQL shown by the "View SQL" dialog, when open. */
  viewSql: string | null;
  /** The in-progress inline rename (tab handle field), when active. */
  renaming: { id: string; buffer: string } | null;
  /** The query pending delete confirmation (modal), when open. */
  pendingDelete: { id: string; name: string; unsaved: boolean } | null;
  /** Whether the About dialog (versions + the update actions) is open. */
  aboutOpen: boolean;
  /** The setting whose editor dialog is open (null when none is). */
  settingEditor: SettingKey | null;
  /** Whether a `collection.rescan` call is in flight. One at a time, and only
   * from the Settings menu's "Re-scan collection" — which stays open, with the
   * row disabled and spinning, for as long as this is true. */
  rescanning: boolean;
  /** The failed RPC call the error bar shows (null when there's none, or it was
   * dismissed). */
  rpcError: RpcErrorNotice | null;
  /** The track in the now-playing bar (null when nothing is loaded). */
  currentTrack: CurrentTrack | null;
  /** Transport state for that track. */
  playback: PlaybackState;
  /** The saved-query list (loads via `query.list`; `refetchQueries` reloads). */
  queries: ResourceState<readonly Query[]>;
  /** The explorer's query folders (loads via `folder.list`, alongside
   * `queries` — the two lists make up one tree; see `query/explorerTree.ts`). */
  folders: ResourceState<readonly QueryFolder[]>;
  /** The rating vocabulary the results row menu offers (the whole `rating`
   * table, lowest value first). Loaded on demand — the first time a menu that
   * offers it is raised — rather than at boot: it needs the schema the
   * Querydown query compiles against, and a session that never rates anything
   * never asks for it. */
  ratings: ResourceState<readonly Rating[]>;
  /** The enriched introspection schema (loads via one `runSqlScalar`). */
  schema: SchemaState;
  /** The user-customized settings, loaded once via `setting.list`. A missing
   * key reads as that setting's default (see `state/settings.ts`). */
  settingOverrides: SettingOverrides;
  /** The audio-streaming quality preference (persisted, like theme). */
  audioQuality: AudioQualityPref;
  /** The record-editor sidebar's width in CSS px — app-level (shared by every
   * query page) and persisted, like the explorer's open state. */
  recordSidebarWidth: number;
  /** The pending "this row's cells were rewritten" notice, consumed by the
   * results grid (which repaints). `undefined` when there is none. */
  rowPatch: RowPatch | undefined;
  /** The pending "scroll this row into view" request, consumed by the results
   * grid. `undefined` when there is none. */
  rowReveal: RowReveal | undefined;
  /** The `query.focus_*` commands hand the open builder a "take the caret"
   * request through this slot; the builder clears it once applied. */
  builderFocus: BuilderFocus | undefined;
}

/** A shared frozen empty set for tabs with no selection, so a selector returns a
 * stable reference (no per-call allocation, no spurious re-renders). */
export const EMPTY_SELECTION: ReadonlySet<number> = new Set<number>();

/** The open tabs a previous visit left (see `storedTabs`), as tabs: the
 * shortcuts editor gets its fixed id and name back, and an active id that names
 * no restored tab falls back to the first one. A restored query tab has no page
 * yet; its query runs again when it's first viewed. */
function restoredTabs(env: AppEnv): {
  tabs: Tab[];
  activeTabId: string | null;
} {
  const stored = storedTabs(env);
  const tabs = stored.tabs.map((t): Tab =>
    t.kind === "shortcuts"
      ? { kind: "shortcuts", id: SHORTCUTS_TAB_ID, name: SHORTCUTS_TAB_NAME }
      : { ...t },
  );
  const activeTabId = tabs.some((t) => t.id === stored.activeTabId)
    ? stored.activeTabId
    : (tabs[0]?.id ?? null);
  return { tabs, activeTabId };
}

export function initialState(env: AppEnv): AppState {
  const { tabs, activeTabId } = restoredTabs(env);
  return {
    sidebarOpen: storedSidebarOpen(env),
    theme: storedTheme(env),
    tabs,
    activeTabId,
    queryFilter: "",
    queryFilterOpen: false,
    expandedFolders: storedExpandedFolders(env),
    renamingTreeItem: null,
    pages: {},
    presetsStatus: "loading",
    presets: [],
    presetEdits: {},
    presetSave: null,
    viewSql: null,
    renaming: null,
    pendingDelete: null,
    aboutOpen: false,
    settingEditor: null,
    rescanning: false,
    rpcError: null,
    currentTrack: null,
    playback: { playing: false, position: 0, duration: null, hasNext: false },
    queries: { status: "loading", data: [] },
    folders: { status: "loading", data: [] },
    ratings: { status: "loading", data: [] },
    schema: { status: "loading", json: undefined, tables: [] },
    settingOverrides: {},
    audioQuality: storedAudioQuality(env),
    recordSidebarWidth: storedRecordSidebarWidth(env),
    rowPatch: undefined,
    rowReveal: undefined,
    builderFocus: undefined,
  };
}

// Re-exported so `stores/app/actions.ts` and its tests don't have to reach into
// `api-client` themselves just to name these DML types.
export type { DmlOperation, DmlResult, Preset, Query, QueryFolder };
// …and so the menu surfaces can name a rating through the store, as they name
// every other thing they render.
export type { Rating };
