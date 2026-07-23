import {
  createContext,
  createResource,
  useContext,
  type ParentProps,
  type Resource,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { listPresets, listQueries, type Preset, type Query } from "../api/rpc";
import { runSql, runSqlScalar, tableToText } from "../api/query";
import { addInferredLinks, INTROSPECTION_SQL } from "../query/schema";
import { compileSavedQuery } from "../query/compile";
import { fromStored } from "../query/definition";
import { querydownReady } from "../query/querydown";

/** An open tab. Tab id == query id this phase. Carries the saved query's
 * `definition` (a JSON string) so the tab can compile and run itself. */
export interface Tab {
  id: string;
  name: string;
  definition: string;
}

export interface AppState {
  sidebarOpen: boolean; // explorer open/closed (persisted, like theme)
  tabs: Tab[]; // open tabs, in tab-bar order
  activeTabId: string | null;
  queryFilter: string; // "Filter" input text in the Queries section
  openedCollapsed: boolean; // "Opened" section disclosure
  queriesCollapsed: boolean; // "Queries" section disclosure
  /** Per-tab plain-text results, keyed by tab id. */
  resultsByTab: Record<string, string>;
  /** Whether a run is in flight, keyed by tab id (errors are console-only). */
  runningByTab: Record<string, boolean>;
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
  /** Compile + run the tab's saved query, storing the plain-text result. */
  runQuery: (tabId: string) => void;
  /** Run the tab once, the first time it's viewed (idempotent per tab). */
  ensureRun: (tabId: string) => void;
  /** Inject canned results text for a tab (dev/test seam — bypasses the API). */
  setResults: (tabId: string, text: string) => void;
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
  });

  const [queries, { refetch }] = createResource<Query[]>(async () => {
    return await listQueries();
  });

  // Loaded once for the session; every compile reuses it.
  const [presets] = createResource<Preset[]>(async () => {
    return await listPresets();
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

  // Tabs that have been auto-run once (the "have I run this tab yet" guard).
  const autoRun = new Set<string>();

  const runQuery = (tabId: string) => {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    autoRun.add(tabId);
    setState("runningByTab", tabId, true);
    void (async () => {
      try {
        await querydownReady();
        const def = fromStored(tab.definition);
        const schemaJson = schema();
        if (def === null || schemaJson === undefined) return;
        const sql = compileSavedQuery(def, presets() ?? [], schemaJson);
        const table = await runSql(sql);
        setState("resultsByTab", tabId, tableToText(table));
      } catch (err) {
        // No error UI this phase — console only (see plan non-goals).
        console.error("query run failed", err);
      } finally {
        setState("runningByTab", tabId, false);
      }
    })();
  };

  return {
    state,
    queries,
    refetchQueries: () => void refetch(),
    toggleSidebar: () => setSidebarOpen(!state.sidebarOpen),
    setSidebarOpen,
    openTab: (query) => {
      if (!state.tabs.some((t) => t.id === query.id)) {
        setState("tabs", state.tabs.length, {
          id: query.id,
          name: query.name,
          definition: query.definition,
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
    setResults: (tabId, text) => setState("resultsByTab", tabId, text),
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
