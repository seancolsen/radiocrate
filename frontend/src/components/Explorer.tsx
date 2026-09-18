import { useLayoutEffect, useRef, type JSX } from "react";
import { Icons } from "../icons";
import { selectIsUnsaved, type TabKind } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import CollapseHeader from "./CollapseHeader";
import OpenedRow from "./OpenedRow";
import QueryTree from "./QueryTree";
import SettingsFooter from "./SettingsFooter";
import { tabIcon } from "./tabKind";
import IconButton from "./ui/IconButton";
import { Menu, MenuItem } from "./ui/Menu";

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

/** The Queries filter field. Its own component so it takes the caret each time
 * it's shown. Escape hides it again (which clears it). */
function QueryFilterInput(): JSX.Element {
  const queryFilter = useApp((s) => s.queryFilter);
  const actions = useAppActions();
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div className="px-2 py-1">
      <input
        ref={inputRef}
        type="text"
        placeholder="Filter"
        aria-label="Filter queries"
        className="border-edge bg-panel text-ink placeholder:text-ink-weak focus:border-accent w-full rounded border px-2 py-1 outline-none"
        value={queryFilter}
        onChange={(e) => actions.setQueryFilter(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          actions.toggleQueryFilter();
        }}
      />
    </div>
  );
}

/** The explorer: an "Opened" section (every open tab, whatever page it holds),
 * a "Queries" section (the saved queries, in the folders the user arranges them
 * in, with a filter, a "+" menu and refresh), and the Settings menu footer
 * pinned to the bottom.
 *
 * This is only the contents. The panel it fills — its surface, width, and
 * persistent-column / modal-drawer behavior — belongs to `ui/SidebarLeft`, so
 * the explorer says nothing about being in a sidebar at all. */
export default function Explorer(): JSX.Element {
  const filterOpen = useApp((s) => s.queryFilterOpen);
  const openedCollapsed = useApp((s) => s.openedCollapsed);
  const queriesCollapsed = useApp((s) => s.queriesCollapsed);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const actions = useAppActions();
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
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
        >
          <IconButton
            icon={Icons.Filter}
            label="Filter queries"
            active={filterOpen}
            onClick={() => {
              // Filtering a hidden list would show nothing to filter.
              if (!filterOpen && queriesCollapsed) {
                actions.toggleQueriesCollapsed();
              }
              actions.toggleQueryFilter();
            }}
          />
          <Menu
            align="end"
            width="170px"
            trigger={(api) => (
              <IconButton
                icon={Icons.Add}
                label="New query or folder"
                active={api.open}
                onClick={() => api.toggle()}
              />
            )}
          >
            <MenuItem
              icon={Icons.Query}
              label="New query"
              onClick={actions.newQueryTab}
            />
            <MenuItem
              icon={Icons.NewFolder}
              label="New folder"
              onClick={actions.newFolder}
            />
          </Menu>
          <IconButton
            icon={Icons.Refresh}
            label="Refresh queries"
            onClick={actions.refetchQueries}
          />
        </CollapseHeader>
        {!queriesCollapsed && (
          <>
            {filterOpen && <QueryFilterInput />}
            <QueryTree scrollRef={scrollRef} />
          </>
        )}
      </div>

      <SettingsFooter />
    </div>
  );
}
