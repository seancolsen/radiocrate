import { Match, Switch, type JSX } from "solid-js";
import { useAppState } from "../../state/store";
import FilterBuilder from "./FilterBuilder";
import FullBuilder from "./FullBuilder";
import SingleBuilder from "./SingleBuilder";

/** The toolbar's second line: the open builder's editor, on the panel surface
 * with a hairline bottom divider. Dispatches to the whole-query editor (full
 * mode) or the open section's filter / sort / display builder. Rendered only
 * while one of them is open (the caller guards on that). */
export default function QueryBuilder(props: { tabId: string }): JSX.Element {
  const store = useAppState();
  const section = () => store.builderSection(props.tabId);
  return (
    <div class="bg-panel border-edge border-b px-2 py-2">
      <Switch>
        <Match when={store.isFullQuery(props.tabId)}>
          <FullBuilder tabId={props.tabId} />
        </Match>
        <Match when={section() === "filter"}>
          <FilterBuilder tabId={props.tabId} />
        </Match>
        <Match when={section() === "sort"}>
          <SingleBuilder tabId={props.tabId} section="sort" />
        </Match>
        <Match when={section() === "display"}>
          <SingleBuilder tabId={props.tabId} section="display" />
        </Match>
      </Switch>
    </div>
  );
}
