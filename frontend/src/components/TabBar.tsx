import {
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Icons } from "../icons";
import { useApp, useAppActions } from "../stores/react";
import { selectIsUnsaved, selectPageTab, type TabKind } from "../stores/app";
import { useTabDragReorder } from "../gestures/useTabDragReorder";
import SourceOptions from "./SourceOptions";
import TabHandle from "./TabHandle";
import { ContextMenu } from "./ui/ContextMenu";
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
  /** Raises the tab's context menu at the pointer — a query's or playlist's
   * options. Other pages have none. */
  onContextMenu: (id: string, x: number, y: number) => void;
}): JSX.Element {
  const unsaved = useApp((s) => selectIsUnsaved(s, props.id));
  // Only a query or playlist has a name to rename.
  const renameable = useApp((s) => selectPageTab(s, props.id) !== undefined);
  const renaming = useApp(
    (s) => s.renaming?.id === props.id && s.renaming.where === "tab",
  );
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
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        if (renameable) props.onContextMenu(props.id, e.clientX, e.clientY);
      }}
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
 * every page the same (select, close, drag to reorder) — except that a query's
 * or playlist's handle raises its options on a right-click (see
 * {@link SourceOptions}), renaming in the handle itself. */
export default function TabBar(): JSX.Element {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const actions = useAppActions();

  const containerRef = useRef<HTMLDivElement>(null);
  const dnd = useTabDragReorder(() => containerRef.current);
  const newQueryTip = useTooltip({ label: "New query", command: "query.new" });
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );

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
          onContextMenu={(id, x, y) => setMenu({ id, x, y })}
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

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <SourceOptions
            id={menu.id}
            onRename={() => actions.beginRename(menu.id)}
          />
        </ContextMenu>
      )}
    </div>
  );
}
