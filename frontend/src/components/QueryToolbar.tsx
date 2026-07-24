import {
  createSignal,
  For,
  onCleanup,
  Show,
  type Component,
  type JSX,
} from "solid-js";
import { Icons } from "../icons";
import { useAppState } from "../state/store";
import { sectionLabel, type Section } from "../query/definition";
import IconButton from "./ui/IconButton";
import SplitButton from "./ui/SplitButton";
import { Menu } from "./ui/Menu";
import PageActionsMenu from "./PageActionsMenu";
import SectionOptionsMenu from "./builder/SectionOptionsMenu";
import QueryBuilder from "./builder/QueryBuilder";
import PresetSaveModal from "./PresetSaveModal";
import ViewSqlModal from "./ViewSqlModal";
import DeleteConfirmModal from "./DeleteConfirmModal";

/** Width at/below which the bar drops the section buttons' text labels and the
 * run/filter separator (COMPACT_MENU_BAR_WIDTH in `menu_bar.rs`). */
const COMPACT_WIDTH = 500;

const SECTIONS: { section: Section; icon: Component<{ class?: string }> }[] = [
  { section: "filter", icon: Icons.Filter },
  { section: "sort", icon: Icons.Sort },
  { section: "display", icon: Icons.Display },
];

/** A human label for the result count, thousands grouped ("1,362 results"). */
function resultCountLabel(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "result" : "results"}`;
}

/** The query-page toolbar: a top control line (Save while unsaved · Refresh ·
 * the wrench query-actions menu · a separator · the Filter/Sort/Display section
 * toggles · the result count) over a conditionally-shown builder line for the
 * open section. Ported from `frontend-old-egui/src/menu_bar.rs`. */
export default function QueryToolbar(props: { tabId: string }): JSX.Element {
  const store = useAppState();

  const [width, setWidth] = createSignal(9999);
  const compact = () => width() <= COMPACT_WIDTH;
  const ro = new ResizeObserver((entries) =>
    setWidth(entries[0].contentRect.width),
  );
  const observe = (el: HTMLDivElement) => ro.observe(el);
  onCleanup(() => ro.disconnect());

  const count = () => store.resultCount(props.tabId);
  const builderOpen = () => store.builderSection(props.tabId) !== null;

  return (
    <div data-testid="query-toolbar" class="bg-panel shrink-0">
      <div
        ref={observe}
        class="flex h-[38px] items-center gap-1 px-1.5"
        classList={{ "border-edge border-b": !builderOpen() }}
      >
        <Show when={store.isUnsaved(props.tabId)}>
          <IconButton
            icon={Icons.Save}
            label="Save"
            onClick={() => store.saveQuery(props.tabId)}
          />
        </Show>
        <IconButton
          icon={Icons.Refresh}
          label="Refresh"
          onClick={() => store.runQuery(props.tabId)}
        />
        <Menu
          align="start"
          width="210px"
          trigger={(api) => (
            <IconButton
              icon={Icons.Build}
              label="Query actions"
              active={api.open}
              onClick={() => api.toggle()}
            />
          )}
        >
          <PageActionsMenu tabId={props.tabId} />
        </Menu>

        <Show when={!compact()}>
          <div class="bg-edge mx-1 h-5 w-px shrink-0" />
        </Show>

        <For each={SECTIONS}>
          {(s) => (
            <SplitButton
              icon={s.icon}
              label={sectionLabel(s.section)}
              active={store.builderSection(props.tabId) === s.section}
              showLabel={!compact()}
              onMainClick={() =>
                store.toggleBuilderSection(props.tabId, s.section)
              }
              menu={
                <SectionOptionsMenu tabId={props.tabId} section={s.section} />
              }
            />
          )}
        </For>

        <div class="flex-1" />
        <Show when={count() !== undefined}>
          <span class="text-ink-weak pr-2 text-xs whitespace-nowrap">
            {resultCountLabel(count()!)}
          </span>
        </Show>
      </div>

      <Show when={builderOpen()}>
        <QueryBuilder tabId={props.tabId} />
      </Show>

      <PresetSaveModal tabId={props.tabId} />
      <ViewSqlModal />
      <DeleteConfirmModal />
    </div>
  );
}
