import { For, Show } from "solid-js";
import { useAppState } from "../state/store";
import { useTabDragReorder } from "../gestures/useTabDragReorder";
import { Icons } from "../icons";
import TabHandle from "./TabHandle";

/** The tab bar across the top: the explorer toggle, one handle per open tab
 * (drag-to-reorder), then a "+" new-tab button. Height is TAB_BAR_HEIGHT (34px);
 * the bar background is a step darker than the content panel. */
export default function TabBar() {
  const store = useAppState();
  let container: HTMLDivElement | undefined;
  const drag = useTabDragReorder(store, () => container);

  return (
    <div
      ref={(el) => (container = el)}
      data-testid="tab-bar"
      class="bg-bar flex h-[34px] shrink-0 items-stretch"
    >
      {/* Explorer toggle: always present. */}
      <button
        type="button"
        aria-label={
          store.state.sidebarOpen ? "Close explorer" : "Open explorer"
        }
        class="text-ink-weak hover:bg-hover hover:text-ink flex w-9 shrink-0 items-center justify-center"
        onClick={() => store.toggleSidebar()}
      >
        <Show
          when={store.state.sidebarOpen}
          fallback={<Icons.ExplorerOpen class="size-5" />}
        >
          <Icons.ExplorerClose class="size-5" />
        </Show>
      </button>

      <For each={store.state.tabs}>
        {(tab) => (
          <TabHandle
            id={tab.id}
            name={tab.name}
            active={tab.id === store.state.activeTabId}
            unsaved={store.isUnsaved(tab.id)}
            dragging={drag.draggingId() === tab.id}
            translate={drag.translate()}
            renaming={store.state.renaming?.id === tab.id}
            renameBuffer={store.state.renaming?.buffer ?? ""}
            onSelect={() => store.selectTab(tab.id)}
            onClose={() => store.closeTab(tab.id)}
            onPointerDown={(e) => drag.onPointerDown(e, tab.id)}
            onRenameStart={() => store.beginRename(tab.id)}
            onRenameInput={(text) => store.setRenameBuffer(text)}
            onRenameCommit={() => store.commitRename()}
            onRenameCancel={() => store.cancelRename()}
          />
        )}
      </For>

      {/* New tab (+): visible; inert placeholder this phase. */}
      <button
        type="button"
        aria-label="New tab"
        class="text-ink-weak hover:bg-hover hover:text-ink flex w-9 shrink-0 items-center justify-center"
      >
        <Icons.Add class="size-5" />
      </button>
    </div>
  );
}
