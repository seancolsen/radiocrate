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
import { addInferredLinks, INTROSPECTION_SQL } from "../query/schema";
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
import { detectTrackIdColumn } from "../query/lineage";
import { buildResultFromArrow, type QueryResult } from "../query/result";
import { stringifyArrowValue } from "../api/query";
import type { Table } from "apache-arrow";

/** An in-progress, uncommitted edit of a saved preset's fields. Keyed by preset
 * id in `presetEdits`; persists across collapse / tab navigation (mirrors
 * `builder.rs:PresetEdit`). This session it commits only to local state. */
export interface PresetEdit {
  name: string;
  definition: string;
  isDefault: boolean;
}

/** The "Save as preset" naming-dialog state (mirrors `builder.rs:PresetSave`). */
export interface PresetSave {
  section: Section;
  definition: string;
  name: string;
  isDefault: boolean;
}

/** An open tab. Tab id == query id this phase. Carries both the saved query
 * definition and an independent working (`live`) copy the builder mutates; the
 * two diverging is what shows the unsaved-changes indicator.
 *
 * `persisted` is false for an ephemeral query — a never-saved tab (e.g. a
 * Duplicate) that exists only in this session until Save writes it to the
 * backend. An ephemeral tab always reads as unsaved (mirrors egui's
 * `QueryPage::ephemeral`, whose `saved` snapshot is `None`). */
export interface Tab {
  id: string;
  name: string;
  saved: QueryDefinition;
  live: QueryDefinition;
  persisted: boolean;
}

/** The track shown in the now-playing bar, and where it came from. Mirrors
 * `now_playing.rs:CurrentTrack`. */
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

export interface AppState {
  sidebarOpen: boolean; // explorer open/closed (persisted, like theme)
  tabs: Tab[]; // open tabs, in tab-bar order
  activeTabId: string | null;
  queryFilter: string; // "Filter" input text in the Queries section
  openedCollapsed: boolean; // "Opened" section disclosure
  queriesCollapsed: boolean; // "Queries" section disclosure
  /** Per-tab decoded, render-ready results, keyed by tab id. */
  resultsByTab: Record<string, QueryResult>;
  /** Per-tab result-row selection: a set of row indexes (mirrors the egui page's
   * `selection`). Replaced wholesale on every change so subscribers observe a new
   * reference; cleared when the tab's result changes. */
  selectionByTab: Record<string, ReadonlySet<number>>;
  /** Per-tab per-row track ids, present only when the query's rows represent
   * tracks (a column traces to `track.id`). Indexed by row; drives
   * double-click-to-play. Absent/empty when the query isn't track-based. */
  trackIdsByTab: Record<string, readonly (string | null)[]>;
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

function newUuid(): string {
  return crypto.randomUUID();
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

/** Local wall-clock formatted `YYYY-MM-DD HH:MM` — the default name for a newly
 * created query (mirrors `rpc.rs:now_name`). */
function nowName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Trailing debounce applied to the query re-run that follows a text edit in the
 * builder, so a run fires once the user pauses rather than on every keystroke
 * (the egui builder only ran on Ctrl+Enter; the DOM builder debounces instead). */
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
  openTab: (query: { id: string; name: string; definition: string }) => void;
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
   * compile/fetch/decode path). `trackIds` stands in for the lineage analysis,
   * making the rows playable without a real compile. */
  setResults: (
    tabId: string,
    result: QueryResult,
    trackIds?: readonly (string | null)[],
  ) => void;
  /** Overwrite a tab's saved/working definitions directly (dev/test seam —
   * lets the harness reach a specific builder state without a backend). */
  setTabDefinitions: (
    tabId: string,
    saved: QueryDefinition,
    live: QueryDefinition,
  ) => void;

  /** The tab with `id`, if open. */
  tab: (tabId: string) => Tab | undefined;
  /** Whether a tab has unsaved changes: an ephemeral (never-saved) tab always,
   * else a persisted tab whose working def differs from its saved def. Drives the
   * Save button and the ✱ markers. */
  isUnsaved: (tabId: string) => boolean;
  /** Whether "Revert changes" applies: a persisted tab with edits to discard (an
   * ephemeral tab has no saved baseline to revert to — mirrors egui's
   * `show_revert = unsaved && is_persisted`). */
  canRevert: (tabId: string) => boolean;
  /** The result row count for a tab, if it has run. */
  resultCount: (tabId: string) => number | undefined;

  // Result-row selection + interaction.
  /** The tab's selected row indexes (empty set when nothing is selected). */
  rowSelection: (tabId: string) => ReadonlySet<number>;
  /** Apply a click on result row `index`, updating the selection: Shift extends a
   * range from the anchor, Ctrl/Cmd toggles the row, a plain click selects it
   * alone (mirrors egui's `handle_row_click`). */
  clickRow: (
    tabId: string,
    index: number,
    mods: { shift: boolean; ctrl: boolean },
  ) => void;
  /** Handle a double-click on result row `index`: if the query's rows are tracks,
   * plays that row's track (queuing the rows after it). */
  doubleClickRow: (tabId: string, index: number) => void;

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
  /** The expanded preset id for a tab (null when none). */
  expandedPreset: (tabId: string) => string | null;
  /** Toggle a preset's inline editor open/closed. */
  toggleExpandPreset: (tabId: string, presetId: string) => void;

  // Working-definition mutators (all re-run the query where egui does).
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
    tabs: [],
    activeTabId: null,
    queryFilter: "",
    openedCollapsed: false,
    queriesCollapsed: false,
    resultsByTab: {},
    selectionByTab: {},
    trackIdsByTab: {},
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

  const tab = (tabId: string): Tab | undefined =>
    state.tabs.find((t) => t.id === tabId);

  /** The preset list to run/preview against: each saved preset overlaid with any
   * in-progress edit, so results reflect pending preset changes before they're
   * committed (mirrors `builder.rs:effective_presets`). */
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
      // New rows invalidate the old selection and any prior track-id mapping (the
      // latter is repopulated asynchronously by `detectTrackIds`).
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
      // The playing track's row belonged to the rows just replaced; it's
      // re-located once the new mapping lands (see `detectTrackIds`).
      if (state.currentTrack?.sourceTabId === tabId) {
        setState("currentTrack", "rowIndex", null);
      }
    });
    rowClickAnchor.delete(tabId);
  };

  /** Off the critical path: analyzes the compiled SQL to find the output column
   * carrying `track.id`, and if there is one caches that column's per-row ids so a
   * double-click can play the row's track. A no-op (clears any mapping) when the
   * rows aren't tracks. Guarded by `token` so a superseded run can't win a race. */
  const detectTrackIds = async (
    tabId: string,
    sql: string,
    table: Table,
    token: number,
  ) => {
    const col = await detectTrackIdColumn(sql);
    if (runTokens.get(tabId) !== token) return; // a newer run superseded this one
    if (col === undefined) return; // not track-based (mapping already cleared)
    const vector = table.getChildAt(col);
    const ids: (string | null)[] = new Array<string | null>(table.numRows);
    for (let r = 0; r < table.numRows; r++) {
      const v = vector?.get(r);
      ids[r] = v == null ? null : stringifyArrowValue(v);
    }
    setState("trackIdsByTab", tabId, ids);
    // Re-locate the playing track's row in the rows that just landed, so
    // "Locate" keeps working after the tab is re-run (mirrors
    // `maybe_revalidate_current_track_index`).
    const ct = state.currentTrack;
    if (ct?.sourceTabId === tabId) {
      setState("currentTrack", "rowIndex", locateRow(tabId, ct.id));
    }
  };

  const runQuery = (tabId: string) => {
    const t = tab(tabId);
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
        // Then, off the critical path, figure out whether these rows are tracks
        // (so double-click can play them). Deliberately not awaited: the results
        // are already shown, and the WASM lineage analysis is heavy.
        void detectTrackIds(tabId, sql, table, token);
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
    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    setState("tabs", idx, "live", produce(mutate));
    runQuery(tabId);
  };

  /** Like {@link editLive}, but the state update is applied immediately (so the
   * controlled input and the unsaved indicator stay in sync) while the query
   * re-run is debounced. For the builder's free-text editors. */
  const editLiveDebounced = (
    tabId: string,
    mutate: (def: QueryDefinition) => void,
  ) => {
    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    setState("tabs", idx, "live", produce(mutate));
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
   * reuse it. */
  const closeTab = (id: string) => {
    setState(
      produce((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return;
        s.tabs.splice(idx, 1);
        delete s.resultsByTab[id];
        delete s.selectionByTab[id];
        delete s.trackIdsByTab[id];
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
   * Capped like the egui scan so a huge result set can't stall a transition. */
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
    if (!tab(tabId)?.persisted) return;
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
    openTab: (query) => {
      if (!state.tabs.some((t) => t.id === query.id)) {
        const saved = definitionFromStored(query.definition);
        setState("tabs", state.tabs.length, {
          id: query.id,
          name: query.name,
          saved,
          live: cloneDefinition(saved),
          persisted: true,
        });
      }
      setState("activeTabId", query.id);
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
    setResults: (tabId, result, trackIds) => {
      setTabResult(tabId, result);
      if (trackIds) setState("trackIdsByTab", tabId, trackIds);
    },
    setTabDefinitions: (tabId, saved, live) => {
      const idx = state.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;
      setState("tabs", idx, "saved", saved);
      setState("tabs", idx, "live", cloneDefinition(live));
    },

    tab,
    isUnsaved: (tabId) => {
      const t = tab(tabId);
      return t ? !t.persisted || !defsEqual(t.saved, t.live) : false;
    },
    canRevert: (tabId) => {
      const t = tab(tabId);
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
      setState("selectionByTab", tabId, next);
    },
    // Only track-based rows carry an id; on any other row this does nothing.
    doubleClickRow: (tabId, index) => playRow(tabId, index),

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
      const t = tab(tabId);
      if (!t) return;
      const idx = state.tabs.findIndex((x) => x.id === tabId);
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
      setState("tabs", idx, "saved", cloneDefinition(live));
      setState("tabs", idx, "persisted", true);
      void refetch();
    },
    duplicateQuery: (id) => {
      const source = tab(id);
      if (!source) return;
      // Open a new *ephemeral* (unsaved) tab copied from the source's working
      // copy — carrying any unsaved edits — mirroring `lib.rs:duplicate_query`.
      // Nothing is written to the backend until the user saves it; the tab reads
      // as unsaved (its ✱ shows) meanwhile, and it stays out of the Queries list.
      const live = cloneDefinition(unwrap(source.live));
      const newId = newUuid();
      setState("tabs", state.tabs.length, {
        id: newId,
        name: nowName(),
        saved: cloneDefinition(live),
        live,
        persisted: false,
      });
      setState("activeTabId", newId);
    },

    beginRename: (id) =>
      setState("renaming", { id, buffer: tab(id)?.name ?? "" }),
    setRenameBuffer: (text) =>
      setState("renaming", (r) => (r ? { ...r, buffer: text } : r)),
    commitRename: () => {
      const r = state.renaming;
      if (!r) return;
      const name = r.buffer.trim();
      const t = tab(r.id);
      setState("renaming", null);
      if (name === "" || !t || t.name === name) return;
      const idx = state.tabs.findIndex((x) => x.id === r.id);
      setState("tabs", idx, "name", name);
      void queryRename({ id: r.id, name })
        .then(() => refetch())
        .catch((err) => console.error("query rename failed", err));
    },
    cancelRename: () => setState("renaming", null),

    requestDelete: (id) => {
      const t = tab(id);
      setState("pendingDelete", {
        id,
        name: t?.name ?? "",
        unsaved: t ? !t.persisted || !defsEqual(t.saved, t.live) : false,
      });
    },
    confirmDelete: () => {
      const pending = state.pendingDelete;
      if (!pending) return;
      const persisted = tab(pending.id)?.persisted ?? false;
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
        !tab(tabId)?.live.filter.presets.includes(presetId) &&
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
      const t = tab(tabId);
      if (!t) return;
      const idx = state.tabs.findIndex((x) => x.id === tabId);
      setState("tabs", idx, "live", cloneDefinition(unwrap(t.saved)));
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
      const t = tab(tabId);
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
      const t = tab(tabId);
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
