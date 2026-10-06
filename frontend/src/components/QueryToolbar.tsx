import { useRef, type JSX } from "react";
import { Icons, type IconComponent } from "../icons";
import { sectionLabel, type Section } from "../query/definition";
import {
  selectBuilderSection,
  selectCanRedo,
  selectCanUndo,
  selectFullEditorOpen,
  selectIsFullQuery,
  selectIsUnsaved,
  selectIsWriting,
  selectResultCount,
  selectRunning,
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
import { cx } from "./ui/cx";
import { useElementWidth } from "./ui/useElementWidth";

/** Width at/below which the bar drops the section buttons' text labels. */
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

function Separator(): JSX.Element {
  return <div className="bg-edge mx-1 h-5 w-px shrink-0" />;
}

/** The query-page toolbar: a top control line over a conditionally-shown
 * builder line for the open section. The control line runs, left to right: the
 * wrench query-actions menu · a separator · the Filter/Sort/Display section
 * toggles · then, each only while it applies, Undo, Redo and Save (behind a
 * separator of their own while any of them shows; Undo and Redo dim while a
 * write to a playlist's entries is in flight) — and, at the far right, the
 * result count and Refresh. */
export default function QueryToolbar(props: { tabId: string }): JSX.Element {
  const unsaved = useApp((s) => selectIsUnsaved(s, props.tabId));
  const canUndo = useApp((s) => selectCanUndo(s, props.tabId));
  const canRedo = useApp((s) => selectCanRedo(s, props.tabId));
  // Undo and Redo wait on a write to the page's playlist entries.
  const writing = useApp((s) => selectIsWriting(s, props.tabId));
  const count = useApp((s) => selectResultCount(s, props.tabId));
  // Full mode swaps the three section toggles for one Querydown toggle, so what
  // "the builder is open" means swaps with it.
  const fullMode = useApp((s) => selectIsFullQuery(s, props.tabId));
  const fullEditorOpen = useApp((s) => selectFullEditorOpen(s, props.tabId));
  const section = useApp((s) => selectBuilderSection(s, props.tabId));
  const running = useApp((s) => selectRunning(s, props.tabId));
  const builderOpen = fullMode ? fullEditorOpen : section !== null;
  const {
    saveQuery,
    runQuery,
    undo,
    redo,
    toggleFullEditor,
    toggleBuilderSection,
  } = useAppActions();

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

        <Separator />

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

        {(canUndo || canRedo || unsaved) && <Separator />}
        {canUndo && (
          <IconButton
            icon={Icons.Undo}
            label="Undo"
            disabled={writing}
            onClick={() => undo(props.tabId)}
          />
        )}
        {canRedo && (
          <IconButton
            icon={Icons.Redo}
            label="Redo"
            disabled={writing}
            onClick={() => redo(props.tabId)}
          />
        )}
        {unsaved && (
          <IconButton
            icon={Icons.Save}
            label="Save"
            onClick={() => saveQuery(props.tabId)}
          />
        )}

        <div className="flex-1" />
        {count !== undefined && (
          <span className="text-ink-weak px-1 text-xs whitespace-nowrap">
            {resultCountLabel(count)}
          </span>
        )}
        {/* The glyph turns while the run it starts is in flight. Its circular
            arrow is drawn centred in the icon's own box, so the default
            transform origin already spins it about the centre of the circle
            rather than about the arrowhead that juts out past it. */}
        <IconButton
          icon={Icons.Refresh}
          label="Refresh"
          iconClassName={cx({ "animate-spin": running })}
          onClick={() => runQuery(props.tabId)}
        />
      </div>

      {builderOpen && <QueryBuilder tabId={props.tabId} />}

      <PresetSaveModal tabId={props.tabId} />
      <ViewSqlModal />
    </div>
  );
}
