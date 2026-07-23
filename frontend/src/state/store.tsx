import {
  createContext,
  createResource,
  useContext,
  type ParentProps,
  type Resource,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { listQueries, type Query } from "../api/rpc";

/** An open tab. Tab id == query id this phase. (Future: pinned/preview, unsaved.) */
export interface Tab {
  id: string;
  name: string;
}

export interface AppState {
  sidebarOpen: boolean; // explorer open/closed (persisted, like theme)
  tabs: Tab[]; // open tabs, in tab-bar order
  activeTabId: string | null;
  queryFilter: string; // "Filter" input text in the Queries section
  openedCollapsed: boolean; // "Opened" section disclosure
  queriesCollapsed: boolean; // "Queries" section disclosure
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
  openTab: (query: { id: string; name: string }) => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  reorderTab: (id: string, toIndex: number) => void;
  setQueryFilter: (text: string) => void;
  toggleOpenedCollapsed: () => void;
  toggleQueriesCollapsed: () => void;
}

function createAppStore(): AppStore {
  const [state, setState] = createStore<AppState>({
    sidebarOpen: storedSidebarOpen(),
    tabs: [],
    activeTabId: null,
    queryFilter: "",
    openedCollapsed: false,
    queriesCollapsed: false,
  });

  const [queries, { refetch }] = createResource<Query[]>(async () => {
    return await listQueries();
  });

  const setSidebarOpen = (open: boolean) => {
    setState("sidebarOpen", open);
    persistSidebar(open);
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
          if (s.activeTabId === id) {
            // Select the neighbor (prefer the one to the left), or clear.
            const next = s.tabs[idx] ?? s.tabs[idx - 1];
            s.activeTabId = next ? next.id : null;
          }
        }),
      );
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
