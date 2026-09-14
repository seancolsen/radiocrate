import { useRef, type JSX } from "react";
import { Icons, type IconComponent } from "../icons";
import { sectionLabel, type Section } from "../query/definition";
import {
  selectBuilderSection,
  selectFullEditorOpen,
  selectIsFullQuery,
  selectIsUnsaved,
  selectResultCount,
} from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import IconButton from "./ui/IconButton";
import SplitButton from "./ui/SplitButton";
import { Menu } from "./ui/Menu";
import PageActionsMenu from "./PageActionsMenu";
import SectionOptionsMenu from "./builder/SectionOptionsMenu";
import QueryBuilder from "./builder/QueryBuilder";
import PresetSaveModal from "./PresetSaveModal";
import ViewSqlModal from "./ViewSqlModal";
import DeleteConfirmModal from "./DeleteConfirmModal";
import { cx } from "./ui/cx";
import { useElementWidth } from "./ui/useElementWidth";

/** Width at/below which the bar drops the section buttons' text labels and the
 * run/filter separator. */
const COMPACT_WIDTH = 500;

const SECTIONS: { section: Section; icon: IconComponent }[] = [
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
 * open section. */
export default function QueryToolbar(props: { tabId: string }): JSX.Element {
  const unsaved = useApp((s) => selectIsUnsaved(s, props.tabId));
  const count = useApp((s) => selectResultCount(s, props.tabId));
  // Full mode swaps the three section toggles for one Querydown toggle, so what
  // "the builder is open" means swaps with it.
  const fullMode = useApp((s) => selectIsFullQuery(s, props.tabId));
  const fullEditorOpen = useApp((s) => selectFullEditorOpen(s, props.tabId));
  const section = useApp((s) => selectBuilderSection(s, props.tabId));
  const builderOpen = fullMode ? fullEditorOpen : section !== null;
  const { saveQuery, runQuery, toggleFullEditor, toggleBuilderSection } =
    useAppActions();

  const containerRef = useRef<HTMLDivElement>(null);
  const compact = useElementWidth(containerRef) <= COMPACT_WIDTH;

  return (
    <div data-testid="query-toolbar" className="bg-panel shrink-0">
      <div
        ref={containerRef}
        className={cx("flex h-[38px] items-center gap-1 px-1.5", {
          "border-edge border-b": !builderOpen,
        })}
      >
        {unsaved && (
          <IconButton
            icon={Icons.Save}
            label="Save"
            onClick={() => saveQuery(props.tabId)}
          />
        )}
        <IconButton
          icon={Icons.Refresh}
          label="Refresh"
          onClick={() => runQuery(props.tabId)}
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

        {!compact && <div className="bg-edge mx-1 h-5 w-px shrink-0" />}

        {fullMode ? (
          <SplitButton
            icon={Icons.Querydown}
            label="Querydown"
            active={fullEditorOpen}
            showLabel={!compact}
            showMenu={false}
            onMainClick={() => toggleFullEditor(props.tabId)}
          />
        ) : (
          SECTIONS.map((s) => (
            <SplitButton
              key={s.section}
              icon={s.icon}
              label={sectionLabel(s.section)}
              active={section === s.section}
              showLabel={!compact}
              onMainClick={() => toggleBuilderSection(props.tabId, s.section)}
              menu={
                <SectionOptionsMenu tabId={props.tabId} section={s.section} />
              }
            />
          ))
        )}

        <div className="flex-1" />
        {count !== undefined && (
          <span className="text-ink-weak pr-2 text-xs whitespace-nowrap">
            {resultCountLabel(count)}
          </span>
        )}
      </div>

      {builderOpen && <QueryBuilder tabId={props.tabId} />}

      <PresetSaveModal tabId={props.tabId} />
      <ViewSqlModal />
      <DeleteConfirmModal />
    </div>
  );
}
