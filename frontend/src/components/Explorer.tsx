import { useLayoutEffect, useRef, type JSX } from "react";
import { Icons } from "../icons";
import { selectIsUnsaved, type TabKind } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import SectionHeading from "./SectionHeading";
import OpenedRow from "./OpenedRow";
import QueryTree from "./QueryTree";
import SettingsFooter from "./SettingsFooter";
import { tabIcon } from "./tabKind";
import IconButton from "./ui/IconButton";
import { Menu, MenuItem, MenuToggleItem } from "./ui/Menu";

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

/** The explorer: an "Opened" section (every open tab, whatever page it holds —
 * left out altogether while none is open),
 * a "Queries" section (the saved queries, in the folders the user arranges them
 * in, with an actions menu to add a query or folder, filter or refresh), and
 * the Settings menu footer pinned to the bottom.
 *
 * This is only the contents. The panel it fills — its surface, width, and
 * persistent-column / modal-drawer behavior — belongs to `ui/SidebarLeft`, so
 * the explorer says nothing about being in a sidebar at all. */
export default function Explorer(): JSX.Element {
  const filterOpen = useApp((s) => s.queryFilterOpen);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const actions = useAppActions();
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {/* Opened — only while something is. */}
        {tabs.length > 0 && (
          <>
            <SectionHeading title="Opened" spaced={false} />
            {tabs.map((tab) => (
              <OpenedTabRow
                key={tab.id}
                tabId={tab.id}
                name={tab.name}
                kind={tab.kind}
                active={tab.id === activeTabId}
              />
            ))}
          </>
        )}

        {/* Queries */}
        <SectionHeading title="Queries" spaced={tabs.length > 0}>
          <Menu
            align="end"
            width="170px"
            trigger={(api) => (
              <IconButton
                icon={Icons.More}
                label="Query list actions"
                active={api.open}
                onClick={() => api.toggle()}
              />
            )}
          >
            <MenuItem
              icon={Icons.Query}
              label="Add query"
              onClick={() => actions.addQuery(null)}
            />
            <MenuItem
              icon={Icons.NewFolder}
              label="Add folder"
              onClick={actions.newFolder}
            />
            <MenuToggleItem
              kind="checkbox"
              icon={Icons.Filter}
              label="Filter"
              checked={filterOpen}
              onClick={actions.toggleQueryFilter}
            />
            <MenuItem
              icon={Icons.Refresh}
              label="Refresh"
              onClick={actions.refetchQueries}
            />
          </Menu>
        </SectionHeading>
        {filterOpen && <QueryFilterInput />}
        <QueryTree scrollRef={scrollRef} />
      </div>

      <SettingsFooter />
    </div>
  );
}
