import type { DmlOperation, DmlResult, Preset, Query } from "api-client";
import type { AudioQualityPref } from "../../audio/engine";
import type { LineageMapping } from "../../query/lineage";
import type { QueryDefinition, Section } from "../../query/definition";
import type { QueryResult } from "../../query/result";
import type { SchemaTable } from "../../query/schema";
import type { SettingKey, SettingOverrides } from "../../state/settings";
import type { AppEnv } from "../env";
import {
  storedAudioQuality,
  storedRecordSidebarWidth,
  storedSidebarOpen,
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

/** The status of a boot-time load: what used to be a Solid `Resource`'s
 * `.state`. `"loading"` covers both "hasn't started" and "in flight" — nothing
 * in this app distinguishes them. */
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
   * tab's result changes. Treated as opaque by Immer (see the app store's doc
   * comment): a `Set` is always swapped in whole, never mutated through a
   * draft, so no `enableMapSet()` plugin is needed. */
  selectionByTab: Record<string, ReadonlySet<number>>;
  /** Per-tab lineage mapping: which output column (if any) carries `track.id`
   * (drives double-click-to-play) and which tables the rows carry a full
   * primary key for (drives the results context menu's "Edit {table}"
   * entries). A positional mapping into the tab's `QueryResult`, not a
   * snapshot of row data — absent for a tab whose analysis hasn't landed (or
   * found nothing), same as an empty mapping. */
  lineageByTab: Record<string, LineageMapping>;
  /** The record(s) open in each tab's record-editor sidebar (`null`/absent when
   * the sidebar is closed). Per-tab — the sidebar belongs to the query page, so
   * switching tabs switches editors. */
  recordEditorByTab: Record<string, RecordEditorTarget | null>;
  /** Whether a run is in flight, keyed by tab id (errors are console-only). */
  runningByTab: Record<string, boolean>;
  /** The open builder section per tab (null = builder closed). */
  builderSectionByTab: Record<string, Section | null>;
  /** Whether the whole-query Querydown editor is open, per tab. Kept apart from
   * `builderSectionByTab` because it belongs to the other mode: a full-mode
   * query has no sections to open, and a query converted back to sections finds
   * its section state where it left it. */
  fullEditorByTab: Record<string, boolean>;
  /** The expanded preset id per tab (null = none expanded). */
  expandedPresetByTab: Record<string, string | null>;
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
  /** The track in the now-playing bar (null when nothing is loaded). */
  currentTrack: CurrentTrack | null;
  /** Transport state for that track. */
  playback: PlaybackState;
  /** The saved-query list (loads via `query.list`; `refetchQueries` reloads). */
  queries: ResourceState<readonly Query[]>;
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

export function initialState(env: AppEnv): AppState {
  return {
    sidebarOpen: storedSidebarOpen(env),
    theme: storedTheme(env),
    tabs: [],
    activeTabId: null,
    queryFilter: "",
    openedCollapsed: false,
    queriesCollapsed: false,
    resultsByTab: {},
    selectionByTab: {},
    lineageByTab: {},
    recordEditorByTab: {},
    runningByTab: {},
    builderSectionByTab: {},
    fullEditorByTab: {},
    expandedPresetByTab: {},
    presetsStatus: "loading",
    presets: [],
    presetEdits: {},
    presetSave: null,
    viewSql: null,
    renaming: null,
    pendingDelete: null,
    aboutOpen: false,
    settingEditor: null,
    currentTrack: null,
    playback: { playing: false, position: 0, duration: null, hasNext: false },
    queries: { status: "loading", data: [] },
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
export type { DmlOperation, DmlResult, Preset, Query };
