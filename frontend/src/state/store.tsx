import {
  createContext,
  createResource,
  useContext,
  type ParentProps,
  type Resource,
} from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import { listPresets, listQueries, type Preset, type Query } from "../api/rpc";
import { runSql, runSqlScalar } from "../api/query";
import { addInferredLinks, INTROSPECTION_SQL } from "../query/schema";
import { compileSavedQuery } from "../query/compile";
import {
  cloneDefinition,
  defsEqual,
  definitionFromStored,
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
  is_default: boolean;
}

/** The "Save as preset" naming-dialog state (mirrors `builder.rs:PresetSave`). */
export interface PresetSave {
  section: Section;
  definition: string;
  name: string;
  is_default: boolean;
}

/** An open tab. Tab id == query id this phase. Carries both the saved query
 * definition and an independent working (`live`) copy the builder mutates; the
 * two diverging is what shows the unsaved-changes indicator. */
export interface Tab {
  id: string;
  name: string;
  saved: QueryDefinition;
  live: QueryDefinition;
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
  /** Whether a tab's working def differs from its saved def. */
  isUnsaved: (tabId: string) => boolean;
  /** The result row count for a tab, if it has run. */
  resultCount: (tabId: string) => number | undefined;

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
  });

  const [queries, { refetch }] = createResource<Query[]>(async () => {
    return await listQueries();
  });

  // Presets load once, then live in the mutable store (above) so local edits and
  // "Save as preset" can add/update them without a refetch.
  createResource<Preset[]>(async () => {
    const loaded = await listPresets();
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
            is_default: edit.is_default,
          }
        : p;
    });

  // Tabs that have been auto-run once (the "have I run this tab yet" guard).
  const autoRun = new Set<string>();

  const runQuery = (tabId: string) => {
    const t = tab(tabId);
    if (!t) return;
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
        setState(
          "resultsByTab",
          tabId,
          buildResultFromArrow(table, columnAnnotations),
        );
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
      saved.is_default !== edit.is_default
    );
  };

  const beginPresetEdit = (id: string) => {
    const preset = state.presets.find((p) => p.id === id);
    if (!preset) return;
    setState("presetEdits", id, {
      name: preset.name,
      definition: preset.definition,
      is_default: preset.is_default,
    });
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
        });
      }
      setState("activeTabId", query.id);
    },
    closeTab: (id) => {
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
    },
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
    setResults: (tabId, result) => setState("resultsByTab", tabId, result),
    setTabDefinitions: (tabId, saved, live) => {
      const idx = state.tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;
      setState("tabs", idx, "saved", saved);
      setState("tabs", idx, "live", cloneDefinition(live));
    },

    tab,
    isUnsaved: (tabId) => {
      const t = tab(tabId);
      return t ? !defsEqual(t.saved, t.live) : false;
    },
    resultCount: (tabId) => state.resultsByTab[tabId]?.rowCount,

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
      editLive(tabId, (def) => {
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
      editLive(tabId, (def) => {
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
        (p) => p.section === section && p.base_table === baseTable,
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
        setState("presets", idx, {
          name,
          definition: edit.definition,
          is_default: edit.is_default,
          modified_at: nowEpoch(),
        });
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
        is_default: false,
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
        base_table: base,
        section: save.section,
        definition: save.definition,
        is_default: save.is_default,
        created_at: now,
        modified_at: now,
      };
      setState("presets", state.presets.length, preset);
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
