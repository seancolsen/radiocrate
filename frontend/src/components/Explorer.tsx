import { useMemo, type JSX } from "react";
import { selectIsUnsaved, type TabKind } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import CollapseHeader from "./CollapseHeader";
import OpenedRow from "./OpenedRow";
import QueryRow from "./QueryRow";
import SettingsFooter from "./SettingsFooter";
import { tabIcon } from "./tabKind";

/** One "Opened" row, wired to the store. Split out from {@link Explorer} so its
 * unsaved-star subscription (`selectIsUnsaved`) is narrow to this one tab — an
 * edit to one tab's draft re-renders only its own row, not the whole list. */
function OpenedTabRow(props: {
  tabId: string;
  name: string;
  kind: TabKind;
  active: boolean;
}): JSX.Element {
  const unsaved = useApp((s) => selectIsUnsaved(s, props.tabId));
  const actions = useAppActions();
  return (
    <OpenedRow
      name={props.name}
      icon={tabIcon(props.kind)}
      active={props.active}
      unsaved={unsaved}
      onSelect={() => actions.selectTab(props.tabId)}
      onClose={() => actions.closeTab(props.tabId)}
    />
  );
}

/** The explorer: an "Opened" section (every open tab, whatever page it holds),
 * a "Queries" section (saved queries with a filter + refresh), and the Settings
 * menu footer pinned to the bottom.
 *
 * This is only the contents. The panel it fills — its surface, width, and
 * persistent-column / modal-drawer behavior — belongs to `ui/SidebarLeft`, so
 * the explorer says nothing about being in a sidebar at all. */
export default function Explorer(): JSX.Element {
  const queries = useApp((s) => s.queries.data);
  const queryFilter = useApp((s) => s.queryFilter);
  const openedCollapsed = useApp((s) => s.openedCollapsed);
  const queriesCollapsed = useApp((s) => s.queriesCollapsed);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const actions = useAppActions();

  const filteredQueries = useMemo(() => {
    const needle = queryFilter.trim().toLowerCase();
    if (!needle) return queries;
    return queries.filter((q) => q.name.toLowerCase().includes(needle));
  }, [queries, queryFilter]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Opened */}
        <CollapseHeader
          title="Opened"
          collapsed={openedCollapsed}
          onToggle={actions.toggleOpenedCollapsed}
        />
        {!openedCollapsed &&
          (tabs.length > 0 ? (
            tabs.map((tab) => (
              <OpenedTabRow
                key={tab.id}
                tabId={tab.id}
                name={tab.name}
                kind={tab.kind}
                active={tab.id === activeTabId}
              />
            ))
          ) : (
            <div className="text-ink-weak flex h-[26px] items-center pl-8 text-sm">
              No open queries
            </div>
          ))}

        {/* Queries */}
        <CollapseHeader
          title="Queries"
          collapsed={queriesCollapsed}
          onToggle={actions.toggleQueriesCollapsed}
          onRefresh={actions.refetchQueries}
        />
        {!queriesCollapsed && (
          <>
            <div className="px-2 py-1">
              <input
                type="text"
                placeholder="Filter"
                className="border-edge bg-panel text-ink placeholder:text-ink-weak focus:border-accent w-full rounded border px-2 py-1 outline-none"
                value={queryFilter}
                onChange={(e) => actions.setQueryFilter(e.currentTarget.value)}
              />
            </div>
            {filteredQueries.map((query) => (
              <QueryRow
                key={query.id}
                name={query.name}
                onOpen={() =>
                  actions.openTab({
                    id: query.id,
                    name: query.name,
                    definition: query.definition,
                  })
                }
              />
            ))}
          </>
        )}
      </div>

      <SettingsFooter />
    </div>
  );
}
