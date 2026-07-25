import {
  batch,
  createContext,
  createResource,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
  type Resource,
} from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import {
  presetAdd,
  presetList,
  presetUpdate,
  queryAdd,
  queryDelete,
  queryList,
  queryRecordPlay,
  queryRename,
  queryUpdateDefinition,
  type Preset,
  type Query,
} from "api-client";
import { runSql, runSqlScalar } from "../api/query";
import { fetchTrackMetadata, logPlay } from "../api/track";
import { AudioEngine } from "../audio/engine";
import {
  addInferredLinks,
  INTROSPECTION_SQL,
  parseSchemaTables,
} from "../query/schema";
import { compileSavedQuery } from "../query/compile";
import {
  cloneDefinition,
  defsEqual,
  definitionFromStored,
  definitionToStored,
  shuffleContent,
  type QueryDefinition,
  type Section,
  type SectionContent,
} from "../query/definition";
import { querydownReady } from "../query/querydown";
import {
  analyzeColumnSources,
  recordKeyColumns,
  trackIdColumn,
} from "../query/lineage";
import { buildResultFromArrow, type QueryResult } from "../query/result";
import { isListLikeValue, isListType, stringifyArrowValue } from "../api/query";
import type { Table } from "apache-arrow";

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
const SHORTCUTS_TAB_NAME = "Keyboard Shortcuts";

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
 * `kind` / `id` / `name` fields, and only {@link AppStore.queryTab} narrows to
 * the query-only state. */
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
 * signal rather than store state: it's a one-shot event, and `seq` makes two
 * locates of the *same* row still register as two events. */
export interface RowReveal {
  tabId: string;
  row: number;
  seq: number;
}

/** A one-shot request to open a builder section *and* put the caret in its
 * custom input — what the `query.focus_*` commands do. Carried as a signal
 * rather than store state for the same reason as {@link RowReveal}: it's an
 * event, and the builder consumes it. */
export interface BuilderFocus {
  tabId: string;
  section: Section;
  seq: number;
}

/** A table whose records this tab's result rows identify, with the key values
 * carried by each row — the lineage analysis's output, cached per tab.
 *
 * Values are snapshotted from the Arrow table at analysis time (as the track ids
 * are) rather than read back from `QueryResult`, which holds only *visible*
 * columns and only their formatted text: a query's id columns are usually hidden
 * and would be gone by then. */
export interface RecordTarget {
  /** The table a row of these results stands for. */
  table: string;
  /** The columns identifying one of its records, in constraint order. */
  keyColumns: readonly string[];
  /** Per row, the key values parallel to `keyColumns` (`null` for a NULL cell). */
  keyValues: readonly (readonly (string | null)[])[];
}

/** One record identified by a result row: the table plus a fully-resolved key.
 * What the context menu offers and the record editor opens. */
export interface RecordRef {
  table: string;
  /** The identifying column/value pairs, in constraint order. */
  key: readonly { column: string; value: string }[];
}

export interface AppState {
  sidebarOpen: boolean; // explorer open/closed (persisted, like theme)
  theme: ThemePref; // light/dark/system (persisted), drives the `data-theme` attribute
  tabs: Tab[]; // open tabs, in tab-bar order
  activeTabId: string | null;
  queryFilter: string; // "Filter" input text in the Queries section
  openedCollapsed: boolean; // "Opened" section disclosure
  queriesCollapsed: boolean; // "Queries" section disclosure
  /** Per-tab decoded, render-ready results, keyed by tab id. */
  resultsByTab: Record<string, QueryResult>;
  /** Per-tab result-row selection: a set of row indexes. Replaced wholesale on
   * every change so subscribers observe a new reference; cleared when the
   * tab's result changes. */
  selectionByTab: Record<string, ReadonlySet<number>>;
  /** Per-tab per-row track ids, present only when the query's rows represent
   * tracks (a column traces to `track.id`). Indexed by row; drives
   * double-click-to-play. Absent/empty when the query isn't track-based. */
  trackIdsByTab: Record<string, readonly (string | null)[]>;
  /** Per-tab record targets from the lineage analysis: the tables whose primary
   * keys this tab's rows carry, and each row's key values. Drives the results
   * context menu's "Edit {table}" entries. Empty when the rows identify nothing
   * editable. */
  recordTargetsByTab: Record<string, readonly RecordTarget[]>;
  /** The record open in each tab's record-editor sidebar (`null`/absent when the
   * sidebar is closed). Per-tab — the sidebar belongs to the query page, so
   * switching tabs switches editors. */
  recordEditorByTab: Record<string, RecordRef | null>;
  /** Whether a run is in flight, keyed by tab id (errors are console-only). */
  runningByTab: Record<string, boolean>;
  /** The open builder section per tab (null = builder closed). */
  builderSectionByTab: Record<string, Section | null>;
  /** The expanded preset id per tab (null = none expanded). */
  expandedPresetByTab: Record<string, string | null>;
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
  /** The track in the now-playing bar (null when nothing is loaded). */
  currentTrack: CurrentTrack | null;
  /** Transport state for that track. */
  playback: PlaybackState;
}

const SIDEBAR_KEY = "sidebarOpen";

function storedSidebarOpen(): boolean {
  try {
    const v = localStorage.getItem(SIDEBAR_KEY);
    if (v === "true") return true;
    if (v === "false") return false;
  } catch {
    // Private-mode localStorage denial — fall back to the default.
  }
  return false;
}

function persistSidebar(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? "true" : "false");
  } catch {
    // ignore
  }
}

/** "system" follows `prefers-color-scheme` (no stored key); "light"/"dark" is an
 * explicit override, persisted and mirrored onto `<html data-theme>`. */
export type ThemePref = "light" | "dark" | "system";

const THEME_KEY = "theme";

function storedTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // Private-mode localStorage denial — fall back to system.
  }
  return "system";
}

function persistTheme(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // ignore
  }
}

/** Mirrors index.html's pre-paint bootstrap script: an explicit theme sets
 * `data-theme` (which app.css's attribute selectors read) and the dynamic
 * `theme-color` meta; "system" reverts to the static, media-queried metas. The
 * bootstrap script's own meta (unmarked by `media`) is reused here rather than
 * duplicated. */
function applyThemeToDocument(pref: ThemePref): void {
  if (pref === "system") {
    document.documentElement.removeAttribute("data-theme");
    document.head
      .querySelector('meta[name="theme-color"]:not([media])')
      ?.remove();
    return;
  }
  document.documentElement.setAttribute("data-theme", pref);
  let meta = document.head.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]:not([media])',
  );
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = pref === "dark" ? "#1b1b1b" : "#f8f8f8";
}

/** Width bounds for the record-editor sidebar, in CSS px. The maximum is also
 * capped against the live viewport while dragging (see `RecordEditorPanel`), so
 * these are just the absolute limits a persisted value is trusted within. */
export const RECORD_SIDEBAR_MIN_WIDTH = 240;
export const RECORD_SIDEBAR_MAX_WIDTH = 800;
const RECORD_SIDEBAR_DEFAULT_WIDTH = 340;
const RECORD_SIDEBAR_KEY = "recordSidebarWidth";

export function clampRecordSidebarWidth(px: number): number {
  return Math.max(
    RECORD_SIDEBAR_MIN_WIDTH,
    Math.min(RECORD_SIDEBAR_MAX_WIDTH, Math.round(px)),
  );
}

function storedRecordSidebarWidth(): number {
  try {
    const v = Number(localStorage.getItem(RECORD_SIDEBAR_KEY));
    if (Number.isFinite(v) && v > 0) return clampRecordSidebarWidth(v);
  } catch {
    // Private-mode localStorage denial — fall back to the default.
  }
  return RECORD_SIDEBAR_DEFAULT_WIDTH;
}

function persistRecordSidebarWidth(px: number): void {
  try {
    localStorage.setItem(RECORD_SIDEBAR_KEY, String(px));
  } catch {
    // ignore
  }
}

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

/** Trailing debounce applied to the query re-run that follows a text edit in
 * the builder, so a run fires once the user pauses rather than on every
 * keystroke. */
const RUN_DEBOUNCE_MS = 300;

/** A shared frozen empty set for tabs with no selection, so `rowSelection` returns
 * a stable reference (no per-call allocation, no spurious effect re-runs). */
const EMPTY_SELECTION: ReadonlySet<number> = new Set<number>();

export interface AppStore {
  state: AppState;
  /** The saved-query list resource (loads via `query.list`). */
  queries: Resource<Query[]>;
  refetchQueries: () => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  /** Sets the theme override ("system" clears it) — the Settings menu's action. */
  setTheme: (pref: ThemePref) => void;
  /** Open (or focus) a query in a tab. */
  openTab: (query: { id: string; name: string; definition: string }) => void;
  /** Open (or focus) the singleton Keyboard Shortcuts tab — the
   * `shortcuts.configure` command's and the Settings menu's action. */
  openShortcutsTab: () => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  reorderTab: (id: string, toIndex: number) => void;
  setQueryFilter: (text: string) => void;
  toggleOpenedCollapsed: () => void;
  toggleQueriesCollapsed: () => void;
  /** Whether the introspection schema has loaded (compiles can proceed). */
  schemaReady: () => boolean;
  /** Compile + run the tab's *working* query, storing the structured result. */
  runQuery: (tabId: string) => void;
  /** Run the tab once, the first time it's viewed (idempotent per tab). */
  ensureRun: (tabId: string) => void;
  /** Inject a canned structured result for a tab (dev/test seam — bypasses the
   * compile/fetch/decode path). `trackIds` and `recordTargets` stand in for the
   * lineage analysis, making the rows playable / editable without a real
   * compile. */
  setResults: (
    tabId: string,
    result: QueryResult,
    trackIds?: readonly (string | null)[],
    recordTargets?: readonly RecordTarget[],
  ) => void;
  /** Overwrite a tab's saved/working definitions directly (dev/test seam —
   * lets the harness reach a specific builder state without a backend). */
  setTabDefinitions: (
    tabId: string,
    saved: QueryDefinition,
    live: QueryDefinition,
  ) => void;

  /** The tab with `id`, whatever kind of page it holds, if open. */
  tab: (tabId: string) => Tab | undefined;
  /** The tab with `id` when it's a *query* tab — the narrowing every consumer of
   * a query's definitions goes through, so a non-query tab reads as absent
   * rather than as an empty query. */
  queryTab: (tabId: string) => QueryTab | undefined;
  /** Whether a tab has unsaved changes: an ephemeral (never-saved) query tab
   * always, else a persisted one whose working def differs from its saved def.
   * Drives the Save button and the ✱ markers. Never true for a non-query tab —
   * the shortcuts editor writes its bindings through immediately. */
  isUnsaved: (tabId: string) => boolean;
  /** Whether "Revert changes" applies: a persisted tab with edits to discard (an
   * ephemeral tab has no saved baseline to revert to). */
  canRevert: (tabId: string) => boolean;
  /** The result row count for a tab, if it has run. */
  resultCount: (tabId: string) => number | undefined;

  // Result-row selection + interaction.
  /** The tab's selected row indexes (empty set when nothing is selected). */
  rowSelection: (tabId: string) => ReadonlySet<number>;
  /** Apply a click on result row `index`, updating the selection: Shift extends a
   * range from the anchor, Ctrl/Cmd toggles the row, a plain click selects it
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
  /** The records result row `index` identifies — one per table whose primary key
   * the row carries in full, in result-column order. Empty when the lineage
   * analysis found none (or hasn't finished), which is what leaves the row's
   * context menu with nothing to offer. */
  rowRecords: (tabId: string, index: number) => RecordRef[];

  // The record editor (a sidebar within the query page).
  /** The record open in `tabId`'s record-editor sidebar, or `null` when closed. */
  recordEditor: (tabId: string) => RecordRef | null;
  /** Open (or re-point) `tabId`'s record-editor sidebar on `record`. */
  openRecordEditor: (tabId: string, record: RecordRef) => void;
  /** Close `tabId`'s record-editor sidebar. */
  closeRecordEditor: (tabId: string) => void;
  /** The record-editor sidebar's width in CSS px — app-level (shared by every
   * query page) and persisted, like the explorer's open state. */
  recordSidebarWidth: Accessor<number>;
  /** Set that width while dragging the resize handle; clamped, not persisted. */
  setRecordSidebarWidth: (px: number) => void;
  /** Persist the current width — called once when a drag ends, so a drag writes
   * to localStorage once rather than on every pointer move. */
  commitRecordSidebarWidth: () => void;

  // Playback (the now-playing bar).
  /** Play the track at result row `index` of `tabId`, with the rows before and
   * after it as the previous/next context. A no-op for non-track rows. */
  playRow: (tabId: string, index: number) => void;
  /** Pause if playing, resume if paused. */
  togglePlayPause: () => void;
  /** Skip to the next queued track (the bar's "Next"). */
  skipNext: () => void;
  /** Dismiss the bar: stop playback and tear down the queue (the bar's "Close"). */
  stopPlayback: () => void;
  /** Jump to the playing track's row: activate its source tab, select the row and
   * scroll it into view (the bar's "Locate"). */
  locateCurrentTrack: () => void;
  /** The pending "scroll this row into view" request, consumed by the results
   * grid. `undefined` when there is none. */
  rowReveal: Accessor<RowReveal | undefined>;
  /** Seed the now-playing bar without touching the audio engine (dev/test seam —
   * lets the harness snapshot the bar with no backend or audio). */
  seedNowPlaying: (track: CurrentTrack, playback: PlaybackState) => void;

  // Query-level backend actions.
  /** Persist the tab's working definition (`query.update_definition`), then mark
   * it saved so the unsaved indicator clears. */
  saveQuery: (tabId: string) => void;
  /** Create a persisted copy of query `id` (from its live definition) and open
   * it in a new tab. */
  duplicateQuery: (id: string) => void;

  // Inline rename.
  /** Begin renaming query `id`, seeding the buffer with its current name. */
  beginRename: (id: string) => void;
  /** Update the in-progress rename buffer. */
  setRenameBuffer: (text: string) => void;
  /** Commit the in-progress rename (`query.rename`); an empty name cancels. */
  commitRename: () => void;
  /** Abandon the in-progress rename. */
  cancelRename: () => void;

  // Delete confirmation.
  /** Open the delete-confirmation modal for query `id`. */
  requestDelete: (id: string) => void;
  /** Confirm the pending delete (`query.delete` + close its tab). */
  confirmDelete: () => void;
  /** Dismiss the delete-confirmation modal. */
  cancelDelete: () => void;

  /** The open builder section for a tab (null when the builder is closed). */
  builderSection: (tabId: string) => Section | null;
  /** Toggle a builder section open/closed (opening switches sections). */
  toggleBuilderSection: (tabId: string, section: Section) => void;
  /** Open a builder section (never closing it, unlike the toggle) and ask it to
   * take the caret — the `query.focus_*` commands' action. */
  focusBuilderSection: (tabId: string, section: Section) => void;
  /** The pending focus request, consumed by the builder that owns it.
   * `undefined` when there is none. */
  builderFocus: Accessor<BuilderFocus | undefined>;
  /** Clear the pending focus request once it has been applied. */
  clearBuilderFocus: () => void;
  /** The expanded preset id for a tab (null when none). */
  expandedPreset: (tabId: string) => string | null;
  /** Toggle a preset's inline editor open/closed. */
  toggleExpandPreset: (tabId: string, presetId: string) => void;

  // Working-definition mutators (all re-run the query).
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

  // Presets.
  presetName: (id: string) => string;
  presetsFor: (baseTable: string, section: Section) => Preset[];
  presetDirty: (id: string) => boolean;
  presetEdit: (id: string) => PresetEdit | undefined;
  beginPresetEdit: (id: string) => void;
  patchPresetEdit: (id: string, patch: Partial<PresetEdit>) => void;
  revertPresetEdit: (id: string) => void;
  commitPresetEdit: (tabId: string, id: string) => void;

  // Modals.
  openPresetSave: (section: Section, definition: string) => void;
  cancelPresetSave: () => void;
  patchPresetSave: (patch: Partial<PresetSave>) => void;
  confirmPresetSave: (tabId: string) => void;
  openViewSql: (tabId: string) => void;
  closeViewSql: () => void;
}

function createAppStore(): AppStore {
  const [state, setState] = createStore<AppState>({
    sidebarOpen: storedSidebarOpen(),
    theme: storedTheme(),
    tabs: [],
    activeTabId: null,
    queryFilter: "",
    openedCollapsed: false,
    queriesCollapsed: false,
    resultsByTab: {},
    selectionByTab: {},
    trackIdsByTab: {},
    recordTargetsByTab: {},
    recordEditorByTab: {},
    runningByTab: {},
    builderSectionByTab: {},
    expandedPresetByTab: {},
    presets: [],
    presetEdits: {},
    presetSave: null,
    viewSql: null,
    renaming: null,
    pendingDelete: null,
    currentTrack: null,
    playback: { playing: false, position: 0, duration: null, hasNext: false },
  });

  const [queries, { refetch }] = createResource<Query[]>(async () => {
    return await queryList();
  });

  // Presets load once, then live in the mutable store (above) so local edits and
  // "Save as preset" can add/update them without a refetch.
  createResource<Preset[]>(async () => {
    const loaded = await presetList();
    setState("presets", loaded);
    return loaded;
  });

  // The enriched introspection schema JSON — run the introspection SQL, read the
  // single JSON cell, apply RadioCrate's link inference. Cached for the session.
  const [schema] = createResource<string>(async () => {
    const raw = await runSqlScalar(INTROSPECTION_SQL);
    return addInferredLinks(raw);
  });

  const setSidebarOpen = (open: boolean) => {
    setState("sidebarOpen", open);
    persistSidebar(open);
  };

  const setTheme = (pref: ThemePref) => {
    setState("theme", pref);
    persistTheme(pref);
    applyThemeToDocument(pref);
  };

  // The record-editor sidebar's width: a plain signal (no per-tab state — every
  // query page's sidebar shares one width), persisted on drag end.
  const [recordSidebarWidth, setRecordSidebarWidthSignal] = createSignal(
    storedRecordSidebarWidth(),
  );

  // The `query.focus_*` commands hand the open builder a "take the caret"
  // request through this signal; the builder clears it once applied.
  const [builderFocus, setBuilderFocus] = createSignal<
    BuilderFocus | undefined
  >();
  let builderFocusSeq = 0;

  const tab = (tabId: string): Tab | undefined =>
    state.tabs.find((t) => t.id === tabId);

  const queryTab = (tabId: string): QueryTab | undefined => {
    const t = tab(tabId);
    return t?.kind === "query" ? t : undefined;
  };

  /** Mutates a query tab in place through a mutator, a no-op when `tabId` isn't
   * an open query tab. Every write to a query tab's fields goes through here:
   * `tabs` holds a union of page kinds, so the narrowing has to happen inside the
   * update rather than in a store path. */
  const editQueryTab = (tabId: string, mutate: (t: QueryTab) => void) => {
    setState(
      "tabs",
      produce((tabs) => {
        const t = tabs.find((x) => x.id === tabId);
        if (t?.kind === "query") mutate(t);
      }),
    );
  };

  /** The preset list to run/preview against: each saved preset overlaid with any
   * in-progress edit, so results reflect pending preset changes before they're
   * committed. */
  const effectivePresets = (): Preset[] =>
    state.presets.map((p) => {
      const edit = state.presetEdits[p.id];
      return edit
        ? {
            ...p,
            name: edit.name,
            definition: edit.definition,
            isDefault: edit.isDefault,
          }
        : p;
    });

  // Tabs that have been auto-run once (the "have I run this tab yet" guard).
  const autoRun = new Set<string>();

  // Per-tab selection anchor: the fixed end a Shift-click range grows from (and
  // that a plain/Ctrl click re-plants). Non-reactive — only the resulting
  // `selectionByTab` set drives the paint.
  const rowClickAnchor = new Map<string, number>();

  // Per-tab selection lead: the moving end — the row an arrow-key step counts
  // from. Split from the anchor so Shift+Arrow after a Shift+click keeps
  // growing the same range.
  const rowSelectionLead = new Map<string, number>();

  // Monotonic per-tab run token, so a slow lineage analysis (WASM load) from a
  // superseded run can't clobber a newer run's track-id mapping.
  const runTokens = new Map<string, number>();
  let runTokenSeq = 0;

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

  /** Installs a tab's decoded result, forcing a fresh object reference.
   *
   * Solid shallow-*merges* an object assigned at a store leaf that already holds
   * one — it mutates the existing object in place rather than swapping the
   * reference. `QueryResults` drives the canvas from an effect that tracks the
   * result's *identity*, so an in-place merge updates the data but never notifies
   * that effect: the grid keeps its stale reference and only repaints when some
   * other event (a resize) forces a draw. Deleting the key first (a non-object
   * set can't merge) makes the following set install a new reference that does
   * notify. Both writes are synchronous, so Solid batches them and subscribers
   * only ever observe the final result — no transient clear. */
  const setTabResult = (tabId: string, result: QueryResult) => {
    batch(() => {
      setState(
        "resultsByTab",
        produce((m) => {
          delete m[tabId];
        }),
      );
      setState("resultsByTab", tabId, result);
      // New rows invalidate the old selection and any prior lineage mappings (the
      // latter are repopulated asynchronously by `analyzeLineage`).
      setState(
        "selectionByTab",
        produce((m) => {
          delete m[tabId];
        }),
      );
      setState(
        "trackIdsByTab",
        produce((m) => {
          delete m[tabId];
        }),
      );
      setState(
        "recordTargetsByTab",
        produce((m) => {
          delete m[tabId];
        }),
      );
      // The playing track's row belonged to the rows just replaced; it's
      // re-located once the new mapping lands (see `analyzeLineage`).
      if (state.currentTrack?.sourceTabId === tabId) {
        setState("currentTrack", "rowIndex", null);
      }
    });
    rowClickAnchor.delete(tabId);
    rowSelectionLead.delete(tabId);
  };

  /** Reads one Arrow column out as per-row strings (`null` for a NULL cell). */
  const columnValues = (table: Table, col: number): (string | null)[] => {
    const vector = table.getChildAt(col);
    const values: (string | null)[] = new Array<string | null>(table.numRows);
    for (let r = 0; r < table.numRows; r++) {
      const v = vector?.get(r);
      values[r] = v == null ? null : stringifyArrowValue(v);
    }
    return values;
  };

  /** Whether an Arrow column holds lists rather than scalars. A list column can
   * still trace back to an id (an aggregated `[artist.id, …]`), but a list of
   * ids identifies no single record — so it can't serve as a key. Detected as
   * in `buildResultFromArrow`: by type, falling back to the first non-null
   * value for the DuckDB list types apache-arrow 18 can't classify. */
  const isListColumn = (table: Table, col: number): boolean => {
    const field = table.schema.fields[col];
    if (field && isListType(field.type)) return true;
    const vector = table.getChildAt(col);
    if (!vector) return false;
    for (let r = 0; r < table.numRows; r++) {
      const v = vector.get(r);
      if (v != null) return isListLikeValue(v);
    }
    return false;
  };

  /** Off the critical path: traces the compiled SQL's output columns back to
   * their source table columns, then caches the two things the rows' affordances
   * need — the per-row `track.id` values (double-click plays) and, per table
   * whose primary key the rows carry, that key's per-row values (right-click
   * edits the record). Both are read out of the Arrow table here, once, rather
   * than from the decoded `QueryResult`, whose hidden columns are gone.
   *
   * Guarded by `token` so a superseded run can't win a race; a query with no
   * traceable ids simply leaves both mappings cleared (`setTabResult` already
   * dropped the previous run's). */
  const analyzeLineage = async (
    tabId: string,
    sql: string,
    table: Table,
    token: number,
  ) => {
    const sources = await analyzeColumnSources(sql);
    if (runTokens.get(tabId) !== token) return; // a newer run superseded this one
    if (!sources) return; // unparseable — no affordances
    const schemaJson = schema();

    // Likewise a list of track ids isn't a playable row.
    const trackCol = trackIdColumn(sources);
    const playable = trackCol !== undefined && !isListColumn(table, trackCol);
    const targets: RecordTarget[] = schemaJson
      ? recordKeyColumns(sources, parseSchemaTables(schemaJson))
          // A key whose value arrives as a list identifies no one record.
          .filter((k) => !k.keyIndices.some((i) => isListColumn(table, i)))
          .map((k) => {
            const columns = k.keyIndices.map((i) => columnValues(table, i));
            return {
              table: k.table,
              keyColumns: k.keyColumns,
              // Transpose column-major reads into one key tuple per row.
              keyValues: Array.from({ length: table.numRows }, (_, r) =>
                columns.map((values) => values[r]),
              ),
            };
          })
      : [];

    batch(() => {
      if (playable) {
        setState("trackIdsByTab", tabId, columnValues(table, trackCol));
      }
      if (targets.length > 0) setState("recordTargetsByTab", tabId, targets);
    });
    if (!playable) return;
    // Re-locate the playing track's row in the rows that just landed, so
    // "Locate" keeps working after the tab is re-run (mirrors
    // `maybe_revalidate_current_track_index`).
    const ct = state.currentTrack;
    if (ct?.sourceTabId === tabId) {
      setState("currentTrack", "rowIndex", locateRow(tabId, ct.id));
    }
  };

  const runQuery = (tabId: string) => {
    const t = queryTab(tabId);
    if (!t) return;
    // An immediate run supersedes any run this tab had pending on the debounce.
    cancelScheduledRun(tabId);
    autoRun.add(tabId);
    const token = ++runTokenSeq;
    runTokens.set(tabId, token);
    setState("runningByTab", tabId, true);
    void (async () => {
      try {
        await querydownReady();
        const schemaJson = schema();
        if (schemaJson === undefined) return;
        const def = unwrap(t.live);
        const { sql, columnAnnotations } = compileSavedQuery(
          def,
          effectivePresets(),
          schemaJson,
        );
        const table = await runSql(sql);
        // Decode + precompute the render-ready result once, here — never per
        // resize/frame (§6).
        setTabResult(tabId, buildResultFromArrow(table, columnAnnotations));
        // Then, off the critical path, figure out what these rows *are* — tracks
        // to play, records to edit. Deliberately not awaited: the results are
        // already shown, and the WASM lineage analysis is heavy.
        void analyzeLineage(tabId, sql, table, token);
      } catch (err) {
        // No error UI this phase — console only (see plan non-goals).
        console.error("query run failed", err);
      } finally {
        setState("runningByTab", tabId, false);
      }
    })();
  };

  /** Mutate a tab's working definition through a mutator, then re-run. */
  const editLive = (tabId: string, mutate: (def: QueryDefinition) => void) => {
    if (!queryTab(tabId)) return;
    editQueryTab(tabId, (t) => mutate(t.live));
    runQuery(tabId);
  };

  /** Like {@link editLive}, but the state update is applied immediately (so the
   * controlled input and the unsaved indicator stay in sync) while the query
   * re-run is debounced. For the builder's free-text editors. */
  const editLiveDebounced = (
    tabId: string,
    mutate: (def: QueryDefinition) => void,
  ) => {
    if (!queryTab(tabId)) return;
    editQueryTab(tabId, (t) => mutate(t.live));
    scheduleRun(tabId);
  };

  const presetName = (id: string): string =>
    state.presets.find((p) => p.id === id)?.name ?? "(missing preset)";

  const presetDirty = (id: string): boolean => {
    const edit = state.presetEdits[id];
    if (!edit) return false;
    const saved = state.presets.find((p) => p.id === id);
    if (!saved) return true;
    return (
      saved.name !== edit.name ||
      saved.definition !== edit.definition ||
      saved.isDefault !== edit.isDefault
    );
  };

  const beginPresetEdit = (id: string) => {
    const preset = state.presets.find((p) => p.id === id);
    if (!preset) return;
    setState("presetEdits", id, {
      name: preset.name,
      definition: preset.definition,
      isDefault: preset.isDefault,
    });
  };

  /** Closes the tab `id`, dropping its cached state and selecting a neighbor.
   * Standalone (not just an object method) so backend actions like delete can
   * reuse it. Kind-agnostic: the per-tab maps it clears are query-only, and
   * dropping keys a settings tab never had is a no-op. */
  const closeTab = (id: string) => {
    setState(
      produce((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return;
        s.tabs.splice(idx, 1);
        delete s.resultsByTab[id];
        delete s.selectionByTab[id];
        delete s.trackIdsByTab[id];
        delete s.recordTargetsByTab[id];
        delete s.recordEditorByTab[id];
        delete s.runningByTab[id];
        delete s.builderSectionByTab[id];
        delete s.expandedPresetByTab[id];
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
      }),
    );
    autoRun.delete(id);
    cancelScheduledRun(id);
    rowClickAnchor.delete(id);
    rowSelectionLead.delete(id);
    runTokens.delete(id);
  };

  // ── Playback ────────────────────────────────────────────────────────────────

  // The audio engine, built on the first play so a session that never plays
  // anything creates no <audio> element and claims no OS media session.
  let audio: AudioEngine | undefined;
  const engine = (): AudioEngine =>
    (audio ??= new AudioEngine({
      onTrackChange: (id) => reconcileTrackChange(id),
      onPlayCompleted: (id) => logPlay(id),
      onQueueDry: () => clearNowPlaying(),
      onTransport: () => syncTransport(),
    }));

  /** Mirrors the engine's transport state into the store for the bar to render.
   * The engine stays the source of truth; this is a projection of it. */
  const syncTransport = () => {
    if (!audio) return;
    setState("playback", {
      playing: audio.isPlaying,
      position: audio.position,
      duration: audio.duration,
      hasNext: audio.hasNext,
    });
  };

  // "Locate" hands the results grid a scroll request through this signal (see
  // `RowReveal`); `seq` distinguishes repeat locates of the same row.
  const [rowReveal, setRowReveal] = createSignal<RowReveal | undefined>();
  let revealSeq = 0;

  /** The playable track id at `index` of `tabId`'s results, if the rows are
   * tracks and that one carries an id. */
  const trackIdAt = (tabId: string, index: number): string | undefined => {
    const id = state.trackIdsByTab[tabId]?.[index];
    return id == null || id === "" ? undefined : id;
  };

  /** Snapshots `tabId`'s results around row `index` into the play context the
   * engine navigates. `preceding` is every playable id before `index` (nearest
   * last, for "previous"); `upcoming` is the contiguous run of ids after it,
   * stopping at the first row without one (mirrors `playlist_around`). */
  const playlistAround = (
    tabId: string,
    index: number,
  ): { preceding: string[]; upcoming: string[] } => {
    const ids = state.trackIdsByTab[tabId] ?? [];
    const preceding: string[] = [];
    for (let i = 0; i < Math.min(index, ids.length); i++) {
      const id = ids[i];
      if (id != null && id !== "") preceding.push(id);
    }
    const upcoming: string[] = [];
    for (let i = index + 1; i < ids.length; i++) {
      const id = ids[i];
      if (id == null || id === "") break;
      upcoming.push(id);
    }
    return { preceding, upcoming };
  };

  /** Finds the row index of `id` within `tabId`'s current results, if present.
   * Capped so a huge result set can't stall a transition. */
  const locateRow = (tabId: string, id: string): number | null => {
    const ids = state.trackIdsByTab[tabId];
    if (!ids) return null;
    const limit = Math.min(ids.length, 1000);
    for (let i = 0; i < limit; i++) if (ids[i] === id) return i;
    return null;
  };

  /** Fetches the track's title/artists, then fills them into the bar and pushes
   * them to the OS media session — but only while that track is still the
   * current one, so a fetch overtaken by an auto-advance is discarded. */
  const loadMetadata = async (id: string) => {
    const meta = await fetchTrackMetadata(id);
    if (!meta || state.currentTrack?.id !== id) return;
    setState("currentTrack", { title: meta.title, artists: meta.artists });
    audio?.setMetadata(
      meta.title,
      meta.artists.length > 0 ? meta.artists.join(", ") : null,
    );
  };

  /** Records a play against `tabId`'s saved query (bumps `last_play`). Skipped
   * for an ephemeral tab, which has no backend row yet. */
  const recordQueryPlay = (tabId: string) => {
    if (!queryTab(tabId)?.persisted) return;
    void queryRecordPlay({ id: tabId, lastPlay: nowEpoch() }).catch((err) =>
      console.error("record play failed", err),
    );
  };

  /** Folds a track change that originated in the engine (an auto-advance when a
   * track ended, or a lock-screen / headset skip) into the bar: swaps the track,
   * re-locates its row, refetches metadata, and records the play. The engine owns
   * the queue across these transitions, so there's nothing to re-sync there. */
  const reconcileTrackChange = (newId: string) => {
    const source = state.currentTrack?.sourceTabId ?? null;
    if (!state.currentTrack) return;
    setState("currentTrack", {
      id: newId,
      rowIndex: source === null ? null : locateRow(source, newId),
      title: null,
      artists: [],
    });
    void loadMetadata(newId);
    if (source !== null) recordQueryPlay(source);
    syncTransport();
  };

  /** Tears down playback and empties the bar. */
  const clearNowPlaying = () => {
    audio?.stop();
    setState("currentTrack", null);
    syncTransport();
  };

  const playRow = (tabId: string, index: number) => {
    const id = trackIdAt(tabId, index);
    if (id === undefined) return;
    const { preceding, upcoming } = playlistAround(tabId, index);
    setState("currentTrack", {
      sourceTabId: tabId,
      id,
      rowIndex: index,
      title: null,
      artists: [],
    });
    engine().setPlaylist(preceding, id, upcoming);
    syncTransport();
    void loadMetadata(id);
    recordQueryPlay(tabId);
  };

  return {
    state,
    queries,
    refetchQueries: () => void refetch(),
    toggleSidebar: () => setSidebarOpen(!state.sidebarOpen),
    setSidebarOpen,
    setTheme,
    openTab: (query) => {
      if (!state.tabs.some((t) => t.id === query.id)) {
        const saved = definitionFromStored(query.definition);
        setState("tabs", state.tabs.length, {
          kind: "query",
          id: query.id,
          name: query.name,
          saved,
          live: cloneDefinition(saved),
          persisted: true,
        });
      }
      setState("activeTabId", query.id);
    },
    openShortcutsTab: () => {
      // A singleton: a second request focuses the tab that's already open.
      if (!state.tabs.some((t) => t.kind === "shortcuts")) {
        setState("tabs", state.tabs.length, {
          kind: "shortcuts",
          id: SHORTCUTS_TAB_ID,
          name: SHORTCUTS_TAB_NAME,
        });
      }
      setState("activeTabId", SHORTCUTS_TAB_ID);
    },
    closeTab,
    selectTab: (id) => setState("activeTabId", id),
    reorderTab: (id, toIndex) => {
      setState(
        produce((s) => {
          const from = s.tabs.findIndex((t) => t.id === id);
          if (from === -1) return;
          const clamped = Math.max(0, Math.min(toIndex, s.tabs.length - 1));
          if (from === clamped) return;
          const [moved] = s.tabs.splice(from, 1);
          s.tabs.splice(clamped, 0, moved);
        }),
      );
    },
    setQueryFilter: (text) => setState("queryFilter", text),
    toggleOpenedCollapsed: () =>
      setState("openedCollapsed", !state.openedCollapsed),
    toggleQueriesCollapsed: () =>
      setState("queriesCollapsed", !state.queriesCollapsed),
    schemaReady: () => schema.state === "ready",
    runQuery,
    ensureRun: (tabId) => {
      if (!autoRun.has(tabId)) runQuery(tabId);
    },
    setResults: (tabId, result, trackIds, recordTargets) => {
      setTabResult(tabId, result);
      if (trackIds) setState("trackIdsByTab", tabId, trackIds);
      if (recordTargets) setState("recordTargetsByTab", tabId, recordTargets);
    },
    setTabDefinitions: (tabId, saved, live) => {
      editQueryTab(tabId, (t) => {
        t.saved = saved;
        t.live = cloneDefinition(live);
      });
    },

    tab,
    queryTab,
    isUnsaved: (tabId) => {
      const t = queryTab(tabId);
      return t ? !t.persisted || !defsEqual(t.saved, t.live) : false;
    },
    canRevert: (tabId) => {
      const t = queryTab(tabId);
      return t ? t.persisted && !defsEqual(t.saved, t.live) : false;
    },
    resultCount: (tabId) => state.resultsByTab[tabId]?.rowCount,

    rowSelection: (tabId) => state.selectionByTab[tabId] ?? EMPTY_SELECTION,
    clickRow: (tabId, index, mods) => {
      const prev = state.selectionByTab[tabId] ?? EMPTY_SELECTION;
      let next: Set<number>;
      if (mods.shift) {
        // Grow a range from the anchor (or this row, with nothing anchored yet).
        const anchor = rowClickAnchor.get(tabId) ?? index;
        const lo = Math.min(anchor, index);
        const hi = Math.max(anchor, index);
        next = new Set<number>();
        for (let i = lo; i <= hi; i++) next.add(i);
        rowClickAnchor.set(tabId, anchor);
      } else if (mods.ctrl) {
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
      setState("selectionByTab", tabId, next);
    },
    // Only track-based rows carry an id; on any other row this does nothing.
    doubleClickRow: (tabId, index) => playRow(tabId, index),
    moveRowSelection: (tabId, forward, extend) => {
      const len = state.resultsByTab[tabId]?.rowCount ?? 0;
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
      setState("selectionByTab", tabId, next);
      setRowReveal({ tabId, row: target, seq: ++revealSeq });
    },
    rowRecords: (tabId, index) => {
      const targets = state.recordTargetsByTab[tabId] ?? [];
      const records: RecordRef[] = [];
      for (const target of targets) {
        const values = target.keyValues[index];
        // A row that's NULL in any key column doesn't identify a record there —
        // an outer join with nothing on the far side, say.
        if (!values || values.some((v) => v === null || v === "")) continue;
        records.push({
          table: target.table,
          key: target.keyColumns.map((column, i) => ({
            column,
            value: values[i] as string,
          })),
        });
      }
      return records;
    },

    recordEditor: (tabId) => state.recordEditorByTab[tabId] ?? null,
    // Delete-then-set so the tab's entry holds a *new* object rather than the
    // previous record merged in place — same hazard `setTabResult` documents.
    // Re-pointing the editor at another record must read as a swap.
    openRecordEditor: (tabId, record) =>
      batch(() => {
        setState(
          "recordEditorByTab",
          produce((m) => {
            delete m[tabId];
          }),
        );
        setState("recordEditorByTab", tabId, record);
      }),
    closeRecordEditor: (tabId) => setState("recordEditorByTab", tabId, null),
    recordSidebarWidth,
    setRecordSidebarWidth: (px) =>
      setRecordSidebarWidthSignal(clampRecordSidebarWidth(px)),
    commitRecordSidebarWidth: () =>
      persistRecordSidebarWidth(recordSidebarWidth()),

    playRow,
    togglePlayPause: () => {
      if (!audio || !state.currentTrack) return;
      if (audio.isPlaying) audio.pause();
      else audio.play();
      syncTransport();
    },
    skipNext: () => {
      audio?.skipNext();
      syncTransport();
    },
    stopPlayback: () => {
      // Dismissing a track counts as finishing it only if it played at least
      // halfway; log that before the teardown resets the position it's read from.
      const ct = state.currentTrack;
      if (ct && audio?.pastHalfway) logPlay(ct.id);
      clearNowPlaying();
    },
    locateCurrentTrack: () => {
      const ct = state.currentTrack;
      const source = ct?.sourceTabId;
      if (!ct || source == null || ct.rowIndex === null || !tab(source)) return;
      setState("activeTabId", source);
      setState("selectionByTab", source, new Set([ct.rowIndex]));
      setRowReveal({ tabId: source, row: ct.rowIndex, seq: ++revealSeq });
    },
    rowReveal,
    seedNowPlaying: (track, playback) => {
      setState("currentTrack", track);
      setState("playback", playback);
    },

    saveQuery: (tabId) => {
      const t = queryTab(tabId);
      if (!t) return;
      const live = unwrap(t.live);
      const definition = definitionToStored(live);
      const now = nowEpoch();
      // A never-saved (ephemeral) tab is inserted; an existing one has just its
      // definition updated. Either way, adopt the working copy as the new saved
      // baseline and mark the tab persisted so the unsaved indicator clears
      // immediately (optimistic), then refresh the Queries list.
      if (t.persisted) {
        void queryUpdateDefinition({
          id: tabId,
          definition,
          modifiedAt: now,
        }).catch((err) => console.error("query save failed", err));
      } else {
        void queryAdd({
          id: tabId,
          name: t.name,
          createdAt: now,
          modifiedAt: now,
          lastPlay: now,
          definition,
        }).catch((err) => console.error("query save failed", err));
      }
      editQueryTab(tabId, (x) => {
        x.saved = cloneDefinition(live);
        x.persisted = true;
      });
      void refetch();
    },
    duplicateQuery: (id) => {
      const source = queryTab(id);
      if (!source) return;
      // Open a new *ephemeral* (unsaved) tab copied from the source's working
      // copy — carrying any unsaved edits. Nothing is written to the backend
      // until the user saves it; the tab reads
      // as unsaved (its ✱ shows) meanwhile, and it stays out of the Queries list.
      const live = cloneDefinition(unwrap(source.live));
      const newId = newUuid();
      setState("tabs", state.tabs.length, {
        kind: "query",
        id: newId,
        name: nowName(),
        saved: cloneDefinition(live),
        live,
        persisted: false,
      });
      setState("activeTabId", newId);
    },

    // Only a query has a name of its own to rename; a settings tab's handle text
    // is fixed, so the rename affordances stand down for it.
    beginRename: (id) => {
      const t = queryTab(id);
      if (t) setState("renaming", { id, buffer: t.name });
    },
    setRenameBuffer: (text) =>
      setState("renaming", (r) => (r ? { ...r, buffer: text } : r)),
    commitRename: () => {
      const r = state.renaming;
      if (!r) return;
      const name = r.buffer.trim();
      const t = queryTab(r.id);
      setState("renaming", null);
      if (name === "" || !t || t.name === name) return;
      editQueryTab(r.id, (x) => {
        x.name = name;
      });
      void queryRename({ id: r.id, name })
        .then(() => refetch())
        .catch((err) => console.error("query rename failed", err));
    },
    cancelRename: () => setState("renaming", null),

    requestDelete: (id) => {
      const t = queryTab(id);
      if (!t) return;
      setState("pendingDelete", {
        id,
        name: t.name,
        unsaved: !t.persisted || !defsEqual(t.saved, t.live),
      });
    },
    confirmDelete: () => {
      const pending = state.pendingDelete;
      if (!pending) return;
      const persisted = queryTab(pending.id)?.persisted ?? false;
      setState("pendingDelete", null);
      // An ephemeral (never-saved) query has no backend record to delete — just
      // drop its tab.
      if (persisted) {
        void queryDelete({ id: pending.id })
          .then(() => refetch())
          .catch((err) => console.error("query delete failed", err));
      }
      closeTab(pending.id);
    },
    cancelDelete: () => setState("pendingDelete", null),

    builderSection: (tabId) => state.builderSectionByTab[tabId] ?? null,
    toggleBuilderSection: (tabId, section) => {
      const open = state.builderSectionByTab[tabId] ?? null;
      // Any section toggle (open, close, switch) discards the ephemeral
      // expansion; in-progress edits live in `presetEdits` and survive.
      setState("expandedPresetByTab", tabId, null);
      setState("builderSectionByTab", tabId, open === section ? null : section);
    },
    focusBuilderSection: (tabId, section) => {
      setState("expandedPresetByTab", tabId, null);
      setState("builderSectionByTab", tabId, section);
      setBuilderFocus({ tabId, section, seq: ++builderFocusSeq });
    },
    builderFocus,
    clearBuilderFocus: () => setBuilderFocus(undefined),
    expandedPreset: (tabId) => state.expandedPresetByTab[tabId] ?? null,
    toggleExpandPreset: (tabId, presetId) => {
      const cur = state.expandedPresetByTab[tabId] ?? null;
      setState(
        "expandedPresetByTab",
        tabId,
        cur === presetId ? null : presetId,
      );
    },

    setFilterCustom: (tabId, text) =>
      editLiveDebounced(tabId, (def) => {
        def.filter.custom = text;
      }),
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
        !queryTab(tabId)?.live.filter.presets.includes(presetId) &&
        state.expandedPresetByTab[tabId] === presetId
      ) {
        setState("expandedPresetByTab", tabId, null);
      }
    },
    setSectionContent: (tabId, section, content) => {
      editLive(tabId, (def) => {
        def[section] = content;
      });
      setState("expandedPresetByTab", tabId, null);
    },
    setSectionCustomText: (tabId, section, text) =>
      editLiveDebounced(tabId, (def) => {
        def[section] = { custom: text };
      }),
    reshuffle: (tabId, section) =>
      editLive(tabId, (def) => {
        def[section] = shuffleContent();
      }),
    revertLive: (tabId) => {
      const t = queryTab(tabId);
      if (!t) return;
      const saved = cloneDefinition(unwrap(t.saved));
      editQueryTab(tabId, (x) => {
        x.live = saved;
      });
      setState("expandedPresetByTab", tabId, null);
      runQuery(tabId);
    },

    presetName,
    presetsFor: (baseTable, section) =>
      state.presets.filter(
        (p) => p.section === section && p.baseTable === baseTable,
      ),
    presetDirty,
    presetEdit: (id) => state.presetEdits[id],
    beginPresetEdit,
    patchPresetEdit: (id, patch) => {
      if (!state.presetEdits[id]) beginPresetEdit(id);
      setState("presetEdits", id, patch);
    },
    revertPresetEdit: (id) => beginPresetEdit(id),
    commitPresetEdit: (tabId, id) => {
      const edit = state.presetEdits[id];
      if (!edit) return;
      const name = edit.name.trim();
      if (name === "") return;
      const idx = state.presets.findIndex((p) => p.id === id);
      if (idx !== -1) {
        const modifiedAt = nowEpoch();
        setState("presets", idx, {
          name,
          definition: edit.definition,
          isDefault: edit.isDefault,
          modifiedAt,
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
      setState(
        "presetEdits",
        produce((e) => delete e[id]),
      );
      runQuery(tabId);
    },

    openPresetSave: (section, definition) =>
      setState("presetSave", {
        section,
        definition,
        name: "",
        isDefault: false,
      }),
    cancelPresetSave: () => setState("presetSave", null),
    patchPresetSave: (patch) =>
      setState("presetSave", (s) => (s ? { ...s, ...patch } : s)),
    confirmPresetSave: (tabId) => {
      const save = state.presetSave;
      const t = queryTab(tabId);
      if (!save || !t) return;
      const name = save.name.trim();
      const base = t.live.base.trim();
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
      setState("presets", state.presets.length, preset);
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
      setState("presetSave", null);
    },
    openViewSql: (tabId) => {
      const t = queryTab(tabId);
      const schemaJson = schema();
      if (!t || schemaJson === undefined) return;
      try {
        const { sql } = compileSavedQuery(
          unwrap(t.live),
          effectivePresets(),
          schemaJson,
        );
        setState("viewSql", sql);
      } catch (err) {
        setState("viewSql", String(err instanceof Error ? err.message : err));
      }
    },
    closeViewSql: () => setState("viewSql", null),
  };
}

const AppStateContext = createContext<AppStore>();

export function AppStateProvider(props: ParentProps) {
  const store = createAppStore();
  return (
    <AppStateContext.Provider value={store}>
      {props.children}
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppStore {
  const store = useContext(AppStateContext);
  if (!store)
    throw new Error("useAppState must be used within AppStateProvider");
  return store;
}
