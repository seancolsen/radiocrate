import type { JSX } from "react";
import { selectBuilderSection, selectIsFullQuery } from "../../stores/app";
import { useApp } from "../../stores/react";
import FilterBuilder from "./FilterBuilder";
import FullBuilder from "./FullBuilder";
import SingleBuilder from "./SingleBuilder";

/** The toolbar's second line: the open builder's editor, on the panel surface
 * with a hairline bottom divider. Dispatches to the whole-query editor (full
 * mode) or the open section's filter / sort / display builder. Rendered only
 * while one of them is open (the caller guards on that). */
export default function QueryBuilder(props: { tabId: string }): JSX.Element {
  const fullQuery = useApp((s) => selectIsFullQuery(s, props.tabId));
  const section = useApp((s) => selectBuilderSection(s, props.tabId));

  return (
    <div className="bg-panel border-edge border-b px-2 py-2">
      {fullQuery ? (
        <FullBuilder tabId={props.tabId} />
      ) : section === "filter" ? (
        <FilterBuilder tabId={props.tabId} />
      ) : section === "sort" ? (
        <SingleBuilder tabId={props.tabId} section="sort" />
      ) : section === "display" ? (
        <SingleBuilder tabId={props.tabId} section="display" />
      ) : null}
    </div>
  );
}
