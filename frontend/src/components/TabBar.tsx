import { useRef, type JSX, type PointerEvent } from "react";
import { Icons } from "../icons";
import { useApp, useAppActions } from "../stores/react";
import { selectIsUnsaved, selectPageTab, type TabKind } from "../stores/app";
import { useTabDragReorder } from "../gestures/useTabDragReorder";
import TabHandle from "./TabHandle";
import { useTooltip } from "./ui/Tooltip";
import { tabIcon } from "./tabKind";

/** One tab handle, wired to the store. Split out from {@link TabBar} so its
 * unsaved-star subscription (`selectIsUnsaved`) is narrow to this one tab — an
 * edit to one tab's draft re-renders only its own handle, not the whole bar. */
function WiredTabHandle(props: {
  id: string;
  name: string;
  kind: TabKind;
  active: boolean;
  dragging: boolean;
  onPointerDown: (e: PointerEvent<HTMLElement>, id: string) => void;
}): JSX.Element {
  const unsaved = useApp((s) => selectIsUnsaved(s, props.id));
  // Only a query or playlist has a name to rename.
  const renameable = useApp((s) => selectPageTab(s, props.id) !== undefined);
  const renaming = useApp((s) => s.renaming?.id === props.id);
  const renameBuffer = useApp((s) =>
    s.renaming?.id === props.id ? s.renaming.buffer : "",
  );
  const actions = useAppActions();
  return (
    <TabHandle
      id={props.id}
      name={props.name}
      icon={tabIcon(props.kind)}
      active={props.active}
      unsaved={unsaved}
      renameable={renameable}
      dragging={props.dragging}
      renaming={renaming}
      renameBuffer={renameBuffer}
      onSelect={() => actions.selectTab(props.id)}
      onClose={() => actions.closeTab(props.id)}
      onPointerDown={(e) => props.onPointerDown(e, props.id)}
      onRenameStart={() => actions.beginRename(props.id)}
      onRenameInput={(text) => actions.setRenameBuffer(text)}
      onRenameCommit={() => actions.commitRename()}
      onRenameCancel={() => actions.cancelRename()}
    />
  );
}

/** Opens and closes the explorer. Its own component so that its tooltip goes
 * with it when the last tab closes, even from under a resting pointer. */
function ExplorerToggle(): JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const actions = useAppActions();
  const tip = useTooltip({
    label: sidebarOpen ? "Close explorer" : "Open explorer",
    command: "explorer.toggle",
  });
  return (
    <>
      <button
        type="button"
        {...tip.triggerProps}
        className="text-ink-weak hover:text-ink flex w-9 shrink-0 items-center justify-center"
        onClick={() => actions.toggleSidebar()}
      >
        {sidebarOpen ? (
          <Icons.ExplorerClose className="size-5" />
        ) : (
          <Icons.ExplorerOpen className="size-5" />
        )}
      </button>
      {tip.tooltip}
    </>
  );
}

/** The tab bar across the top: the explorer toggle, one handle per open tab
 * (drag-to-reorder: the dragged handle stays put, dimmed, and an accent line
 * marks the gap it would drop into), then a new-query button. Height is TAB_BAR_HEIGHT (34px);
 * the bar background is a step darker than the content panel.
 *
 * Kind-agnostic: a handle takes its icon from the tab's kind and otherwise treats
 * every page the same (select, close, drag to reorder). */
export default function TabBar(): JSX.Element {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const actions = useAppActions();

  const containerRef = useRef<HTMLDivElement>(null);
  const dnd = useTabDragReorder(() => containerRef.current);
  const newQueryTip = useTooltip({ label: "New query", command: "query.new" });

  return (
    <div
      ref={containerRef}
      data-testid="tab-bar"
      className="bg-bar relative flex h-[34px] shrink-0 items-stretch"
    >
      {/* With no tabs open, the explorer is held open: nothing to toggle. */}
      {tabs.length > 0 && <ExplorerToggle />}

      {tabs.map((tab) => (
        <WiredTabHandle
          key={tab.id}
          id={tab.id}
          name={tab.name}
          kind={tab.kind}
          active={tab.id === activeTabId}
          dragging={dnd.drag?.id === tab.id}
          onPointerDown={dnd.onPointerDown}
        />
      ))}

      {dnd.drag?.gap != null && (
        <div
          aria-hidden="true"
          className="bg-accent pointer-events-none absolute top-1 bottom-1 z-10 w-0.5 -translate-x-1/2 rounded-full"
          style={{ left: dnd.drag.lineLeft }}
        />
      )}

      {/* New query: a fresh, unsaved "track" query. (A new playlist comes
          from the explorer, which saves it as it's created.) */}
      <button
        type="button"
        {...newQueryTip.triggerProps}
        className="text-ink-weak hover:text-ink flex w-9 shrink-0 items-center justify-center"
        onClick={() => actions.newQueryTab()}
      >
        <Icons.Query className="size-5" />
      </button>
      {newQueryTip.tooltip}
    </div>
  );
}
