import { createMemo, For, Show } from "solid-js";
import { useAppState } from "../state/store";
import CollapseHeader from "./CollapseHeader";
import OpenedRow from "./OpenedRow";
import QueryRow from "./QueryRow";
import SettingsFooter from "./SettingsFooter";

/** The explorer sidebar content: an "Opened" section (open tabs), a "Queries"
 * section (saved queries with a filter + refresh), and a static Settings
 * footer. Width is ORGANIZER_WIDTH (200px). */
export default function Sidebar() {
  const store = useAppState();

  const filteredQueries = createMemo(() => {
    const all = store.queries() ?? [];
    const needle = store.state.queryFilter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((q) => q.name.toLowerCase().includes(needle));
  });

  return (
    <aside class="bg-panel border-edge flex h-full w-[200px] flex-col border-r">
      <div class="min-h-0 flex-1 overflow-y-auto">
        {/* Opened */}
        <CollapseHeader
          title="Opened"
          collapsed={store.state.openedCollapsed}
          onToggle={store.toggleOpenedCollapsed}
        />
        <Show when={!store.state.openedCollapsed}>
          <Show
            when={store.state.tabs.length > 0}
            fallback={
              <div class="text-ink-weak flex h-[26px] items-center pl-8 text-sm">
                No open queries
              </div>
            }
          >
            <For each={store.state.tabs}>
              {(tab) => (
                <OpenedRow
                  name={tab.name}
                  active={tab.id === store.state.activeTabId}
                  unsaved={store.isUnsaved(tab.id)}
                  onSelect={() => store.selectTab(tab.id)}
                  onClose={() => store.closeTab(tab.id)}
                />
              )}
            </For>
          </Show>
        </Show>

        {/* Queries */}
        <CollapseHeader
          title="Queries"
          collapsed={store.state.queriesCollapsed}
          onToggle={store.toggleQueriesCollapsed}
          onRefresh={store.refetchQueries}
        />
        <Show when={!store.state.queriesCollapsed}>
          <div class="px-2 py-1">
            <input
              type="text"
              placeholder="Filter"
              class="border-edge bg-panel text-ink placeholder:text-ink-weak focus:border-accent w-full rounded border px-2 py-1 outline-none"
              value={store.state.queryFilter}
              onInput={(e) => store.setQueryFilter(e.currentTarget.value)}
            />
          </div>
          <For each={filteredQueries()}>
            {(query) => (
              <QueryRow
                name={query.name}
                onOpen={() =>
                  store.openTab({
                    id: query.id,
                    name: query.name,
                    definition: query.definition,
                  })
                }
              />
            )}
          </For>
        </Show>
      </div>

      <SettingsFooter />
    </aside>
  );
}
