import { useLayoutEffect, useRef, type JSX } from "react";
import { Icons } from "../icons";
import { selectIsUnsaved, type TabKind } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import SectionHeading from "./SectionHeading";
import OpenedRow from "./OpenedRow";
import SourceTree from "./SourceTree";
import ExplorerFooter from "./ExplorerFooter";
import { tabIcon } from "./tabKind";
import IconButton from "./ui/IconButton";
import { Menu, MenuItem } from "./ui/Menu";
import ScrollArea from "./ui/ScrollArea";
import { usePersistentSidebar } from "./ui/usePersistentSidebar";

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

/** The Sources search field. Its own component so it takes the caret each time
 * it's shown. Escape hides it again (which clears it). */
function SourceFilterInput(): JSX.Element {
  const sourceFilter = useApp((s) => s.sourceFilter);
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
        placeholder="Search sources"
        aria-label="Search sources"
        className="control border-edge bg-panel text-ink placeholder:text-ink-weak focus:border-accent w-full rounded px-1 outline-none"
        value={sourceFilter}
        onChange={(e) => actions.setSourceFilter(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          actions.toggleSourceFilter();
        }}
      />
    </div>
  );
}

/** The explorer: an "Opened" section (every open tab, whatever page it holds —
 * left out altogether while none is open, and wherever the tab bar stays in
 * view beside a persistent sidebar, saying the same thing),
 * a "Sources" section (the saved queries and playlists, in the folders the user
 * arranges them in, with an actions menu to add a query, playlist or folder,
 * search or refresh), and
 * the footer pinned to the bottom.
 *
 * This is only the contents. The panel it fills — its surface, width, and
 * persistent-column / modal-drawer behavior — belongs to `ui/SidebarLeft`. */
export default function Explorer(): JSX.Element {
  const filterOpen = useApp((s) => s.sourceFilterOpen);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const actions = useAppActions();
  const scrollRef = useRef<HTMLDivElement>(null);
  const showOpened = !usePersistentSidebar() && tabs.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea ref={scrollRef}>
        {showOpened && (
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

        {/* Sources */}
        <SectionHeading title="Sources" spaced={showOpened}>
          <IconButton
            icon={Icons.Search}
            label="Search sources"
            active={filterOpen}
            onClick={actions.toggleSourceFilter}
          />
          <Menu
            align="end"
            width="170px"
            trigger={(api) => (
              <IconButton
                icon={Icons.More}
                label="Source list actions"
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
              icon={Icons.Playlist}
              label="Add playlist"
              onClick={() => actions.addPlaylist(null)}
            />
            <MenuItem
              icon={Icons.NewFolder}
              label="Add folder"
              onClick={() => actions.newFolder(null)}
            />
            <MenuItem
              icon={Icons.Refresh}
              label="Refresh"
              onClick={actions.refetchSources}
            />
          </Menu>
        </SectionHeading>
        {filterOpen && <SourceFilterInput />}
        <SourceTree scrollRef={scrollRef} />
      </ScrollArea>

      <ExplorerFooter />
    </div>
  );
}
