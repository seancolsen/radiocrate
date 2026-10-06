import * as arrow from "apache-arrow";
import { castDraft, produce, type Draft } from "immer";
import { shallow } from "zustand/vanilla/shallow";
import {
  folderAdd,
  folderDelete,
  folderList,
  folderRename,
  presetAdd,
  presetList,
  presetUpdate,
  queryAdd,
  sourceArrange,
  queryDelete,
  sourceList,
  sourceRecordPlay,
  sourceRename,
  sourceUpdateDefinition,
  collectionRescan,
  settingDelete,
  settingList,
  settingSet,
  type DmlOperation,
  type DmlResult,
  type Placement,
  type Preset,
  type Source,
  type SourceKind,
} from "api-client";
import { IdleQueue } from "../../api/idleQueue";
import { fetchPlaylistEntries, sendPlaylistWrites } from "../../api/playlist";
import { WriteQueue } from "../../api/writeQueue";
import { runSql, runSqlScalar } from "../../api/query";
import { fetchTrackMetadata, playInsert, ratingUpdates } from "../../api/track";
import { AudioEngine, type AudioQualityPref } from "../../audio/engine";
import {
  addInferredLinks,
  INTROSPECTION_SQL,
  parseSchemaTables,
} from "../../query/schema";
import { compilePlaylist, compileSavedQuery } from "../../query/compile";
import { overridesFromEntries, withSetting } from "../../state/settings";
import type { SettingKey } from "../../state/settings";
import {
  checkpoint as checkpointHistory,
  EMPTY_HISTORY,
  pushStep,
  stepBack,
  stepForward,
  stepToUndo,
  stepToRedo,
  type UndoHistory,
  type UndoStep,
} from "../../state/undoHistory";
import {
  createPlaylistWrites,
  deletePlaylistWrites,
  sequentialPositions,
  type EntryWrites,
  type PlaylistEntry,
} from "../../query/playlistEntries";
import {
  isQueryDefinition,
  newPlaylistDefinition,
  pageDefinitionToStored,
  pageDefsEqual,
  playlistDefinitionFromQuery,
  playlistDefinitionFromStored,
  playlistDefinitionToStored,
  type PageDefinition,
  type PlaylistDefinition,
  type Sections,
} from "../../query/playlist";
import {
  cloneDefinition,
  definitionForBase,
  definitionFromStored,
  definitionToStored,
  rebasedDefinition,
  shuffleContent,
  toFullQuery,
  type QueryDefinition,
  type Section,
  type SectionContent,
} from "../../query/definition";
import { querydownReady } from "../../query/querydown";
import { fetchRatings } from "../../query/ratings";
import { childRecordsTabQuery, embedSpec } from "../../query/embeddedRecord";
import { buildFormFields, type RecordQuery } from "../../query/recordForm";
import {
  analyzeColumnSources,
  recordKeyColumns,
  trackIdColumn,
  type LineageMapping,
} from "../../query/lineage";
import { buildResultFromArrow, type QueryResult } from "../../query/result";
import { runRowDml } from "../../query/rowDml";
import {
  applyPlacements,
  buildTree,
  dissolvePlacements,
  movePlacements,
  storedPositions,
  topPosition,
  type DropTarget,
  type TreeItemRef,
} from "../../query/explorerTree";
import type { AppEnv } from "../env";
import { applyThemeToDocument, watchSystemTheme } from "./theme";
import {
  clampRecordSidebarWidth,
  persistAudioQuality,
  persistExpandedFolders,
  persistRecordSidebarWidth,
  persistSidebar,
  persistTabs,
  persistTheme,
} from "./persistence";
import {
  selectEffectivePresets,
  selectCanConvertToPlaylist,
  selectCanRedo,
  selectIsUnsaved,
  selectIsPersisted,
  selectIsWriting,
  selectLocateRow,
  selectQueueAround,
  selectPageBase,
  selectPageTab,
  selectPrelude,
  selectQueryTab,
  selectRowContext,
  selectRowForRecord,
  selectRowRecords,
  selectTab,
  selectTrackIdAt,
  sameRecord,
} from "./selectors";
import {
  EMPTY_SELECTION,
  SHORTCUTS_TAB_ID,
  SHORTCUTS_TAB_NAME,
  emptyPage,
  type AppState,
  type CurrentTrack,
  type PageTab,
  type PresetEdit,
  type PresetSave,
  type QueryTab,
  type RecordRef,
  type ThemePref,
} from "./state";
import type { AppVanillaStore } from "./vanillaStore";

function newUuid(): string {
  return crypto.randomUUID();
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

/** Local wall-clock formatted `YYYY-MM-DD HH:MM` — the default name for a newly
 * created query. */
function nowName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** A one-row `List<Utf8>` vector holding `items` — `setResultRow`'s (dev/test
 * seam) way of patching a list column. Built explicitly rather than through
 * `arrow.vectorFromArray`'s own list inference, which throws for a single-row
 * `Utf8` list: its dictionary-encoded child type fails its own
 * self-comparison (`compareTypes` on two independently-constructed
 * `Dictionary`s). */
function oneRowListVector(items: readonly string[]): arrow.Vector {
  const type = new arrow.List(
    arrow.Field.new({ name: "item", type: new arrow.Utf8(), nullable: true }),
  );
  const b = arrow.makeBuilder({ type, nullValues: [null] });
  b.append(items as unknown as arrow.Vector<arrow.Utf8>);
  return b.finish().toVector();
}

/** Trailing debounce applied to the query re-run that follows a text edit in
 * the builder, so a run fires once the user pauses rather than on every
 * keystroke. */
const RUN_DEBOUNCE_MS = 300;

/** How long the app has to have been idle — no request to the backend, and no
 * edit to the query — before a saved query's edits are written (see
 * `api/idleQueue.ts`). */
const AUTOSAVE_IDLE_MS = 5000;

/** RPC methods whose failures never reach the error bar. `app.version` is the
 * update controller's background poll, which handles its own failures: a server
 * that's briefly unreachable shouldn't raise a bar. */
const UNREPORTED_METHODS: ReadonlySet<string> = new Set(["app.version"]);

/** Every write method the app store exposes. Reads live in `selectors.ts`
 * instead (state management rule 1): actions are stable references, so a
 * component can put them in an effect's dependency array without churn. */
/** A step of writes to a playlist's entries, as {@link AppActions.writeStep}'s
 * caller works it out: the writes, and an edit of the page's working definition
 * that's part of the same step ("Remove these tracks" clears the filter). The
 * edit is applied to the definition as it stands when the writes land. */
export interface PreparedStep {
  writes: EntryWrites;
  edit?: (def: Sections) => void;
}

export interface AppActions {
  // Boot loads. `createStores()` runs these once; unit tests call them
  // directly.
  loadSources: () => Promise<void>;
  loadPresets: () => Promise<void>;
  loadSchema: () => Promise<void>;
  loadSettings: () => Promise<void>;
  /** Re-runs `loadSources` and `loadPresets` — the Explorer's manual refresh. */
  refetchSources: () => void;

  /** Loads the rating vocabulary (the whole `rating` table), unless it's
   * already loaded or in flight. Not a boot load: it compiles a Querydown
   * query, so it needs the schema, and it's wanted only once a menu offering
   * ratings is raised — which is where it's called from. A load that couldn't
   * run (no schema yet) or that failed leaves the next raise to try again. */
  loadRatings: () => void;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  /** Sets the theme override ("system" clears it) — the Settings menu's action. */
  setTheme: (pref: ThemePref) => void;
  /** Sets the audio-streaming quality preference — the Settings menu's action. */
  setAudioQuality: (pref: AudioQualityPref) => void;
  /** Open (or focus) a saved source in a tab: a query tab, or a playlist tab
   * for a playlist (`kind: "playlist"` with its `playlistId`). */
  openTab: (source: {
    id: string;
    name: string;
    definition: string;
    kind?: SourceKind;
    playlistId?: string | null;
  }) => void;
  /** Open (or focus) the singleton Keyboard Shortcuts tab — the
   * `shortcuts.configure` command's and the Settings menu's action. */
  openShortcutsTab: () => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  reorderTab: (id: string, toIndex: number) => void;
  setSourceFilter: (text: string) => void;
  /** Show or hide the Sources filter input. Hiding it clears the filter. */
  toggleSourceFilter: () => void;
  /** Show or hide explorer folder `id`'s contents. */
  toggleFolderExpanded: (id: string) => void;
  /** Create a folder at the top of the Sources tree (expanded, being empty)
   * and start renaming it. */
  newFolder: () => void;
  /** Open a new, unsaved query in a tab, to be saved at the top of folder
   * `parent` (null: the top level of the tree). */
  addQuery: (parent: string | null) => void;
  /** Create an empty playlist, named for the current moment, at the top of
   * folder `parent` (null: the top level of the tree), and open it in a new,
   * active tab once it's saved — a playlist is never unsaved. */
  addPlaylist: (parent: string | null) => void;
  /** Start editing an explorer item's name in place. */
  beginTreeRename: (item: TreeItemRef) => void;
  /** Finish the in-place rename with `name` (`folder.rename` or
   * `source.rename`, which an open tab of the query follows); a blank or
   * unchanged name just ends it. */
  commitTreeRename: (item: TreeItemRef, name: string) => void;
  cancelTreeRename: () => void;
  /** Delete folder `id`, moving its contents out into its place. */
  deleteFolder: (id: string) => void;
  /** Move an explorer-tree item to `target` (a drag-and-drop's drop). Returns
   * whether anything moved. Dropping into an empty folder expands it. */
  moveTreeItem: (item: TreeItemRef, target: DropTarget) => boolean;
  /** Install an introspection document directly (dev/test seam — lets the
   * harness render schema-driven UI, the record editor above all, without a
   * backend). Takes the *enriched* JSON, as `schema.json` holds. */
  setSchemaJson: (json: string) => void;
  /** Compile + run the tab's *working* query, storing the structured result. */
  runQuery: (tabId: string) => void;
  /** Run the tab once, the first time it's viewed (idempotent per tab). */
  ensureRun: (tabId: string) => void;
  /** Inject a canned structured result for a tab (dev/test seam — bypasses the
   * compile/fetch/decode path). `lineage` stands in for the lineage analysis,
   * making the rows playable / editable without a real compile. */
  setResults: (
    tabId: string,
    result: QueryResult,
    lineage?: LineageMapping,
    /** Land these rows as a *refresh* of the ones already there rather than as
     * a new set — what a real re-run to identical SQL does, and the only way to
     * reach that path without one. */
    refresh?: boolean,
  ) => void;
  /** Re-points one result row at freshly-seeded values, exactly as the re-read
   * that follows a DML write does (dev/test seam — the tail of a row-context
   * write, without the write). `values` are raw, one per column of the result
   * in order (hidden columns included, matching a real re-read's projection).
   * Unlike {@link setResults} this keeps the selection, the scroll position and
   * the lineage mapping: one row changed, not the rows. */
  setResultRow: (
    tabId: string,
    index: number,
    values: readonly unknown[],
  ) => void;
  /** Overwrite a tab's saved/working definitions directly (dev/test seam —
   * lets the harness reach a specific builder state without a backend). */
  setTabDefinitions: (
    tabId: string,
    saved: QueryDefinition,
    live: QueryDefinition,
  ) => void;

  /** Hand a tab's results scroll offset to the store on the way out of it, and
   * take it back on the way in — one `CanvasGrid` is shared by every tab, so
   * this is where a tab's place in its rows waits while another tab has the
   * grid (see `QueryPageState.scrollOffset`). */
  setResultsScroll: (tabId: string, offset: number) => void;

  /** Turn `tabId`'s results multi-select mode on or off. Turning it off leaves
   * the selection as it stands — the toolbar goes away, the selected rows
   * don't. */
  setMultiSelect: (tabId: string, on: boolean) => void;
  /** Apply a click on result row `index`, updating the selection: Shift extends a
   * range from the anchor, Ctrl/Cmd — or any plain click while multi-select
   * mode is on — toggles the row, and a plain click otherwise selects it
   * alone. */
  clickRow: (
    tabId: string,
    index: number,
    mods: { shift: boolean; ctrl: boolean },
  ) => void;
  /** Handle a double-click on result row `index`: if the query's rows are tracks,
   * plays that row's track (queuing the rows after it). */
  doubleClickRow: (tabId: string, index: number) => void;
  /** Move the result-row selection one row down (`forward`) or up. With
   * `extend`, grow the selection from the anchor to the new row (Shift+Arrow);
   * otherwise select just the new row. Clamps at the ends and scrolls the row
   * into view. Backs the `results.select_*` / `results.extend_*` commands. */
  moveRowSelection: (tabId: string, forward: boolean, extend: boolean) => void;

  /** Replace `tabId`'s sidebar contents with these `records` of `table`, each
   * taken once; an empty list closes it. Used both to open on an arbitrary
   * (possibly multi-row) selection and to resync the open sidebar as the
   * selection changes underneath it. */
  setRecordEditorRecords: (
    tabId: string,
    table: string,
    records: readonly RecordRef[],
  ) => void;
  /** Close `tabId`'s record-editor sidebar. */
  closeRecordEditor: (tabId: string) => void;
  /** The "Dynamic updates" cross-store wiring, installed once by
   * `createStores()`'s subscription on every page's selection and lineage
   * (state management: "Cross-store wiring"). For every tab with an open record
   * editor, re-points it at the tab's current result-row selection. It loops
   * over every tab because it has no component to key off. */
  resyncRecordEditors: () => void;
  /** Send the record editor's save through the DML API in the context of the
   * result rows `records` sit on: the operations run as one request, and those
   * rows are then re-read so the results show what they did (see
   * `query/rowDml.ts`). Resolves to the API's answer — which the form folds back
   * into itself — and rejects only when the write itself failed. */
  runRecordDml: (
    tabId: string,
    records: readonly RecordRef[],
    operations: DmlOperation[],
  ) => Promise<DmlResult>;
  /** Gives every track in `records` the rating `ratingId` — the results row
   * menu's "Rate track", over the whole row selection. One `track.rating`
   * update per record, run in the context of the rows those records sit on, so
   * each row shows its new rating as soon as the write lands. A failure is
   * reported and swallowed: the menu is already gone by then. */
  rateTracks: (
    tabId: string,
    records: readonly RecordRef[],
    ratingId: string,
  ) => void;
  /** Set the record-editor sidebar's width while dragging the resize handle;
   * clamped, not persisted. */
  setRecordSidebarWidth: (px: number) => void;
  /** Persist the current width — called once when a drag ends, so a drag writes
   * to localStorage once rather than on every pointer move. */
  commitRecordSidebarWidth: () => void;

  /** Play the track at result row `index` of `tabId`, with the rows before and
   * after it as the previous/next context. A no-op for non-track rows. */
  playRow: (tabId: string, index: number) => void;
  /** Pause if playing, resume if paused. */
  togglePlayPause: () => void;
  /** Skip to the next queued track (the bar's "Next"). */
  skipNext: () => void;
  /** Move the playing track's playhead to `seconds` (the bar's timeline). */
  seek: (seconds: number) => void;
  /** Dismiss the bar: stop playback and tear down the queue (the bar's "Close"). */
  stopPlayback: () => void;
  /** Jump to the playing track's row: activate its source tab, select the row and
   * scroll it into view (the bar's "Locate"). */
  locateCurrentTrack: () => void;
  /** Seed the now-playing bar without touching the audio engine (dev/test seam —
   * lets the harness snapshot the bar with no backend or audio). */
  seedNowPlaying: (track: CurrentTrack, playback: AppState["playback"]) => void;

  /** The Save button: save an unsaved query (`query.add`), naming it for the
   * current moment, or — for a saved query whose last save failed — send its
   * working definition again now, rather than once the app goes quiet. */
  saveQuery: (tabId: string) => void;
  /** Open an unsaved copy of query `id` (from its working definition, when
   * it's open) in a new tab. */
  duplicateQuery: (id: string) => void;
  /** Save a copy of playlist `id` — its name, its definition (the working
   * one, when it's open) and its entries — at the top of its folder, and open
   * the copy in a new tab. */
  duplicatePlaylist: (id: string) => void;
  /** "Query: Convert to playlist": save a new playlist holding the tracks of
   * query tab `tabId`'s rows, in the order shown, at the top of the query's
   * folder, and open it in a tab beside the query's. A no-op unless
   * `selectCanConvertToPlaylist`. */
  convertToPlaylist: (tabId: string) => void;
  /** Open a new unsaved query tab based on "track", seeded with that base's
   * default filter/sort/display presets. */
  newQueryTab: () => void;
  /** Step `tabId`'s page back by one step of its undo history (see
   * `state/undoHistory.ts`): for the query page, back to the definition it ran
   * before this one. An edit not yet run is a step of its own, so it's what
   * goes first. A step that wrote to the page's playlist entries sends their
   * inverse first, and steps back only once that has landed. Does nothing while
   * a write to the entries is in flight (`selectIsWriting`). */
  undo: (tabId: string) => void;
  /** Step `tabId`'s page forward again, after an undo, resending a step's entry
   * writes as undo does. */
  redo: (tabId: string) => void;
  /** Writes to `tabId`'s playlist entries as one undoable step. `prepare` runs
   * in the playlist's write queue, once every write queued before it has
   * settled, so what it reads is current. It resolves to the writes to send,
   * with an optional edit of the working definition that goes with them (or to
   * `undefined`, for nothing to do). Once the writes have landed, the step is
   * recorded, the edit applied, and the results reloaded as new rows. Resolves
   * to whether the writes landed. A failed request leaves the history alone,
   * and the error bar has already reported it. */
  writeStep: (
    tabId: string,
    prepare: () => Promise<PreparedStep | undefined>,
  ) => Promise<boolean>;
  /** Note a request to the backend, in flight until `settled` settles: a saved
   * query's edits aren't written until the app has been quiet for a while.
   * `createStores()` feeds every request the generated client sends
   * (`onRequest`) through here. */
  noteRequest: (settled: Promise<unknown>) => void;
  /** Write every saved query's pending edits now, quiet or not — for when the
   * page is being hidden, and may not get another chance. */
  flushSaves: () => void;
  /** Open a new unsaved query tab on exactly the records `query` finds — the
   * record editor's "open in a new tab" on a multi-record field. Its filter and
   * sort are `query`'s own; its display is the base table's default display
   * preset when there is one, and `query`'s otherwise. The tab goes in to the
   * right of `besideTabId` and becomes the active one. */
  openRecordsTab: (besideTabId: string, query: RecordQuery) => void;
  /** Open `childTable`'s records for `parents` (records of `parentTable`, as
   * result rows identify them) in a new query tab beside `tabId` — what the
   * record editor's "open in a new tab" does on the `childTable` field, without
   * opening the editor. A no-op when the schema has no such field, or no parent
   * has an `id` to point at. */
  showChildRecords: (
    tabId: string,
    parentTable: string,
    parents: readonly RecordRef[],
    childTable: string,
  ) => void;

  /** Begin renaming query `id`, seeding the buffer with its current name. */
  beginRename: (id: string) => void;
  /** Update the in-progress rename buffer. */
  setRenameBuffer: (text: string) => void;
  /** Commit the in-progress rename (`source.rename`); an empty name cancels. */
  commitRename: () => void;
  /** Abandon the in-progress rename. */
  cancelRename: () => void;

  /** Open the delete-confirmation modal for source `id`: a query (saved or
   * not) or a playlist. */
  requestDelete: (id: string) => void;
  /** Confirm the pending delete — `query.delete` for a query, or one `dml`
   * request deleting a playlist's entries, source and record — and close its
   * tab. */
  confirmDelete: () => void;
  /** Dismiss the delete-confirmation modal. */
  cancelDelete: () => void;

  /** Toggle a builder section open/closed (opening switches sections). */
  toggleBuilderSection: (tabId: string, section: Section) => void;
  /** Open a builder section (never closing it, unlike the toggle) and ask it to
   * take the caret — the `query.focus_*` commands' action. */
  focusBuilderSection: (tabId: string, section: Section) => void;
  /** Clear the pending focus request once it has been applied. */
  clearBuilderFocus: () => void;
  /** Toggle the whole-query editor open/closed. */
  toggleFullEditor: (tabId: string) => void;
  /** Toggle a preset's inline editor open/closed. */
  toggleExpandPreset: (tabId: string, presetId: string) => void;

  /** Move a tab's query onto another base table, keeping the hand-written filter
   * and reseeding everything else from the new table's default presets. */
  setBase: (tabId: string, table: string) => void;
  /** Flatten a tab's sectioned query into one hand-written Querydown query and
   * open the editor on it. */
  convertToFull: (tabId: string) => void;
  /** Replace a full-mode query's text. */
  setFullText: (tabId: string, text: string) => void;
  setFilterCustom: (tabId: string, text: string) => void;
  clearFilterCustom: (tabId: string) => void;
  toggleFilterPreset: (tabId: string, presetId: string) => void;
  setSectionContent: (
    tabId: string,
    section: "sort" | "display",
    content: SectionContent,
  ) => void;
  setSectionCustomText: (
    tabId: string,
    section: "sort" | "display",
    text: string,
  ) => void;
  reshuffle: (tabId: string, section: "sort" | "display") => void;
  revertLive: (tabId: string) => void;

  beginPresetEdit: (id: string) => void;
  patchPresetEdit: (id: string, patch: Partial<PresetEdit>) => void;
  revertPresetEdit: (id: string) => void;
  commitPresetEdit: (tabId: string, id: string) => void;

  openPresetSave: (section: Section, definition: string) => void;
  cancelPresetSave: () => void;
  patchPresetSave: (patch: Partial<PresetSave>) => void;
  confirmPresetSave: (tabId: string) => void;
  openViewSql: (tabId: string) => void;
  closeViewSql: () => void;
  /** Open the About dialog — the Settings menu's entry and the
   * `app.check_for_updates` command's action. */
  openAbout: () => void;
  closeAbout: () => void;

  /** Store a setting's value and re-run the open queries under it. A value
   * equal to the default is stored as a *deletion* — the reset path. */
  saveSetting: (key: SettingKey, value: string) => void;
  /** Open a setting's editor dialog (the Settings menu's entries). */
  openSetting: (key: SettingKey) => void;
  closeSetting: () => void;
  /** Re-scan the collection on the server ("Re-scan collection" in the Settings
   * menu). Resolves when the scan has finished — the menu waits on it to close
   * itself — whether it succeeded or failed; a failure is the error bar's to
   * report, as it is for every other call. Nothing on screen is reloaded
   * afterwards: the open queries hold the rows they ran against, and re-running
   * them is the user's to ask for.
   *
   * A second call while one is in flight resolves immediately, doing nothing. */
  rescanCollection: () => Promise<void>;
  /** Records a failed RPC call for the error bar. `createStores()` feeds every
   * failure the generated client sees (`onRpcFailure`) through here. A repeat of
   * the failure already showing counts up rather than replacing it, and methods
   * in {@link UNREPORTED_METHODS} are ignored. */
  reportRpcFailure: (method: string, error: unknown) => void;
  /** Hide the error bar. */
  dismissRpcError: () => void;
}

/** Builds the write half of the app store: every action closes over the
 * vanilla store's `getState`/`setState` plus the non-reactive internals that
 * never belonged in `AppState` (selection anchors, run tokens, debounce
 * timers, the audio engine). */
export function createAppActions(
  store: AppVanillaStore,
  env: AppEnv,
): { actions: AppActions; dispose: () => void } {
  const get = store.getState;
  const set = store.setState;

  const stopWatchingSystemTheme = watchSystemTheme(env, () => get().theme);

  // Open tabs survive a reload: every change to the tab list — a tab's unsaved
  // edits included — or to which tab is active is written through, and
  // `initialState` restores it.
  const stopPersistingTabs = store.subscribe(
    (s) => [s.tabs, s.activeTabId] as const,
    ([tabs, activeTabId]) => persistTabs(env, tabs, activeTabId),
    { equalityFn: shallow },
  );

  // Tabs that have been auto-run once (the "have I run this tab yet" guard).
  const autoRun = new Set<string>();

  // Per-tab selection anchor: the fixed end a Shift-click range grows from (and
  // that a plain/Ctrl click re-plants). Non-reactive — only the resulting
  // page `selection` set drives the paint.
  const rowClickAnchor = new Map<string, number>();

  // Per-tab selection lead: the moving end — the row an arrow-key step counts
  // from. Split from the anchor so Shift+Arrow after a Shift+click keeps
  // growing the same range.
  const rowSelectionLead = new Map<string, number>();

  // Monotonic per-tab run token, so a slow lineage analysis (WASM load) from a
  // superseded run can't clobber a newer run's track-id mapping.
  const runTokens = new Map<string, number>();
  let runTokenSeq = 0;

  // The SQL each tab's rows on screen were compiled from. A run that compiles
  // to the same string is asking the same question again — a refresh — which is
  // what lets its answer land *under* the selection and the scroll position
  // rather than replacing them (see `setTabResult`). Non-reactive: nothing
  // renders from it.
  const lastRunSql = new Map<string, string>();

  // Trailing-debounced re-runs, keyed by tab id, so a burst of keystrokes in a
  // builder text input collapses into one query run once the user pauses.
  const runTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const cancelScheduledRun = (tabId: string) => {
    const pending = runTimers.get(tabId);
    if (pending !== undefined) {
      clearTimeout(pending);
      runTimers.delete(tabId);
    }
  };
  const scheduleRun = (tabId: string) => {
    cancelScheduledRun(tabId);
    runTimers.set(
      tabId,
      setTimeout(() => {
        runTimers.delete(tabId);
        runQuery(tabId);
      }, RUN_DEBOUNCE_MS),
    );
  };

  // Saved queries' edits, waiting for the app to go quiet before they're
  // written — one write per tab id, carrying its latest definition.
  const saves = new IdleQueue(AUTOSAVE_IDLE_MS);

  // Whether a rating-vocabulary load is in flight, so raising the menu twice
  // before the first answer lands doesn't run the query twice. Non-reactive:
  // `ratings.status` is what renders, and it can't tell "in flight" from
  // "hasn't started".
  let ratingsLoading = false;

  let rowPatchSeq = 0;
  let revealSeq = 0;
  let builderFocusSeq = 0;

  /** Mutates a query tab in place through a mutator, a no-op when `tabId` isn't
   * an open query tab. Every write to a query tab's fields goes through here:
   * `tabs` holds a union of page kinds, so the narrowing has to happen inside the
   * update rather than in a store path. */
  const editQueryTab = (tabId: string, mutate: (t: QueryTab) => void) => {
    set((s) => {
      const t = s.tabs.find((x) => x.id === tabId);
      if (t?.kind === "query") mutate(t);
    });
  };

  /** {@link editQueryTab} for any page tab: a query's or a playlist's. */
  const editPageTab = (tabId: string, mutate: (t: PageTab) => void) => {
    set((s) => {
      const t = s.tabs.find((x) => x.id === tabId);
      if (t?.kind === "query" || t?.kind === "playlist") mutate(t);
    });
  };

  /** Puts `def` in page tab `t`'s `field`. A page only ever holds definitions
   * of its own kind (its history and its saves hold ones it produced), so the
   * kinds always match; the check is what lets the types follow that. */
  const assignDefinition = (
    t: PageTab,
    field: "saved" | "live",
    def: PageDefinition,
  ) => {
    if (t.kind === "query") {
      if (isQueryDefinition(def)) t[field] = def;
    } else if (!isQueryDefinition(def)) {
      t[field] = def;
    }
  };

  /** Compiles page tab `t`'s working definition as its kind calls for: a
   * query through `compileSavedQuery`, a playlist's entry listing through
   * `compilePlaylist`. Throws as they do. */
  const compilePage = (t: PageTab, schemaJson: string) => {
    const presets = selectEffectivePresets(get());
    const prelude = selectPrelude(get());
    return t.kind === "playlist"
      ? compilePlaylist(t.playlistId, t.live, presets, schemaJson, prelude)
      : compileSavedQuery(t.live, presets, schemaJson, prelude);
  };

  // Writes to playlists' entries, run one at a time per playlist, keyed by
  // source id (which is also its tab's id). A page's `writing` flag mirrors
  // whether its key has anything in flight or waiting.
  const entryWrites = new WriteQueue((key, busy) => {
    set((s) => {
      // Not `pageDraft`: a playlist that isn't open has no page to mark.
      const page = s.pages[key];
      if (page) page.writing = busy;
    });
  });

  /** The draft of `tabId`'s page, created empty by the first write to it. Only
   * for writes: a read goes through `s.pages[tabId]?.…`, which never creates
   * one. */
  const pageDraft = (s: Draft<AppState>, tabId: string) =>
    (s.pages[tabId] ??= castDraft({
      ...emptyPage(),
      writing: entryWrites.busy(tabId),
    }));

  /** Installs a tab's decoded result, forcing a fresh object reference.
   *
   * `QueryResult` is a class, so assigning one at a store leaf always swaps the
   * reference — Immer never drafts a class instance (see the unit tests), so
   * the new value simply replaces the old one, same as every other write.
   *
   * `refresh` says these rows *replace the same query's* rows rather than
   * answering a new question (see `QueryPageState.resultIsRefresh`), and is
   * what keeps everything the user had built on top of the old rows —
   * selection, multi-select mode, the open record editor, the scroll position,
   * the lineage mapping — standing instead of being swept away. The one thing a
   * refresh still has to touch is a selected row that came back shorter than
   * the rows it pointed into. */
  const setTabResult = (
    tabId: string,
    result: QueryResult,
    refresh = false,
  ) => {
    // What a refresh has to do about rows the re-run came back too short for,
    // worked out here rather than inside the producer below: a selection is a
    // `Set`, and *reading* one through a draft is what would ask Immer for the
    // MapSet plugin this store deliberately does without (see the state's
    // "treated as opaque by Immer" note). `undefined` means "leave it as it
    // is" — including leaving the reference alone, so the record editor's
    // resync doesn't wake up for a refresh that moved nothing.
    let trimmed: Set<number> | undefined;
    if (refresh) {
      const rows = [...(get().pages[tabId]?.selection ?? EMPTY_SELECTION)];
      const kept = rows.filter((row) => row < result.rowCount);
      if (kept.length !== rows.length) trimmed = new Set(kept);
    }
    set((s) => {
      // `castDraft` here (and at the other `readonly`-bearing assignments
      // below) is a type-only escape hatch: Immer's `Draft<T>` mapped type
      // can't express a `readonly T[]` field (a quirk of its `T extends
      // any[]` check), which every one of these framework-free result/lineage
      // types has somewhere. Nothing here is ever mutated *through* the
      // draft — each is a wholesale replacement — so there's nothing for
      // Immer to actually draft at runtime.
      const page = pageDraft(s, tabId);
      page.result = castDraft(result);
      page.resultIsRefresh = refresh;
      if (refresh) {
        // Same query, same rows: everything pinned to a row index still means
        // what it meant, so nothing else here is touched.
        if (trimmed !== undefined) {
          if (trimmed.size !== 0) page.selection = trimmed;
          else {
            // Nothing selected is left: multi-select mode goes with it, rather
            // than leaving a toolbar counting rows that are gone.
            delete page.selection;
            page.multiSelect = false;
          }
        }
        return;
      }
      // New rows invalidate the old selection and any prior lineage mapping (the
      // latter is repopulated asynchronously by `analyzeLineage`). Multi-select
      // mode goes with the selection it was made for, rather than leaving a
      // toolbar counting rows that are gone.
      delete page.selection;
      page.multiSelect = false;
      delete page.lineage;
      // Nor is the place in the old rows a place in these ones.
      page.scrollOffset = 0;
      // The playing track's row belonged to the rows just replaced; it's
      // re-located once the new mapping lands (see `analyzeLineage`).
      if (s.currentTrack?.sourceTabId === tabId) s.currentTrack.rowIndex = null;
    });
    // The anchor and the lead are row indexes too, so a refresh keeps them —
    // unless it left nothing selected for them to grow from.
    if (refresh && trimmed?.size !== 0) return;
    rowClickAnchor.delete(tabId);
    rowSelectionLead.delete(tabId);
  };

  /** Off the critical path: traces the compiled SQL's output columns back to
   * their source table columns, then caches the two things the rows' affordances
   * need — which output column carries `track.id` (double-click plays) and,
   * per table whose primary key the rows carry, which output columns carry it
   * (right-click edits the record). A positional mapping only: the per-row
   * values are read back out of `result` on demand, not snapshotted here.
   *
   * Guarded by `token` so a superseded run can't win a race; a query with no
   * traceable ids simply leaves the mapping cleared (`setTabResult` already
   * dropped the previous run's). */
  const analyzeLineage = async (
    tabId: string,
    sql: string,
    result: QueryResult,
    token: number,
  ) => {
    const sources = await analyzeColumnSources(sql);
    if (runTokens.get(tabId) !== token) return; // a newer run superseded this one
    if (!sources) return; // unparseable — no affordances

    // A list of track ids isn't a playable row (an aggregated `[track.id, …]`).
    const isListColumn = (i: number) => result.columns[i]?.isList ?? false;
    const trackCol = trackIdColumn(sources);
    const playable = trackCol !== undefined && !isListColumn(trackCol);
    const schemaJson = get().schema.json;
    // A playlist page's rows stand for their tracks. The entries themselves
    // aren't for editing, so the record editor begins at the track ("Edit
    // track", not "Edit playlist_track").
    const playlist = selectPageTab(get(), tabId)?.kind === "playlist";
    const records = schemaJson
      ? recordKeyColumns(sources, parseSchemaTables(schemaJson))
          // A key whose value arrives as a list identifies no one record.
          .filter((k) => !k.keyIndices.some(isListColumn))
          .filter((k) => !playlist || k.table !== "playlist_track")
      : [];

    set((s) => {
      pageDraft(s, tabId).lineage = castDraft({
        trackIdColumn: playable ? trackCol : undefined,
        records,
      });
    });
    if (!playable) return;
    relocateCurrentTrack(tabId);
  };

  /** Re-locates the playing track's row in the rows a tab has just landed, so
   * "Locate" keeps working across a re-run (mirrors
   * `maybe_revalidate_current_track_index`), and recomputes the play queue
   * around that row — the surrounding tracks may have moved, been added, or
   * dropped. A no-op for a tab that isn't the one the track is playing from.
   * When the track can no longer be found, the queue is left as it was: there's
   * no row to recompute it around. */
  const relocateCurrentTrack = (tabId: string) => {
    const ct = get().currentTrack;
    if (ct?.sourceTabId !== tabId) return;
    const rowIndex = selectLocateRow(get(), tabId, ct.id);
    set((s) => {
      if (s.currentTrack) s.currentTrack.rowIndex = rowIndex;
    });
    if (rowIndex !== null) {
      const { preceding, upcoming } = selectQueueAround(get(), tabId, rowIndex);
      audio?.updateQueue(preceding, upcoming);
    }
  };

  /** Records `tabId`'s working definition in its undo history: whatever it's
   * become since the last checkpoint is a step. Held off while a write to the
   * page's entries is in flight, since the history is that write's to move
   * until it lands. An edit made meanwhile is recorded by the next checkpoint
   * instead. */
  const checkpoint = (tabId: string) => {
    if (!get().pages[tabId]?.writing) recordLive(tabId);
  };

  /** {@link checkpoint}, whether or not a write is in flight. */
  const recordLive = (tabId: string) => {
    const live = selectPageTab(get(), tabId)?.live;
    if (!live) return;
    const history = get().pages[tabId]?.undo ?? EMPTY_HISTORY;
    const next = checkpointHistory(history, live, pageDefsEqual);
    if (next === history) return;
    set((s) => {
      pageDraft(s, tabId).undo = castDraft(next);
    });
  };

  const runQuery = (tabId: string) => {
    const t = selectPageTab(get(), tabId);
    if (!t) return;
    // An immediate run supersedes any run this tab had pending on the debounce.
    cancelScheduledRun(tabId);
    // Every run is an undo checkpoint: what the user can step back to is what
    // they've seen the rows of.
    checkpoint(tabId);
    autoRun.add(tabId);
    const token = ++runTokenSeq;
    runTokens.set(tabId, token);
    set((s) => {
      pageDraft(s, tabId).running = true;
    });
    void (async () => {
      try {
        await querydownReady();
        // Re-read after the await (store rule 4): the tab's working
        // definition may have moved on while the compiler was loading.
        const current = selectPageTab(get(), tabId);
        const schemaJson = get().schema.json;
        if (!current || schemaJson === undefined) return;
        const { sql, columnAnnotations } = compilePage(current, schemaJson);
        const table = await runSql(sql);
        // Decode the result once, here — never per resize/frame (§6). Display
        // text is derived from it on read, not precomputed.
        const result = buildResultFromArrow(table, columnAnnotations);
        // A run that compiled to the SQL the rows on screen came from is a
        // *refresh* — the Refresh button, a re-run after a settings change, a
        // revert or preset edit that turned out to change nothing. The same
        // question asked again, so what the user built on the last answer
        // (selection, editor, scroll) survives it; see `setTabResult`.
        const page = get().pages[tabId];
        const refresh =
          page?.result !== undefined && lastRunSql.get(tabId) === sql;
        lastRunSql.set(tabId, sql);
        setTabResult(tabId, result, refresh);
        set((s) => {
          pageDraft(s, tabId).runFailed = false;
        });
        if (refresh && page?.lineage !== undefined) {
          // Identical SQL maps its columns identically, so the mapping the tab
          // already holds is the mapping these rows want — and re-deriving it
          // would only churn the reference the record editor's resync watches.
          // The *rows* did move, though, so the playing one is looked up again.
          relocateCurrentTrack(tabId);
        } else {
          // Off the critical path, figure out what these rows *are* — tracks to
          // play, records to edit. Deliberately not awaited: the results are
          // already shown, and the WASM lineage analysis is heavy.
          void analyzeLineage(tabId, sql, result, token);
        }
      } catch (err) {
        // No error UI this phase — console only (see plan non-goals).
        console.error("query run failed", err);
        set((s) => {
          const page = s.pages[tabId];
          if (page) page.runFailed = true;
        });
      } finally {
        set((s) => {
          // Not `pageDraft`: a tab closed mid-run took its page with it, and
          // a finished run shouldn't bring it back.
          const page = s.pages[tabId];
          if (page) page.running = false;
        });
      }
    })();
  };

  /** Changes a tab's working definition, then re-runs its query: `"now"`, or
   * `"debounced"` for the builder's free-text editors, whose state update still
   * lands immediately (so the controlled input stays in sync) while the run
   * waits for a pause in the typing.
   *
   * The one way a page's definition changes — every edit, rebase, revert,
   * undo and redo comes through here — so a saved query's or a playlist's save
   * is deferred from here too. */
  const changeLive = (
    tabId: string,
    change: (t: PageTab) => void,
    run: "now" | "debounced",
  ) => {
    if (!selectPageTab(get(), tabId)) return;
    editPageTab(tabId, change);
    deferSave(tabId);
    if (run === "now") runQuery(tabId);
    else scheduleRun(tabId);
  };

  /** Formulates the save of saved source `tabId`'s working definition as it
   * stands, and holds it until the app goes quiet — replacing any save of it
   * already waiting. An unsaved query's edits stay in its tab. */
  const deferSave = (tabId: string) => {
    const t = selectPageTab(get(), tabId);
    if (!t || !selectIsPersisted(get(), tabId)) return;
    const def = t.live;
    saves.defer(tabId, () => writeDefinition(tabId, def));
  };

  /** Writes `def` as saved source `tabId`'s definition (whichever of a query
   * or a playlist it wraps — `source.update_definition` sorts that out). Once
   * the backend has it, it's the tab's `saved` baseline and the explorer's copy
   * (which is what opening the source again reads); a failure is flagged on the
   * tab, and the error bar has already reported it (`onRpcFailure`). */
  const writeDefinition = async (tabId: string, def: PageDefinition) => {
    const definition = pageDefinitionToStored(def);
    const modifiedAt = nowEpoch();
    try {
      await sourceUpdateDefinition({ id: tabId, definition, modifiedAt });
    } catch (err) {
      console.error("source save failed", err);
      editPageTab(tabId, (x) => {
        x.saveFailed = true;
      });
      return;
    }
    editPageTab(tabId, (x) => {
      assignDefinition(x, "saved", def);
      x.saveFailed = false;
    });
    set((s) => {
      const query = s.sources.data.find((q) => q.id === tabId);
      if (query) Object.assign(query, { definition, modifiedAt });
    });
  };

  /** Moves `tabId`'s undo history from `from` across `step` to `to`, its
   * neighbor (`"revert"` to step back, `"apply"` to step forward). A step with
   * no writes lands at once. One with writes sends them through the playlist's
   * write queue first, and lands only once they have: a failure leaves the
   * history where it was. */
  const traverseStep = (
    tabId: string,
    from: UndoHistory<PageDefinition>,
    step: UndoStep<PageDefinition>,
    to: UndoHistory<PageDefinition>,
    direction: "apply" | "revert",
  ) => {
    const writes = step.writes?.[direction];
    if (!writes) {
      landHistory(tabId, to, false);
      return;
    }
    void entryWrites.run(tabId, async () => {
      try {
        await sendPlaylistWrites(writes);
      } catch (err) {
        console.error("playlist write failed", err);
        return;
      }
      // Re-read after the await: the tab may have closed meanwhile. Nothing
      // else moves the history while the write is in flight.
      if (get().pages[tabId]?.undo !== from) return;
      landHistory(tabId, to, true);
    });
  };

  /** Puts `tabId`'s undo history at `history`, and the definition it stands
   * on in force as the working one (which re-runs, and is saved like any other
   * change). `entriesChanged` says the playlist's entries were just written,
   * so the results reload as new rows even if the definition is the same (see
   * "The results after a write" in the playlists spec). */
  const landHistory = (
    tabId: string,
    history: UndoHistory<PageDefinition>,
    entriesChanged: boolean,
  ) => {
    const live = selectPageTab(get(), tabId)?.live;
    const def = history.current;
    const changesDef =
      def !== undefined && live !== undefined && !pageDefsEqual(def, live);
    set((s) => {
      const page = pageDraft(s, tabId);
      page.undo = castDraft(history);
      if (changesDef) page.expandedPreset = null;
    });
    if (entriesChanged) lastRunSql.delete(tabId);
    if (changesDef) replaceLive(tabId, def);
    else if (entriesChanged) runQuery(tabId);
  };

  /** {@link changeLive} through a mutator of the working definition's
   * sections — the part every page kind shares, and the builders edit. */
  const editLive = (
    tabId: string,
    mutate: (def: Sections) => void,
    run: "now" | "debounced" = "now",
  ) => changeLive(tabId, (t) => mutate(t.live), run);

  /** {@link editLive} for what only a query has (its full-Querydown text): a
   * no-op on any other page. */
  const editQueryLive = (
    tabId: string,
    mutate: (def: QueryDefinition) => void,
    run: "now" | "debounced" = "now",
  ) => {
    if (!selectQueryTab(get(), tabId)) return;
    changeLive(
      tabId,
      (t) => {
        if (t.kind === "query") mutate(t.live);
      },
      run,
    );
  };

  /** {@link changeLive} to a whole new working definition, of the page's own
   * kind. */
  const replaceLive = (tabId: string, def: PageDefinition) =>
    changeLive(tabId, (t) => assignDefinition(t, "live", def), "now");

  const beginPresetEdit = (id: string) => {
    const preset = get().presets.find((p) => p.id === id);
    if (!preset) return;
    set((s) => {
      s.presetEdits[id] = {
        name: preset.name,
        definition: preset.definition,
        isDefault: preset.isDefault,
      };
    });
  };

  /** Closes the tab `id`, dropping its cached state and selecting a neighbor.
   * Standalone (not just an object method) so backend actions like delete can
   * reuse it. Kind-agnostic: a settings tab simply has no page to drop. */
  const closeTab = (id: string) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      s.tabs.splice(idx, 1);
      delete s.pages[id];
      if (s.activeTabId === id) {
        // Select the neighbor (prefer the one to the left), or clear.
        const next = s.tabs[idx] ?? s.tabs[idx - 1];
        s.activeTabId = next ? next.id : null;
      }
      // Playback outlives its source tab (the engine owns the queue), but
      // there's no longer anywhere for "Locate" to go.
      if (s.currentTrack?.sourceTabId === id) {
        s.currentTrack.sourceTabId = null;
        s.currentTrack.rowIndex = null;
      }
    });
    // There's nothing left to wait for: no more edits are coming to fold into
    // a closed tab's save.
    saves.flush(id);
    autoRun.delete(id);
    cancelScheduledRun(id);
    rowClickAnchor.delete(id);
    rowSelectionLead.delete(id);
    runTokens.delete(id);
    lastRunSql.delete(id);
  };

  /** Opens saved source `source` in a tab — a query tab, or a playlist tab
   * for a playlist — and makes it the active tab. A source already open is
   * only made active. A new tab goes in at `index` in the tab bar, or at the
   * end without one. */
  const openSource = (
    source: Parameters<AppActions["openTab"]>[0],
    index?: number,
  ) => {
    set((s) => {
      if (!s.tabs.some((t) => t.id === source.id)) {
        const at = index ?? s.tabs.length;
        if (source.kind === "playlist" && source.playlistId) {
          const saved = playlistDefinitionFromStored(source.definition);
          s.tabs.splice(at, 0, {
            kind: "playlist",
            id: source.id,
            playlistId: source.playlistId,
            name: source.name,
            saved,
            live: structuredClone(saved),
            saveFailed: false,
          });
        } else {
          const saved = definitionFromStored(source.definition);
          s.tabs.splice(at, 0, {
            kind: "query",
            id: source.id,
            name: source.name,
            saved,
            live: cloneDefinition(saved),
            persisted: true,
            saveFailed: false,
            folder: null,
          });
        }
      }
      s.activeTabId = source.id;
    });
  };

  /** Opens `def` in a new unsaved (and so nameless) query tab, and makes it
   * the active tab. It goes in at `index` in the tab bar, or at the end without
   * one; saving it puts it in `folder`. */
  const openUnsavedTab = (
    def: QueryDefinition,
    { index, folder = null }: { index?: number; folder?: string | null } = {},
  ) => {
    const newId = newUuid();
    set((s) => {
      s.tabs.splice(index ?? s.tabs.length, 0, {
        kind: "query",
        id: newId,
        name: "",
        saved: cloneDefinition(def),
        live: def,
        persisted: false,
        saveFailed: false,
        folder,
      });
      s.activeTabId = newId;
    });
  };

  // ── Writing to a result row ─────────────────────────────────────────────────
  //
  // Every write the app makes is made *from* a row: the play log as a track
  // finishes, the record editor's save. `query/rowDml.ts` runs the request and
  // re-reads that one row; this half finds the row, and puts the answer back.

  /** Re-points a tab's stored result at a re-read row — in place.
   *
   * In place, rather than as a fresh result object, because a new result is the
   * signal for a whole new run: the grid resets its scroll position and drops
   * its hover when it gets one, and the selection, the lineage mapping and the
   * playing row's index are all cleared alongside it (see `setTabResult`). None
   * of that should happen because one row's data changed. `QueryResult` is
   * never drafted by Immer (a class instance with no `[immerable]` marker), so
   * `patchRow` mutates it directly; the repaint is asked for separately,
   * through `rowPatch`.
   *
   * The row is left alone when the re-read's projection doesn't line up with
   * this result's (a different column count means a different query — see
   * `QueryResult.patchRow`) or when the tab has been re-run since the write,
   * which replaced the rows this one belonged to. */
  const patchRow = (
    tabId: string,
    index: number,
    table: arrow.Table,
    from: number,
    token: number | undefined,
  ) => {
    if (runTokens.get(tabId) !== token) return;
    const result = get().pages[tabId]?.result;
    if (!result || index < 0 || index >= result.rowCount) return;
    if (!result.patchRow(index, table, from)) return;
    set((s) => {
      s.rowPatch = { tabId, row: index, seq: ++rowPatchSeq };
    });
  };

  /** Runs a DML request in the context of the result rows it was made from: the
   * write goes through the API, then each of those rows is re-read and patched
   * in. Rejects only when the write itself failed (a refresh that can't be done
   * leaves its row as it was — see `query/rowDml.ts`). */
  const runDmlForRows = async (
    operations: DmlOperation[],
    rows: readonly { tabId: string; index: number }[],
  ): Promise<DmlResult> => {
    // Both the contexts and the run tokens are read *before* the request: they
    // describe the rows as they are now, which is what the answer will be about.
    // A row with no context of its own is simply not refreshed.
    const targets = rows.flatMap((row) => {
      const context = selectRowContext(get(), row.tabId, row.index);
      return context ? [{ row, context, token: runTokens.get(row.tabId) }] : [];
    });
    const outcome = await runRowDml(
      operations,
      targets.map((target) => target.context),
    );
    targets.forEach((target, i) => {
      const location = outcome.rows[i];
      if (!location) return;
      patchRow(
        target.row.tabId,
        target.row.index,
        location.table,
        location.row,
        target.token,
      );
    });
    return outcome.result;
  };

  // ── Playback ────────────────────────────────────────────────────────────────

  // The audio engine, built on the first play so a session that never plays
  // anything creates no <audio> element and claims no OS media session.
  let audio: AudioEngine | undefined;
  const engine = (): AudioEngine =>
    (audio ??= new AudioEngine(
      {
        onTrackChange: (id) => reconcileTrackChange(id),
        onPlayCompleted: (id) => logPlay(id),
        onQueueDry: () => clearNowPlaying(),
        onTransport: () => syncTransport(),
        onStreamRequest: () => saves.touch(),
      },
      () => get().audioQuality,
    ));

  /** Mirrors the engine's transport state into the store for the bar to render.
   * The engine stays the source of truth; this is a projection of it. */
  const syncTransport = () => {
    if (!audio) return;
    set((s) => {
      s.playback = {
        playing: audio!.isPlaying,
        position: audio!.position,
        duration: audio!.duration,
        hasNext: audio!.hasNext,
      };
    });
  };

  /** Logs a completed play of `trackId`, against the row it's playing from when
   * that row is still on screen — so the play count in it (and anything else the
   * query derives from the log) moves with the log.
   *
   * The engine reports the completed play *before* it advances, so the bar's
   * track is still this one; an id that has somehow moved on is looked up in the
   * rows instead. Fire-and-forget either way: this runs from media events that
   * can fire while the app is backgrounded, and a failed insert must never
   * interrupt playback. */
  const logPlay = (trackId: string) => {
    const ct = get().currentTrack;
    const source = ct?.sourceTabId ?? null;
    const index =
      source === null
        ? null
        : ct?.id === trackId
          ? ct.rowIndex
          : selectLocateRow(get(), source, trackId);
    void runDmlForRows(
      [playInsert(trackId)],
      source !== null && index !== null ? [{ tabId: source, index }] : [],
    ).catch((err) => console.error("play log failed", err));
  };

  /** Fetches the track's title/artists/duration, then fills them into the bar
   * and hands them to the engine (the OS media session, and the length a
   * transcoded stream lacks) — but only while that track is still the current
   * one, so a fetch overtaken by an auto-advance is discarded. */
  const loadMetadata = async (id: string) => {
    const meta = await fetchTrackMetadata(id);
    if (!meta || get().currentTrack?.id !== id) return;
    set((s) => {
      if (s.currentTrack) {
        s.currentTrack.title = meta.title;
        s.currentTrack.artists = meta.artists;
      }
    });
    audio?.setMetadata(
      meta.title,
      meta.artists.length > 0 ? meta.artists.join(", ") : null,
      meta.duration,
    );
  };

  /** Records a play against `tabId`'s saved source (bumps `last_play`) — a
   * query's or a playlist's. Skipped for an unsaved query, which has no backend
   * row yet. */
  const recordQueryPlay = (tabId: string) => {
    if (!selectIsPersisted(get(), tabId)) return;
    void sourceRecordPlay({ id: tabId, lastPlay: nowEpoch() }).catch((err) =>
      console.error("record play failed", err),
    );
  };

  /** Folds a track change that originated in the engine (an auto-advance when a
   * track ended, or a lock-screen / headset skip) into the bar: swaps the track,
   * re-locates its row, refetches metadata, and records the play. The engine owns
   * the queue across these transitions, so there's nothing to re-sync there. */
  const reconcileTrackChange = (newId: string) => {
    const source = get().currentTrack?.sourceTabId ?? null;
    if (get().currentTrack === null) return;
    const rowIndex =
      source === null ? null : selectLocateRow(get(), source, newId);
    set((s) => {
      if (!s.currentTrack) return;
      s.currentTrack.id = newId;
      s.currentTrack.rowIndex = rowIndex;
      s.currentTrack.title = null;
      s.currentTrack.artists = [];
    });
    void loadMetadata(newId);
    if (source !== null) recordQueryPlay(source);
    syncTransport();
  };

  /** Tears down playback and empties the bar. */
  const clearNowPlaying = () => {
    audio?.stop();
    set((s) => {
      s.currentTrack = null;
    });
    syncTransport();
  };

  const playRow = (tabId: string, index: number) => {
    const id = selectTrackIdAt(get(), tabId, index);
    if (id === undefined) return;
    const { preceding, upcoming } = selectQueueAround(get(), tabId, index);
    set((s) => {
      s.currentTrack = {
        sourceTabId: tabId,
        id,
        rowIndex: index,
        title: null,
        artists: [],
      };
    });
    engine().setQueue(preceding, id, upcoming);
    syncTransport();
    void loadMetadata(id);
    recordQueryPlay(tabId);
  };

  // ── The record editor (a sidebar within the query page) ────────────────────

  /** Replaces `tabId`'s sidebar contents wholesale — an empty `records` closes
   * it, same as `closeRecordEditor`. A plain assignment: Immer produces a fresh
   * reference for the changed leaf on its own, so re-pointing the editor (or
   * narrowing/widening a bulk selection) already reads as a swap, not a patch.
   *
   * Each record appears once, however many selected rows carry it: several
   * tracks of one album identify that album over and over, and the editor is on
   * one album, not on three copies of it. */
  const setRecordEditorRecords = (
    tabId: string,
    table: string,
    records: readonly RecordRef[],
  ) => {
    const distinct: RecordRef[] = [];
    for (const record of records) {
      if (!distinct.some((seen) => sameRecord(seen, record))) {
        distinct.push(record);
      }
    }
    set((s) => {
      pageDraft(s, tabId).recordEditor =
        distinct.length === 0 ? null : castDraft({ table, records: distinct });
    });
  };

  /** Dynamic updates: while a tab's sidebar is open, keep it pointed at the
   * tab's current result-row selection rather than the row(s) it was opened
   * on — selecting a different row re-points it, widening the selection puts
   * the editor on every record it covers, and clearing the selection closes
   * it. Opening the sidebar from nothing is *not* this action's job (the
   * context menu and the `results.edit_selected` command do that).
   *
   * It must react only to the selection (or lineage), never to its own write to
   * the editor target — otherwise it would loop. That's why it reads `get()`
   * once at the top: this function isn't a subscription input (`createStores()` calls it from a
   * listener, not a selector), so there's nothing for the loop to form
   * through. */
  const resyncRecordEditors = () => {
    const s = get();
    for (const [tabId, page] of Object.entries(s.pages)) {
      const current = page.recordEditor;
      if (!current) continue;
      const selection = page.selection ?? EMPTY_SELECTION;
      if (selection.size === 0) {
        set((draft) => {
          pageDraft(draft, tabId).recordEditor = null;
        });
        continue;
      }
      const records = [...selection]
        .sort((a, b) => a - b)
        .flatMap((index) =>
          selectRowRecords(s, tabId, index).filter(
            (r) => r.table === current.table,
          ),
        );
      // Rows that name no record of this table leave the editor holding the one
      // it has. It stays fully usable — it loaded that record from the database
      // and saves it back there — it simply has no row to write through any
      // more: nothing to patch in place after a save, nowhere to put the ✱.
      // Only an *emptied selection* closes the sidebar (above), because that's
      // the user putting the rows down; this is the rows moving out from under
      // a still-open editor, which a refresh can do at any moment.
      if (records.length === 0) continue;
      setRecordEditorRecords(tabId, current.table, records);
    }
  };

  /** Shows folder `id`'s contents, if they aren't already. */
  const expandFolder = (id: string) => {
    if (!get().expandedFolders.has(id)) actions.toggleFolderExpanded(id);
  };

  /** Moves tree items in the loaded lists ahead of the backend's copy — the
   * optimistic half of `source.arrange`. */
  const applyPlacementsLocally = (placements: readonly Placement[]) => {
    if (placements.length === 0) return;
    set((s) => {
      const next = applyPlacements(s.sources.data, s.folders.data, placements);
      s.sources.data = next.sources;
      s.folders.data = next.folders;
    });
  };

  // ── Creating and deleting playlists ─────────────────────────────────────────
  //
  // A playlist is saved from the moment it exists (its entries are records),
  // so none of these is optimistic about creating one: the tab opens once the
  // backend has it. Each is one `dml` request (see `query/playlistEntries.ts`),
  // and a failure is the error bar's to report, as for every request.

  /** Saves a new playlist — `name`, `definition`, and an entry for each of
   * `entries` (a track and its position) — at the top of `folder`, then lists
   * it in the explorer and opens it in a new, active tab: beside tab
   * `besideTabId` when that's open, or at the end of the tab bar. Resolves
   * once that's done, or once the write has failed. */
  const createPlaylist = async (
    playlist: {
      name: string;
      folder: string | null;
      definition: PlaylistDefinition;
    },
    entries: readonly Omit<PlaylistEntry, "id">[],
    besideTabId?: string,
  ): Promise<void> => {
    const now = nowEpoch();
    const { sources, folders } = get();
    const playlistId = newUuid();
    const source: Source = {
      id: newUuid(),
      kind: "playlist",
      name: playlist.name,
      createdAt: now,
      modifiedAt: now,
      lastPlay: now,
      definition: playlistDefinitionToStored(playlist.definition),
      parent: playlist.folder,
      position: topPosition(sources.data, folders.data, playlist.folder),
      queryId: null,
      playlistId,
    };
    try {
      await sendPlaylistWrites(
        createPlaylistWrites(
          {
            sourceId: source.id,
            playlistId,
            name: source.name,
            createdAt: now,
            folder: source.parent,
            position: source.position,
            definition: source.definition,
          },
          entries,
          newUuid,
        ),
      );
    } catch (err) {
      console.error("playlist create failed", err);
      return;
    }
    set((s) => {
      s.sources.data = [source, ...s.sources.data];
    });
    if (source.parent !== null) expandFolder(source.parent);
    // Re-read after the await: the tabs may have moved meanwhile.
    const beside =
      besideTabId === undefined
        ? -1
        : get().tabs.findIndex((t) => t.id === besideTabId);
    openSource(source, beside === -1 ? undefined : beside + 1);
  };

  /** The `playlist` record source `id` wraps — read from its open tab, or from
   * the explorer's list — or `undefined` for a source that isn't a
   * playlist. */
  const playlistIdOf = (id: string): string | undefined => {
    const t = selectTab(get(), id);
    if (t?.kind === "playlist") return t.playlistId;
    return get().sources.data.find((x) => x.id === id)?.playlistId ?? undefined;
  };

  const actions: AppActions = {
    loadSources: async () => {
      // Sources and folders load together: the explorer builds one tree of
      // both, which one list without the other would scramble.
      set((s) => {
        s.sources.status = "loading";
        s.folders.status = "loading";
      });
      try {
        const [data, folders] = await Promise.all([sourceList(), folderList()]);
        set((s) => {
          s.sources = { status: "ready", data };
          s.folders = { status: "ready", data: folders ?? [] };
        });
      } catch (err) {
        console.error("source list failed", err);
        set((s) => {
          s.sources.status = "error";
          s.folders.status = "error";
        });
      }
    },
    loadPresets: async () => {
      // Presets load once, then live in the mutable `presets` field so local
      // edits and "Save as preset" can add/update them without a refetch.
      set((s) => {
        s.presetsStatus = "loading";
      });
      try {
        const data = await presetList();
        set((s) => {
          s.presets = data;
          s.presetsStatus = "ready";
        });
      } catch (err) {
        console.error("preset list failed", err);
        set((s) => {
          s.presetsStatus = "error";
        });
      }
    },
    loadSchema: async () => {
      // The enriched introspection schema JSON — run the introspection SQL,
      // read the single JSON cell, apply RadioCrate's link inference.
      set((s) => {
        s.schema.status = "loading";
      });
      try {
        const raw = await runSqlScalar(INTROSPECTION_SQL);
        const json = addInferredLinks(raw);
        set((s) => {
          s.schema = { status: "ready", json, tables: parseSchemaTables(json) };
        });
      } catch (err) {
        // No error UI this phase — console only (see plan non-goals).
        console.error("introspection query failed", err);
        set((s) => {
          s.schema.status = "error";
        });
      }
    },
    loadRatings: () => {
      // Loaded once and kept: the table is a fixed vocabulary, not a query
      // result. "In flight" is indistinguishable from "hasn't started" in a
      // `ResourceStatus`, so the guard is a local flag — and it's cleared on a
      // failure, leaving the next raise of the menu free to try again.
      const s = get();
      if (ratingsLoading || s.ratings.status === "ready") return;
      const schemaJson = s.schema.json;
      if (schemaJson === undefined) return;
      ratingsLoading = true;
      void fetchRatings(schemaJson)
        .then((data) => {
          set((draft) => {
            draft.ratings = { status: "ready", data: castDraft(data) };
          });
        })
        .catch((err) => {
          console.error("rating list failed", err);
          set((draft) => {
            draft.ratings.status = "error";
          });
        })
        .finally(() => {
          ratingsLoading = false;
        });
    },
    loadSettings: async () => {
      try {
        const list = await settingList();
        set((s) => {
          s.settingOverrides = overridesFromEntries(list ?? []);
        });
      } catch (err) {
        console.error("setting list failed", err);
      }
    },
    refetchSources: () => {
      void actions.loadSources();
      void actions.loadPresets();
    },

    toggleSidebar: () => actions.setSidebarOpen(!get().sidebarOpen),
    setSidebarOpen: (open) => {
      set((s) => {
        s.sidebarOpen = open;
      });
      persistSidebar(env, open);
    },
    setTheme: (pref) => {
      set((s) => {
        s.theme = pref;
      });
      persistTheme(env, pref);
      applyThemeToDocument(pref, env);
    },
    setAudioQuality: (pref) => {
      set((s) => {
        s.audioQuality = pref;
      });
      persistAudioQuality(env, pref);
    },
    openTab: (source) => openSource(source),
    openShortcutsTab: () => {
      set((s) => {
        // A singleton: a second request focuses the tab that's already open.
        if (!s.tabs.some((t) => t.kind === "shortcuts")) {
          s.tabs.push({
            kind: "shortcuts",
            id: SHORTCUTS_TAB_ID,
            name: SHORTCUTS_TAB_NAME,
          });
        }
        s.activeTabId = SHORTCUTS_TAB_ID;
      });
    },
    closeTab,
    selectTab: (id) =>
      set((s) => {
        s.activeTabId = id;
      }),
    reorderTab: (id, toIndex) => {
      set((s) => {
        const from = s.tabs.findIndex((t) => t.id === id);
        if (from === -1) return;
        const clamped = Math.max(0, Math.min(toIndex, s.tabs.length - 1));
        if (from === clamped) return;
        const [moved] = s.tabs.splice(from, 1);
        s.tabs.splice(clamped, 0, moved);
      });
    },
    setSourceFilter: (text) =>
      set((s) => {
        s.sourceFilter = text;
      }),
    toggleSourceFilter: () =>
      set((s) => {
        s.sourceFilterOpen = !s.sourceFilterOpen;
        if (!s.sourceFilterOpen) s.sourceFilter = "";
      }),
    toggleFolderExpanded: (id) => {
      const next = new Set(get().expandedFolders);
      if (!next.delete(id)) next.add(id);
      set((s) => {
        s.expandedFolders = next;
      });
      persistExpandedFolders(env, next);
    },
    newFolder: () => {
      const s0 = get();
      const folder = {
        id: newUuid(),
        name: "New folder",
        parent: null,
        position: topPosition(s0.sources.data, s0.folders.data, null),
      };
      // Inserted optimistically, and put where it can be seen: a filter would
      // hide the name about to be edited.
      set((s) => {
        s.folders.data = [folder, ...s.folders.data];
        s.sourceFilterOpen = false;
        s.sourceFilter = "";
        s.renamingTreeItem = { kind: "folder", id: folder.id };
      });
      expandFolder(folder.id);
      void folderAdd(folder).catch((err) => {
        console.error("folder add failed", err);
        void actions.loadSources();
      });
    },
    addQuery: (parent) => {
      openUnsavedTab(
        definitionForBase("track", selectEffectivePresets(get())),
        { folder: parent },
      );
    },
    addPlaylist: (parent) =>
      void createPlaylist(
        {
          name: nowName(),
          folder: parent,
          definition: newPlaylistDefinition(selectEffectivePresets(get())),
        },
        [],
      ),
    beginTreeRename: (item) =>
      set((s) => {
        s.renamingTreeItem = item;
      }),
    commitTreeRename: (item, name) => {
      const trimmed = name.trim();
      const list =
        item.kind === "folder" ? get().folders.data : get().sources.data;
      const current = list.find((x) => x.id === item.id);
      set((s) => {
        if (
          s.renamingTreeItem?.kind === item.kind &&
          s.renamingTreeItem.id === item.id
        ) {
          s.renamingTreeItem = null;
        }
      });
      if (!current || trimmed === "" || trimmed === current.name) return;
      set((s) => {
        const entry =
          item.kind === "folder"
            ? s.folders.data.find((x) => x.id === item.id)
            : s.sources.data.find((x) => x.id === item.id);
        if (entry) entry.name = trimmed;
      });
      const renamed =
        item.kind === "folder"
          ? folderRename({ id: item.id, name: trimmed })
          : sourceRename({ id: item.id, name: trimmed });
      // An open tab of the source goes by its name too.
      if (item.kind === "source") {
        editPageTab(item.id, (t) => {
          t.name = trimmed;
        });
      }
      void renamed.catch((err) => {
        console.error(`${item.kind} rename failed`, err);
        void actions.loadSources();
      });
    },
    cancelTreeRename: () =>
      set((s) => {
        s.renamingTreeItem = null;
      }),
    deleteFolder: (id) => {
      const { sources, folders } = get();
      const placements = dissolvePlacements(
        buildTree(sources.data, folders.data),
        storedPositions(sources.data, folders.data),
        id,
      );
      applyPlacementsLocally(placements);
      set((s) => {
        s.folders.data = s.folders.data.filter((f) => f.id !== id);
      });
      if (get().expandedFolders.has(id)) actions.toggleFolderExpanded(id);
      // Contents out first, so a failed delete leaves an empty folder rather
      // than orphans.
      void (async () => {
        if (placements.length > 0) await sourceArrange({ placements });
        await folderDelete({ id });
      })().catch((err) => {
        console.error("folder delete failed", err);
        void actions.loadSources();
      });
    },
    moveTreeItem: (item, target) => {
      const { sources, folders } = get();
      const placements = movePlacements(
        buildTree(sources.data, folders.data),
        storedPositions(sources.data, folders.data),
        item,
        target,
      );
      if (placements.length === 0) return false;
      // Dropped into a folder that had nothing to show: open it, so the item
      // doesn't vanish from sight.
      const emptyFolder =
        target.kind === "into" &&
        !sources.data.some((q) => q.parent === target.folder) &&
        !folders.data.some((f) => f.parent === target.folder);
      applyPlacementsLocally(placements);
      if (emptyFolder) expandFolder(target.folder);
      void sourceArrange({ placements }).catch((err) => {
        console.error("source arrange failed", err);
        void actions.loadSources();
      });
      return true;
    },
    setSchemaJson: (json) =>
      set((s) => {
        s.schema = { status: "ready", json, tables: parseSchemaTables(json) };
      }),
    runQuery,
    ensureRun: (tabId) => {
      if (!autoRun.has(tabId)) runQuery(tabId);
    },
    setResults: (tabId, result, lineage, refresh) => {
      setTabResult(tabId, result, refresh ?? false);
      if (lineage) {
        set((s) => {
          pageDraft(s, tabId).lineage = castDraft(lineage);
        });
      }
    },
    setResultRow: (tabId, index, values) => {
      const result = get().pages[tabId]?.result;
      if (!result) return;
      // A one-row table built by type-inferring each raw value, exactly the
      // shape a real re-read hands `QueryResult.patchRow` (see
      // `query/rowDml.ts`). Dev/test-only, so honest Arrow *types* don't matter
      // here — only the values, which dispatch on at runtime regardless of
      // what TS infers for the array. A list column is built explicitly
      // (`oneRowListVector`) rather than through `vectorFromArray`'s own list
      // inference, which is unreliable for a single-row `Utf8` list — its
      // dictionary-encoded child type fails its own self-comparison.
      const vectors: Record<string, arrow.Vector> = {};
      result.columns.forEach((col, i) => {
        vectors[String(i)] = col.isList
          ? oneRowListVector((values[i] as readonly string[] | undefined) ?? [])
          : arrow.vectorFromArray([values[i]] as unknown as string[]);
      });
      const table = new arrow.Table(vectors);
      patchRow(tabId, index, table, 0, runTokens.get(tabId));
    },
    setTabDefinitions: (tabId, saved, live) => {
      editQueryTab(tabId, (t) => {
        t.saved = saved;
        t.live = cloneDefinition(live);
      });
    },

    setResultsScroll: (tabId, offset) =>
      set((s) => {
        // Not `pageDraft`: this is written as a tab is left, which a tab being
        // *closed* also is — and a closed tab's page shouldn't come back.
        const page = s.pages[tabId];
        if (page) page.scrollOffset = offset;
      }),
    setMultiSelect: (tabId, on) =>
      set((s) => {
        pageDraft(s, tabId).multiSelect = on;
      }),
    clickRow: (tabId, index, mods) => {
      const page = get().pages[tabId];
      const prev = page?.selection;
      // Multi-select mode gives a plain click the Ctrl click's meaning, which
      // is the whole point of it: a touch device has no Ctrl to hold.
      const toggle = mods.ctrl || (page?.multiSelect ?? false);
      let next: Set<number>;
      if (mods.shift) {
        // Grow a range from the anchor (or this row, with nothing anchored yet).
        const anchor = rowClickAnchor.get(tabId) ?? index;
        const lo = Math.min(anchor, index);
        const hi = Math.max(anchor, index);
        next = new Set<number>();
        for (let i = lo; i <= hi; i++) next.add(i);
        rowClickAnchor.set(tabId, anchor);
      } else if (toggle) {
        // Toggle this row in/out of the existing selection.
        next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        rowClickAnchor.set(tabId, index);
      } else {
        // Plain click: this row alone.
        next = new Set<number>([index]);
        rowClickAnchor.set(tabId, index);
      }
      // Whichever branch ran, the clicked row is where a following arrow-key
      // step counts from.
      rowSelectionLead.set(tabId, index);
      set((s) => {
        pageDraft(s, tabId).selection = next;
      });
    },
    // Only track-based rows carry an id; on any other row this does nothing.
    doubleClickRow: (tabId, index) => playRow(tabId, index),
    moveRowSelection: (tabId, forward, extend) => {
      const len = get().pages[tabId]?.result?.rowCount ?? 0;
      if (len === 0) return;
      const last = len - 1;
      // Step from the current lead (or the anchor); with nothing selected yet,
      // an initial Down selects the first row and Up the last.
      const cur = rowSelectionLead.get(tabId) ?? rowClickAnchor.get(tabId);
      const target =
        cur === undefined
          ? forward
            ? 0
            : last
          : forward
            ? Math.min(cur + 1, last)
            : Math.max(cur - 1, 0);

      let next: Set<number>;
      if (extend) {
        const anchor = rowClickAnchor.get(tabId) ?? target;
        rowClickAnchor.set(tabId, anchor);
        const lo = Math.min(anchor, target);
        const hi = Math.max(anchor, target);
        next = new Set<number>();
        for (let i = lo; i <= hi; i++) next.add(i);
      } else {
        next = new Set<number>([target]);
        rowClickAnchor.set(tabId, target);
      }
      rowSelectionLead.set(tabId, target);
      set((s) => {
        pageDraft(s, tabId).selection = next;
        s.rowReveal = { tabId, row: target, seq: ++revealSeq };
      });
    },

    setRecordEditorRecords,
    closeRecordEditor: (tabId) =>
      set((s) => {
        const page = s.pages[tabId];
        if (page) page.recordEditor = null;
      }),
    resyncRecordEditors,
    runRecordDml: (tabId, records, operations) => {
      // One row per record the form was editing — the same row can stand for
      // two of them (a query joining a record to itself), and re-reading it
      // twice would be pointless.
      const indexes = new Set<number>();
      for (const record of records) {
        const index = selectRowForRecord(get(), tabId, record);
        if (index !== undefined) indexes.add(index);
      }
      return runDmlForRows(
        operations,
        [...indexes].map((index) => ({ tabId, index })),
      );
    },
    rateTracks: (tabId, records, ratingId) => {
      // A row can carry the same track twice (a query joining a track to
      // itself), and a record with no key names nothing to update.
      const targets: RecordRef[] = [];
      for (const record of records) {
        if (record.key.length === 0) continue;
        if (!targets.some((seen) => sameRecord(seen, record))) {
          targets.push(record);
        }
      }
      if (targets.length === 0) return;
      const operations = ratingUpdates(
        targets.map((record) => record.key),
        ratingId,
      );
      void actions
        .runRecordDml(tabId, targets, operations)
        .catch((err) => console.error("rating update failed", err));
    },
    setRecordSidebarWidth: (px) =>
      set((s) => {
        s.recordSidebarWidth = clampRecordSidebarWidth(px);
      }),
    commitRecordSidebarWidth: () =>
      persistRecordSidebarWidth(env, get().recordSidebarWidth),

    playRow,
    togglePlayPause: () => {
      if (!audio || !get().currentTrack) return;
      if (audio.isPlaying) audio.pause();
      else audio.play();
      syncTransport();
    },
    skipNext: () => {
      audio?.skipNext();
      syncTransport();
    },
    seek: (seconds) => {
      if (!audio || !get().currentTrack) return;
      audio.seek(seconds);
      syncTransport();
    },
    stopPlayback: () => {
      // Dismissing a track counts as finishing it only if it played at least
      // halfway; log that before the teardown resets the position it's read from.
      const ct = get().currentTrack;
      if (ct && audio?.pastHalfway) logPlay(ct.id);
      clearNowPlaying();
    },
    locateCurrentTrack: () => {
      const ct = get().currentTrack;
      const source = ct?.sourceTabId;
      if (
        !ct ||
        source == null ||
        ct.rowIndex === null ||
        !selectTab(get(), source)
      ) {
        return;
      }
      set((s) => {
        s.activeTabId = source;
        pageDraft(s, source).selection = new Set([ct.rowIndex!]);
        s.rowReveal = { tabId: source, row: ct.rowIndex!, seq: ++revealSeq };
      });
    },
    seedNowPlaying: (track, playback) =>
      set((s) => {
        s.currentTrack = track;
        s.playback = playback;
      }),

    saveQuery: (tabId) => {
      const t = selectQueryTab(get(), tabId);
      if (!t) return;
      if (t.persisted) {
        // A retry: the edits would be saved anyway once the app went quiet,
        // but the user has asked for it now.
        deferSave(tabId);
        saves.flush(tabId);
        return;
      }
      // An unsaved query is added to the top of its folder, named for the
      // moment it was saved. Optimistically: it's in the explorer and saved
      // from here on, and back to unsaved if the backend turns it down. The
      // add goes through the same queue as the saves that follow it, so none
      // of those can overtake it.
      const now = nowEpoch();
      const { sources, folders } = get();
      // The tab is named by its source id; the query row it wraps gets an id
      // of its own.
      const query: Source = {
        id: tabId,
        kind: "query",
        name: nowName(),
        createdAt: now,
        modifiedAt: now,
        lastPlay: now,
        definition: definitionToStored(t.live),
        parent: t.folder,
        position: topPosition(sources.data, folders.data, t.folder),
        queryId: newUuid(),
        playlistId: null,
      };
      set((s) => {
        s.sources.data = [query, ...s.sources.data];
      });
      if (t.folder !== null) expandFolder(t.folder);
      editQueryTab(tabId, (x) => {
        x.name = query.name;
        x.saved = t.live;
        x.persisted = true;
      });
      saves.defer(tabId, () =>
        queryAdd(query).catch((err) => {
          console.error("query save failed", err);
          saves.cancel(tabId);
          set((s) => {
            s.sources.data = s.sources.data.filter((q) => q.id !== tabId);
          });
          editQueryTab(tabId, (x) => {
            x.name = "";
            x.persisted = false;
          });
        }),
      );
      saves.flush(tabId);
    },
    duplicateQuery: (id) => {
      // Open a new *unsaved* tab copied from the source's working copy.
      // Nothing is written to the backend until the user saves it; it stays
      // out of the Sources list meanwhile. A query that isn't open (duplicated
      // from the explorer) is copied as saved.
      const source = selectQueryTab(get(), id);
      if (source) {
        openUnsavedTab(cloneDefinition(source.live));
        return;
      }
      const saved = get().sources.data.find((q) => q.id === id);
      if (saved) openUnsavedTab(definitionFromStored(saved.definition));
    },
    duplicatePlaylist: (id) => {
      const playlistId = playlistIdOf(id);
      if (playlistId === undefined) return;
      const listed = get().sources.data.find((x) => x.id === id);
      const t = selectPageTab(get(), id);
      const name = t?.name ?? listed?.name;
      if (name === undefined) return;
      // The working definition when it's open: its edits may not have been
      // written yet.
      const definition =
        t?.kind === "playlist"
          ? t.live
          : playlistDefinitionFromStored(listed?.definition ?? "");
      // In the original's write queue, so the entries read are the ones every
      // write already queued to it has left.
      void entryWrites
        .run(id, async () => {
          const entries = await fetchPlaylistEntries(playlistId);
          await createPlaylist(
            { name, folder: listed?.parent ?? null, definition },
            entries.map(({ track, position }) => ({ track, position })),
          );
        })
        .catch((err) => console.error("playlist duplicate failed", err));
    },
    convertToPlaylist: (tabId) => {
      const s = get();
      const t = selectQueryTab(s, tabId);
      const result = s.pages[tabId]?.result;
      if (!t || !result || !selectCanConvertToPlaylist(s, tabId)) return;
      // Every row that holds a track, in the order shown. (A row without one,
      // from an outer join, has nothing to list.)
      const tracks: string[] = [];
      for (let row = 0; row < result.rowCount; row++) {
        const id = selectTrackIdAt(s, tabId, row);
        if (id !== undefined) tracks.push(id);
      }
      const positions = sequentialPositions(tracks.length);
      // An unsaved query has no name to give it, and no folder yet: it's named
      // for the moment, as a new playlist is, and goes at the top level.
      const listed = t.persisted
        ? s.sources.data.find((x) => x.id === tabId)
        : undefined;
      void createPlaylist(
        {
          name: t.persisted ? t.name : nowName(),
          folder: listed?.parent ?? null,
          definition: playlistDefinitionFromQuery(
            t.live,
            selectEffectivePresets(s),
          ),
        },
        tracks.map((track, i) => ({ track, position: positions[i] })),
        tabId,
      );
    },
    newQueryTab: () => {
      openUnsavedTab(definitionForBase("track", selectEffectivePresets(get())));
    },
    openRecordsTab: (besideTabId, query) => {
      // Seeded from the table's defaults only for the display: the filter and
      // sort have to be exactly `query`'s, or the tab would show other records,
      // or show them in another order, than the ones it was opened on.
      const def = definitionForBase(query.base, selectEffectivePresets(get()));
      def.filter = { custom: query.filter, presets: [] };
      def.sort = { custom: query.sort };
      if (!("preset" in def.display)) def.display = { custom: query.display };
      const beside = get().tabs.findIndex((t) => t.id === besideTabId);
      openUnsavedTab(def, { index: beside === -1 ? undefined : beside + 1 });
    },
    showChildRecords: (tabId, parentTable, parents, childTable) => {
      const { tables } = get().schema;
      const field = buildFormFields(tables, parentTable).find(
        (f) => f.kind === "multiRecord" && f.table === childTable,
      );
      if (field?.kind !== "multiRecord") return;
      // What the children point back at is the parent's `id`, whatever its key.
      const ids = new Set<string>();
      for (const parent of parents) {
        const id = parent.key.find((k) => k.column === "id")?.value;
        if (id) ids.add(id);
      }
      if (ids.size === 0) return;
      actions.openRecordsTab(
        tabId,
        childRecordsTabQuery(
          field,
          [...ids],
          embedSpec(tables, field.table, field.column),
        ),
      );
    },

    // Only a saved source has a name of its own to rename; a settings tab's
    // handle text is fixed, and an unsaved query is named as it's saved, so
    // the rename affordances stand down for both.
    beginRename: (id) => {
      const t = selectPageTab(get(), id);
      if (t && selectIsPersisted(get(), id)) {
        set((s) => {
          s.renaming = { id, buffer: t.name };
        });
      }
    },
    setRenameBuffer: (text) =>
      set((s) => {
        if (s.renaming) s.renaming.buffer = text;
      }),
    commitRename: () => {
      const r = get().renaming;
      if (!r) return;
      const name = r.buffer.trim();
      const t = selectPageTab(get(), r.id);
      set((s) => {
        s.renaming = null;
      });
      if (name === "" || !t || t.name === name) return;
      editPageTab(r.id, (x) => {
        x.name = name;
      });
      void sourceRename({ id: r.id, name })
        .then(() => actions.loadSources())
        .catch((err) => console.error("source rename failed", err));
    },
    cancelRename: () =>
      set((s) => {
        s.renaming = null;
      }),

    requestDelete: (id) => {
      // The source may be open in a tab, or only listed in the explorer.
      const t = selectPageTab(get(), id);
      const listed = get().sources.data.find((q) => q.id === id);
      const name = t?.name ?? listed?.name;
      const kind = t?.kind ?? listed?.kind;
      if (name === undefined || kind === undefined) return;
      const unsaved = selectIsUnsaved(get(), id);
      set((s) => {
        s.pendingDelete = { id, kind, name, unsaved };
      });
    },
    confirmDelete: () => {
      const pending = get().pendingDelete;
      if (!pending) return;
      const { id } = pending;
      const persisted =
        selectQueryTab(get(), id)?.persisted ??
        get().sources.data.some((q) => q.id === id);
      const playlistId =
        pending.kind === "playlist" ? playlistIdOf(id) : undefined;
      set((s) => {
        s.pendingDelete = null;
        s.sources.data = s.sources.data.filter((q) => q.id !== id);
      });
      // Its pending edits would only be written to a source that's gone.
      saves.cancel(id);
      // Already gone from the list (above); only a failure needs the
      // backend's copy back.
      const restore = (err: unknown) => {
        console.error(`${pending.kind} delete failed`, err);
        void actions.loadSources();
      };
      if (playlistId !== undefined) {
        // Its entries first, as `dml`'s reference checks require — all of
        // them, read once every write already queued to them has landed.
        void entryWrites
          .run(id, async () => {
            const entries = await fetchPlaylistEntries(playlistId);
            await sendPlaylistWrites(
              deletePlaylistWrites(
                { sourceId: id, playlistId },
                entries.map((e) => e.id),
              ),
            );
          })
          .catch(restore);
      } else if (persisted) {
        // An unsaved query has no backend record to delete — just its tab.
        void queryDelete({ id }).catch(restore);
      }
      closeTab(id);
    },
    cancelDelete: () =>
      set((s) => {
        s.pendingDelete = null;
      }),

    toggleBuilderSection: (tabId, section) => {
      set((s) => {
        const open = s.pages[tabId]?.builderSection ?? null;
        // Any section toggle (open, close, switch) discards the ephemeral
        // expansion; in-progress edits live in `presetEdits` and survive.
        pageDraft(s, tabId).expandedPreset = null;
        pageDraft(s, tabId).builderSection = open === section ? null : section;
      });
    },
    focusBuilderSection: (tabId, section) => {
      set((s) => {
        pageDraft(s, tabId).expandedPreset = null;
      });
      // A full-mode query has no sections: the `query.focus_*` commands open the
      // one editor it does have, rather than doing nothing at all.
      if (selectQueryTab(get(), tabId)?.live.full != null) {
        set((s) => {
          pageDraft(s, tabId).fullEditorOpen = true;
          s.builderFocus = { tabId, section, seq: ++builderFocusSeq };
        });
        return;
      }
      set((s) => {
        pageDraft(s, tabId).builderSection = section;
        s.builderFocus = { tabId, section, seq: ++builderFocusSeq };
      });
    },
    clearBuilderFocus: () =>
      set((s) => {
        s.builderFocus = undefined;
      }),
    toggleFullEditor: (tabId) =>
      set((s) => {
        pageDraft(s, tabId).fullEditorOpen = !s.pages[tabId]?.fullEditorOpen;
      }),
    toggleExpandPreset: (tabId, presetId) => {
      set((s) => {
        const cur = s.pages[tabId]?.expandedPreset ?? null;
        pageDraft(s, tabId).expandedPreset = cur === presetId ? null : presetId;
      });
    },

    setBase: (tabId, table) => {
      const t = selectQueryTab(get(), tabId);
      if (!t) return;
      const live = t.live;
      // Re-picking the table a sectioned query already sits on is a no-op —
      // otherwise it would silently throw away the sort and display the user
      // built on it. (In full mode there's always something to do: leave it.)
      if (live.full == null && live.base === table) return;
      const rebased = rebasedDefinition(
        live,
        table,
        selectEffectivePresets(get()),
      );
      set((s) => {
        pageDraft(s, tabId).expandedPreset = null;
        pageDraft(s, tabId).fullEditorOpen = false;
      });
      replaceLive(tabId, rebased);
    },
    convertToFull: (tabId) => {
      const t = selectQueryTab(get(), tabId);
      if (!t) return;
      // Show the editor either way — for an already-full query that's all the
      // menu entry can still do.
      set((s) => {
        pageDraft(s, tabId).fullEditorOpen = true;
      });
      if (t.live.full != null) return;
      const full = toFullQuery(t.live, selectEffectivePresets(get()));
      set((s) => {
        pageDraft(s, tabId).expandedPreset = null;
        pageDraft(s, tabId).builderSection = null;
      });
      editQueryLive(tabId, (def) => {
        def.full = full;
      });
    },
    setFullText: (tabId, text) =>
      editQueryLive(
        tabId,
        (def) => {
          def.full = text;
        },
        "debounced",
      ),
    setFilterCustom: (tabId, text) =>
      editLive(
        tabId,
        (def) => {
          def.filter.custom = text;
        },
        "debounced",
      ),
    clearFilterCustom: (tabId) =>
      editLive(tabId, (def) => {
        def.filter.custom = "";
      }),
    toggleFilterPreset: (tabId, presetId) => {
      editLive(tabId, (def) => {
        if (def.filter.presets.includes(presetId)) {
          def.filter.presets = def.filter.presets.filter((p) => p !== presetId);
        } else {
          def.filter.presets.push(presetId);
        }
      });
      // Collapse the expansion if the now-removed preset was expanded.
      if (
        !selectPageTab(get(), tabId)?.live.filter.presets.includes(presetId) &&
        get().pages[tabId]?.expandedPreset === presetId
      ) {
        set((s) => {
          pageDraft(s, tabId).expandedPreset = null;
        });
      }
    },
    setSectionContent: (tabId, section, content) => {
      editLive(tabId, (def) => {
        def[section] = content;
      });
      set((s) => {
        pageDraft(s, tabId).expandedPreset = null;
      });
    },
    setSectionCustomText: (tabId, section, text) =>
      editLive(
        tabId,
        (def) => {
          def[section] = { custom: text };
        },
        "debounced",
      ),
    reshuffle: (tabId, section) =>
      editLive(tabId, (def) => {
        def[section] = shuffleContent();
      }),
    revertLive: (tabId) => {
      const t = selectQueryTab(get(), tabId);
      if (!t) return;
      set((s) => {
        pageDraft(s, tabId).expandedPreset = null;
      });
      replaceLive(tabId, cloneDefinition(t.saved));
    },

    undo: (tabId) => {
      if (selectIsWriting(get(), tabId)) return;
      // An edit still waiting on its debounced run is undone first: record it,
      // so it's there to redo.
      checkpoint(tabId);
      const from = get().pages[tabId]?.undo;
      const step = from && stepToUndo(from);
      if (from && step)
        traverseStep(tabId, from, step, stepBack(from), "revert");
    },
    redo: (tabId) => {
      if (selectIsWriting(get(), tabId) || !selectCanRedo(get(), tabId)) return;
      const from = get().pages[tabId]?.undo;
      const step = from && stepToRedo(from);
      if (from && step) {
        traverseStep(tabId, from, step, stepForward(from), "apply");
      }
    },
    writeStep: (tabId, prepare) =>
      entryWrites.run(tabId, async () => {
        let prepared: PreparedStep | undefined;
        try {
          prepared = await prepare();
          if (!prepared) return false;
          await sendPlaylistWrites(prepared.writes.apply);
        } catch (err) {
          console.error("playlist write failed", err);
          return false;
        }
        // Re-read after the awaits: the tab may have closed, or its definition
        // moved on, while the writes were in flight.
        if (!selectPageTab(get(), tabId)) return true;
        // An edit made while the writes were in flight went unrecorded
        // (`checkpoint` waits on them). It came first, so it's a step of its
        // own, before this one.
        recordLive(tabId);
        const before = selectPageTab(get(), tabId)?.live;
        const history = get().pages[tabId]?.undo;
        if (!before || !history) return true;
        const { edit } = prepared;
        const after = edit ? produce(before, (d) => edit(d)) : before;
        landHistory(
          tabId,
          pushStep(history, {
            writes: prepared.writes,
            definition: pageDefsEqual(before, after)
              ? undefined
              : { before, after },
          }),
          true,
        );
        return true;
      }),

    beginPresetEdit,
    patchPresetEdit: (id, patch) => {
      if (!get().presetEdits[id]) beginPresetEdit(id);
      set((s) => {
        Object.assign(s.presetEdits[id], patch);
      });
    },
    revertPresetEdit: (id) => beginPresetEdit(id),
    commitPresetEdit: (tabId, id) => {
      const edit = get().presetEdits[id];
      if (!edit) return;
      const name = edit.name.trim();
      if (name === "") return;
      const idx = get().presets.findIndex((p) => p.id === id);
      if (idx !== -1) {
        const modifiedAt = nowEpoch();
        set((s) => {
          Object.assign(s.presets[idx], {
            name,
            definition: edit.definition,
            isDefault: edit.isDefault,
            modifiedAt,
          });
        });
        void presetUpdate({
          id,
          name,
          definition: edit.definition,
          isDefault: edit.isDefault,
          modifiedAt,
        }).catch((err) => console.error("preset update failed", err));
      }
      // The edit now matches the saved preset; drop the buffer.
      set((s) => {
        delete s.presetEdits[id];
      });
      runQuery(tabId);
    },

    openPresetSave: (section, definition) =>
      set((s) => {
        s.presetSave = { section, definition, name: "", isDefault: false };
      }),
    cancelPresetSave: () =>
      set((s) => {
        s.presetSave = null;
      }),
    patchPresetSave: (patch) =>
      set((s) => {
        if (s.presetSave) Object.assign(s.presetSave, patch);
      }),
    confirmPresetSave: (tabId) => {
      const save = get().presetSave;
      if (!save || !selectPageTab(get(), tabId)) return;
      const name = save.name.trim();
      const base = selectPageBase(get(), tabId);
      if (name === "" || base === "") return;
      const now = nowEpoch();
      const preset: Preset = {
        id: newUuid(),
        name,
        baseTable: base,
        section: save.section,
        definition: save.definition,
        isDefault: save.isDefault,
        createdAt: now,
        modifiedAt: now,
      };
      set((s) => {
        s.presets.push(preset);
      });
      void presetAdd(preset).catch((err) =>
        console.error("preset add failed", err),
      );
      // Point the working definition at the new preset (mirrors `create_preset`).
      editLive(tabId, (def) => {
        if (save.section === "filter") {
          def.filter.custom = "";
          def.filter.presets.push(preset.id);
        } else {
          def[save.section] = { preset: preset.id };
        }
      });
      set((s) => {
        s.presetSave = null;
      });
    },
    openViewSql: (tabId) => {
      const t = selectPageTab(get(), tabId);
      const schemaJson = get().schema.json;
      if (!t || schemaJson === undefined) return;
      try {
        const { sql } = compilePage(t, schemaJson);
        set((s) => {
          s.viewSql = sql;
        });
      } catch (err) {
        set((s) => {
          s.viewSql = String(err instanceof Error ? err.message : err);
        });
      }
    },
    closeViewSql: () =>
      set((s) => {
        s.viewSql = null;
      }),
    openAbout: () =>
      set((s) => {
        s.aboutOpen = true;
      }),
    closeAbout: () =>
      set((s) => {
        s.aboutOpen = false;
      }),
    saveSetting: (key, value) => {
      const next = withSetting(get().settingOverrides, key, value);
      set((s) => {
        s.settingOverrides = next;
      });
      const stored = next[key];
      const persisted =
        stored === undefined
          ? settingDelete({ key })
          : settingSet({ key, value: stored });
      void persisted.catch((err) => console.error("setting save failed", err));
      // Every setting so far feeds the compiler, and the rows on screen were
      // compiled under the old value — so they're now stale. Re-run each open
      // page rather than leave results that no longer answer what they claim.
      for (const t of get().tabs) {
        if (t.kind === "query" || t.kind === "playlist") runQuery(t.id);
      }
    },
    openSetting: (key) =>
      set((s) => {
        s.settingEditor = key;
      }),
    closeSetting: () =>
      set((s) => {
        s.settingEditor = null;
      }),
    rescanCollection: async () => {
      if (get().rescanning) return;
      set((s) => {
        s.rescanning = true;
      });
      try {
        await collectionRescan();
      } catch (err) {
        console.error("collection rescan failed", err);
      } finally {
        set((s) => {
          s.rescanning = false;
        });
      }
    },

    reportRpcFailure: (method, error) => {
      if (UNREPORTED_METHODS.has(method)) return;
      const message = error instanceof Error ? error.message : String(error);
      set((s) => {
        const current = s.rpcError;
        s.rpcError =
          current?.method === method && current.message === message
            ? { method, message, count: current.count + 1 }
            : { method, message, count: 1 };
      });
    },
    dismissRpcError: () =>
      set((s) => {
        s.rpcError = null;
      }),
    noteRequest: (settled) => saves.track(settled),
    flushSaves: () => saves.flushAll(),
  };

  // A saved source restored with edits the backend never acknowledged (the
  // page went away before they were written, or the write failed) has them
  // saved now, as if they had just been made.
  for (const t of get().tabs) {
    if (t.kind === "shortcuts") continue;
    if (!pageDefsEqual(t.saved, t.live)) deferSave(t.id);
  }

  const dispose = () => {
    stopWatchingSystemTheme();
    stopPersistingTabs();
    for (const timer of runTimers.values()) clearTimeout(timer);
    runTimers.clear();
    saves.dispose();
  };

  return { actions, dispose };
}
