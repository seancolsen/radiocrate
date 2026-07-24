import {
  batch,
  createContext,
  createResource,
  useContext,
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
  queryRename,
  queryUpdateDefinition,
  type Preset,
  type Query,
} from "api-client";
import { runSql, runSqlScalar } from "../api/query";
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
import { buildResultFromArrow, type QueryResult } from "../query/result";

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

export interface AppState {
  sidebarOpen: boolean; // explorer open/closed (persisted, like theme)
  tabs: Tab[]; // open tabs, in tab-bar order
  activeTabId: string | null;
  queryFilter: string; // "Filter" input text in the Queries section
  openedCollapsed: boolean; // "Opened" section disclosure
  queriesCollapsed: boolean; // "Queries" section disclosure
  /** Per-tab decoded, render-ready results, keyed by tab id. */
  resultsByTab: Record<string, QueryResult>;
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
   * compile/fetch/decode path). */
  setResults: (tabId: string, result: QueryResult) => void;
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
    runningByTab: {},
    builderSectionByTab: {},
    expandedPresetByTab: {},
    presets: [],
    presetEdits: {},
    presetSave: null,
    viewSql: null,
    renaming: null,
    pendingDelete: null,
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
    });
  };

  const runQuery = (tabId: string) => {
    const t = tab(tabId);
    if (!t) return;
    // An immediate run supersedes any run this tab had pending on the debounce.
    cancelScheduledRun(tabId);
    autoRun.add(tabId);
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
        delete s.runningByTab[id];
        delete s.builderSectionByTab[id];
        delete s.expandedPresetByTab[id];
        if (s.activeTabId === id) {
          // Select the neighbor (prefer the one to the left), or clear.
          const next = s.tabs[idx] ?? s.tabs[idx - 1];
          s.activeTabId = next ? next.id : null;
        }
      }),
    );
    autoRun.delete(id);
    cancelScheduledRun(id);
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
    setResults: (tabId, result) => setTabResult(tabId, result),
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
