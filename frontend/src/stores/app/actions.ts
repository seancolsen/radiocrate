import * as arrow from "apache-arrow";
import { castDraft, type Draft } from "immer";
import { shallow } from "zustand/vanilla/shallow";
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
  settingDelete,
  settingList,
  settingSet,
  type DmlOperation,
  type DmlResult,
  type Preset,
} from "api-client";
import { runSql, runSqlScalar } from "../../api/query";
import { fetchTrackMetadata, playInsert } from "../../api/track";
import { AudioEngine, type AudioQualityPref } from "../../audio/engine";
import {
  addInferredLinks,
  INTROSPECTION_SQL,
  parseSchemaTables,
} from "../../query/schema";
import { compileSavedQuery } from "../../query/compile";
import { overridesFromEntries, withSetting } from "../../state/settings";
import type { SettingKey } from "../../state/settings";
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
import {
  analyzeColumnSources,
  recordKeyColumns,
  trackIdColumn,
  type LineageMapping,
} from "../../query/lineage";
import { buildResultFromArrow, type QueryResult } from "../../query/result";
import { runRowDml } from "../../query/rowDml";
import type { AppEnv } from "../env";
import { applyThemeToDocument, watchSystemTheme } from "./theme";
import {
  clampRecordSidebarWidth,
  persistAudioQuality,
  persistRecordSidebarWidth,
  persistSidebar,
  persistTabs,
  persistTheme,
} from "./persistence";
import {
  selectEffectivePresets,
  selectIsUnsaved,
  selectLocateRow,
  selectPlaylistAround,
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

/** RPC methods whose failures never reach the error bar. `app.version` is the
 * update controller's background poll, which handles its own failures: a server
 * that's briefly unreachable shouldn't raise a bar. */
const UNREPORTED_METHODS: ReadonlySet<string> = new Set(["app.version"]);

/** Every write method the app store exposes. Reads live in `selectors.ts`
 * instead (state management rule 1): actions are stable references, so a
 * component can put them in an effect's dependency array without churn. */
export interface AppActions {
  // Boot loads. `createStores()` runs these once; unit tests call them
  // directly.
  loadQueries: () => Promise<void>;
  loadPresets: () => Promise<void>;
  loadSchema: () => Promise<void>;
  loadSettings: () => Promise<void>;
  /** Re-runs `loadQueries` and `loadPresets` — the Explorer's manual refresh. */
  refetchQueries: () => void;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  /** Sets the theme override ("system" clears it) — the Settings menu's action. */
  setTheme: (pref: ThemePref) => void;
  /** Sets the audio-streaming quality preference — the Settings menu's action. */
  setAudioQuality: (pref: AudioQualityPref) => void;
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
  /** Dismiss the bar: stop playback and tear down the queue (the bar's "Close"). */
  stopPlayback: () => void;
  /** Jump to the playing track's row: activate its source tab, select the row and
   * scroll it into view (the bar's "Locate"). */
  locateCurrentTrack: () => void;
  /** Seed the now-playing bar without touching the audio engine (dev/test seam —
   * lets the harness snapshot the bar with no backend or audio). */
  seedNowPlaying: (track: CurrentTrack, playback: AppState["playback"]) => void;

  /** Persist the tab's working definition (`query.update_definition`), then mark
   * it saved so the unsaved indicator clears. */
  saveQuery: (tabId: string) => void;
  /** Create a persisted copy of query `id` (from its live definition) and open
   * it in a new tab. */
  duplicateQuery: (id: string) => void;
  /** Open a new ephemeral (unsaved) query tab based on "track", seeded with
   * that base's default filter/sort/display presets. */
  newQueryTab: () => void;

  /** Begin renaming query `id`, seeding the buffer with its current name. */
  beginRename: (id: string) => void;
  /** Update the in-progress rename buffer. */
  setRenameBuffer: (text: string) => void;
  /** Commit the in-progress rename (`query.rename`); an empty name cancels. */
  commitRename: () => void;
  /** Abandon the in-progress rename. */
  cancelRename: () => void;

  /** Open the delete-confirmation modal for query `id`. */
  requestDelete: (id: string) => void;
  /** Confirm the pending delete (`query.delete` + close its tab). */
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

  /** The draft of `tabId`'s page, created empty by the first write to it. Only
   * for writes: a read goes through `s.pages[tabId]?.…`, which never creates
   * one. */
  const pageDraft = (s: Draft<AppState>, tabId: string) =>
    (s.pages[tabId] ??= castDraft(emptyPage()));

  /** Installs a tab's decoded result, forcing a fresh object reference.
   *
   * `QueryResult` is a class, so assigning one at a store leaf always swaps the
   * reference — Immer never drafts a class instance (see the unit tests), so
   * the new value simply replaces the old one, same as every other write. */
  const setTabResult = (tabId: string, result: QueryResult) => {
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
      // New rows invalidate the old selection and any prior lineage mapping (the
      // latter is repopulated asynchronously by `analyzeLineage`).
      delete page.selection;
      delete page.lineage;
      // The playing track's row belonged to the rows just replaced; it's
      // re-located once the new mapping lands (see `analyzeLineage`).
      if (s.currentTrack?.sourceTabId === tabId) s.currentTrack.rowIndex = null;
    });
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
    const records = schemaJson
      ? recordKeyColumns(sources, parseSchemaTables(schemaJson))
          // A key whose value arrives as a list identifies no one record.
          .filter((k) => !k.keyIndices.some(isListColumn))
      : [];

    set((s) => {
      pageDraft(s, tabId).lineage = castDraft({
        trackIdColumn: playable ? trackCol : undefined,
        records,
      });
    });
    if (!playable) return;
    // Re-locate the playing track's row in the rows that just landed, so
    // "Locate" keeps working after the tab is re-run (mirrors
    // `maybe_revalidate_current_track_index`).
    const ct = get().currentTrack;
    if (ct?.sourceTabId === tabId) {
      const rowIndex = selectLocateRow(get(), tabId, ct.id);
      set((s) => {
        if (s.currentTrack) s.currentTrack.rowIndex = rowIndex;
      });
    }
  };

  const runQuery = (tabId: string) => {
    const t = selectQueryTab(get(), tabId);
    if (!t) return;
    // An immediate run supersedes any run this tab had pending on the debounce.
    cancelScheduledRun(tabId);
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
        const current = selectQueryTab(get(), tabId);
        const schemaJson = get().schema.json;
        if (!current || schemaJson === undefined) return;
        const { sql, columnAnnotations } = compileSavedQuery(
          current.live,
          selectEffectivePresets(get()),
          schemaJson,
          selectPrelude(get()),
        );
        const table = await runSql(sql);
        // Decode the result once, here — never per resize/frame (§6). Display
        // text is derived from it on read, not precomputed.
        const result = buildResultFromArrow(table, columnAnnotations);
        setTabResult(tabId, result);
        // Then, off the critical path, figure out what these rows *are* — tracks
        // to play, records to edit. Deliberately not awaited: the results are
        // already shown, and the WASM lineage analysis is heavy.
        void analyzeLineage(tabId, sql, result, token);
      } catch (err) {
        // No error UI this phase — console only (see plan non-goals).
        console.error("query run failed", err);
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

  /** Mutate a tab's working definition through a mutator, then re-run. */
  const editLive = (tabId: string, mutate: (def: QueryDefinition) => void) => {
    if (!selectQueryTab(get(), tabId)) return;
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
    if (!selectQueryTab(get(), tabId)) return;
    editQueryTab(tabId, (t) => mutate(t.live));
    scheduleRun(tabId);
  };

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
    autoRun.delete(id);
    cancelScheduledRun(id);
    rowClickAnchor.delete(id);
    rowSelectionLead.delete(id);
    runTokens.delete(id);
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

  /** Fetches the track's title/artists, then fills them into the bar and pushes
   * them to the OS media session — but only while that track is still the
   * current one, so a fetch overtaken by an auto-advance is discarded. */
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
    );
  };

  /** Records a play against `tabId`'s saved query (bumps `last_play`). Skipped
   * for an ephemeral tab, which has no backend row yet. */
  const recordQueryPlay = (tabId: string) => {
    if (!selectQueryTab(get(), tabId)?.persisted) return;
    void queryRecordPlay({ id: tabId, lastPlay: nowEpoch() }).catch((err) =>
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
    const { preceding, upcoming } = selectPlaylistAround(get(), tabId, index);
    set((s) => {
      s.currentTrack = {
        sourceTabId: tabId,
        id,
        rowIndex: index,
        title: null,
        artists: [],
      };
    });
    engine().setPlaylist(preceding, id, upcoming);
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
      setRecordEditorRecords(tabId, current.table, records);
    }
  };

  const actions: AppActions = {
    loadQueries: async () => {
      set((s) => {
        s.queries.status = "loading";
      });
      try {
        const data = await queryList();
        set((s) => {
          s.queries = { status: "ready", data };
        });
      } catch (err) {
        console.error("query list failed", err);
        set((s) => {
          s.queries.status = "error";
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
    refetchQueries: () => {
      void actions.loadQueries();
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
    openTab: (query) => {
      set((s) => {
        if (!s.tabs.some((t) => t.id === query.id)) {
          const saved = definitionFromStored(query.definition);
          s.tabs.push({
            kind: "query",
            id: query.id,
            name: query.name,
            saved,
            live: cloneDefinition(saved),
            persisted: true,
          });
        }
        s.activeTabId = query.id;
      });
    },
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
    setQueryFilter: (text) =>
      set((s) => {
        s.queryFilter = text;
      }),
    toggleOpenedCollapsed: () =>
      set((s) => {
        s.openedCollapsed = !s.openedCollapsed;
      }),
    toggleQueriesCollapsed: () =>
      set((s) => {
        s.queriesCollapsed = !s.queriesCollapsed;
      }),
    setSchemaJson: (json) =>
      set((s) => {
        s.schema = { status: "ready", json, tables: parseSchemaTables(json) };
      }),
    runQuery,
    ensureRun: (tabId) => {
      if (!autoRun.has(tabId)) runQuery(tabId);
    },
    setResults: (tabId, result, lineage) => {
      setTabResult(tabId, result);
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

    clickRow: (tabId, index, mods) => {
      const prev = get().pages[tabId]?.selection;
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
      const live = t.live;
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
      void actions.loadQueries();
    },
    duplicateQuery: (id) => {
      const source = selectQueryTab(get(), id);
      if (!source) return;
      // Open a new *ephemeral* (unsaved) tab copied from the source's working
      // copy — carrying any unsaved edits. Nothing is written to the backend
      // until the user saves it; the tab reads
      // as unsaved (its ✱ shows) meanwhile, and it stays out of the Queries list.
      const live = cloneDefinition(source.live);
      const newId = newUuid();
      set((s) => {
        s.tabs.push({
          kind: "query",
          id: newId,
          name: nowName(),
          saved: cloneDefinition(live),
          live,
          persisted: false,
        });
        s.activeTabId = newId;
      });
    },
    newQueryTab: () => {
      const def = definitionForBase("track", selectEffectivePresets(get()));
      const newId = newUuid();
      set((s) => {
        s.tabs.push({
          kind: "query",
          id: newId,
          name: nowName(),
          saved: cloneDefinition(def),
          live: def,
          persisted: false,
        });
        s.activeTabId = newId;
      });
    },

    // Only a query has a name of its own to rename; a settings tab's handle text
    // is fixed, so the rename affordances stand down for it.
    beginRename: (id) => {
      const t = selectQueryTab(get(), id);
      if (t) {
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
      const t = selectQueryTab(get(), r.id);
      set((s) => {
        s.renaming = null;
      });
      if (name === "" || !t || t.name === name) return;
      editQueryTab(r.id, (x) => {
        x.name = name;
      });
      void queryRename({ id: r.id, name })
        .then(() => actions.loadQueries())
        .catch((err) => console.error("query rename failed", err));
    },
    cancelRename: () =>
      set((s) => {
        s.renaming = null;
      }),

    requestDelete: (id) => {
      const t = selectQueryTab(get(), id);
      if (!t) return;
      const unsaved = selectIsUnsaved(get(), id);
      set((s) => {
        s.pendingDelete = { id, name: t.name, unsaved };
      });
    },
    confirmDelete: () => {
      const pending = get().pendingDelete;
      if (!pending) return;
      const persisted = selectQueryTab(get(), pending.id)?.persisted ?? false;
      set((s) => {
        s.pendingDelete = null;
      });
      // An ephemeral (never-saved) query has no backend record to delete — just
      // drop its tab.
      if (persisted) {
        void queryDelete({ id: pending.id })
          .then(() => actions.loadQueries())
          .catch((err) => console.error("query delete failed", err));
      }
      closeTab(pending.id);
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
      editQueryTab(tabId, (x) => {
        x.live = rebased;
      });
      set((s) => {
        pageDraft(s, tabId).expandedPreset = null;
        pageDraft(s, tabId).fullEditorOpen = false;
      });
      runQuery(tabId);
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
      editLive(tabId, (def) => {
        def.full = full;
      });
    },
    setFullText: (tabId, text) =>
      editLiveDebounced(tabId, (def) => {
        def.full = text;
      }),
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
        !selectQueryTab(get(), tabId)?.live.filter.presets.includes(presetId) &&
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
      editLiveDebounced(tabId, (def) => {
        def[section] = { custom: text };
      }),
    reshuffle: (tabId, section) =>
      editLive(tabId, (def) => {
        def[section] = shuffleContent();
      }),
    revertLive: (tabId) => {
      const t = selectQueryTab(get(), tabId);
      if (!t) return;
      const saved = cloneDefinition(t.saved);
      editQueryTab(tabId, (x) => {
        x.live = saved;
      });
      set((s) => {
        pageDraft(s, tabId).expandedPreset = null;
      });
      runQuery(tabId);
    },

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
      const t = selectQueryTab(get(), tabId);
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
      const t = selectQueryTab(get(), tabId);
      const schemaJson = get().schema.json;
      if (!t || schemaJson === undefined) return;
      try {
        const { sql } = compileSavedQuery(
          t.live,
          selectEffectivePresets(get()),
          schemaJson,
          selectPrelude(get()),
        );
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
      // query rather than leave results that no longer answer what they claim.
      for (const t of get().tabs) if (t.kind === "query") runQuery(t.id);
    },
    openSetting: (key) =>
      set((s) => {
        s.settingEditor = key;
      }),
    closeSetting: () =>
      set((s) => {
        s.settingEditor = null;
      }),

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
  };

  const dispose = () => {
    stopWatchingSystemTheme();
    stopPersistingTabs();
    for (const timer of runTimers.values()) clearTimeout(timer);
    runTimers.clear();
  };

  return { actions, dispose };
}
