import { useRef, type JSX, type PointerEvent } from "react";
import { Icons } from "../icons";
import { useApp, useAppActions } from "../stores/react";
import { selectIsUnsaved, type TabKind } from "../stores/app";
import { useTabDragReorder } from "../gestures/useTabDragReorder";
import TabHandle from "./TabHandle";
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
  translate: number;
  onPointerDown: (e: PointerEvent<HTMLElement>, id: string) => void;
}): JSX.Element {
  const unsaved = useApp((s) => selectIsUnsaved(s, props.id));
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
      renameable={props.kind === "query"}
      dragging={props.dragging}
      translate={props.translate}
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

/** The tab bar across the top: the explorer toggle, one handle per open tab
 * (drag-to-reorder), then a "+" new-tab button. Height is TAB_BAR_HEIGHT (34px);
 * the bar background is a step darker than the content panel.
 *
 * Kind-agnostic: a handle takes its icon from the tab's kind and otherwise treats
 * every page the same (select, close, drag to reorder). */
export default function TabBar(): JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const actions = useAppActions();

  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useTabDragReorder(() => containerRef.current);

  return (
    <div
      ref={containerRef}
      data-testid="tab-bar"
      className="bg-bar flex h-[34px] shrink-0 items-stretch"
    >
      {/* Explorer toggle: always present. */}
      <button
        type="button"
        aria-label={sidebarOpen ? "Close explorer" : "Open explorer"}
        className="text-ink-weak hover:bg-hover hover:text-ink flex w-9 shrink-0 items-center justify-center"
        onClick={() => actions.toggleSidebar()}
      >
        {sidebarOpen ? (
          <Icons.ExplorerClose className="size-5" />
        ) : (
          <Icons.ExplorerOpen className="size-5" />
        )}
      </button>

      {tabs.map((tab) => (
        <WiredTabHandle
          key={tab.id}
          id={tab.id}
          name={tab.name}
          kind={tab.kind}
          active={tab.id === activeTabId}
          dragging={drag.draggingId === tab.id}
          translate={drag.translate}
          onPointerDown={drag.onPointerDown}
        />
      ))}

      {/* New tab (+): opens a fresh ephemeral "track" query. */}
      <button
        type="button"
        aria-label="New tab"
        className="text-ink-weak hover:bg-hover hover:text-ink flex w-9 shrink-0 items-center justify-center"
        onClick={() => actions.newQueryTab()}
      >
        <Icons.Add className="size-5" />
      </button>
    </div>
  );
}
