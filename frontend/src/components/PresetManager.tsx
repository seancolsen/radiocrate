import { useEffect, useMemo, useRef, type JSX } from "react";
import type { Preset } from "api-client";
import { Icons, type IconComponent } from "../icons";
import { sectionNoun, usesPreset, type Section } from "../query/definition";
import { groupPresets, type PresetTableGroup } from "../query/presetGroups";
import { useApp, useAppActions } from "../stores/react";
import PresetRow from "./builder/PresetRow";
import PresetDeleteModal from "./PresetDeleteModal";
import IconButton from "./ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { cx } from "./ui/cx";

// The preset manager: every table's saved presets, in one tab, listed by table
// and then by section. Each table collapses to its heading (all of them, at
// once, on a Ctrl+Click). A preset is the same row, with the same editor, as in
// a query's builder (and the same preset, so a change made in one shows in the
// other), and any number can be open; its ⋮ menu duplicates or deletes it. Each
// section heading's "+" starts a new preset, unsaved, at the top of the section.
//
// The Settings menu's "Query presets", the `presets.manage` command and a
// section menu's "Manage presets" open the tab. Its listing state (the tables and
// presets open, the new presets being written) lives in the app store's
// `presetManager`.

const SECTION_ICONS: Record<Section, IconComponent> = {
  filter: Icons.Filter,
  sort: Icons.Sort,
  display: Icons.Display,
};

/** A preset as the manager lists it, with its ⋮ menu of what can be done to one
 * outside a query. */
function ManagedPresetRow(props: { id: string; name: string }): JSX.Element {
  const expanded = useApp((s) => s.presetManager.expanded.includes(props.id));
  const { toggleManagedPreset, duplicatePreset, requestPresetDelete } =
    useAppActions();
  return (
    <PresetRow
      id={props.id}
      expanded={expanded}
      onToggle={() => toggleManagedPreset(props.id)}
      actions={
        <Menu
          align="end"
          width="160px"
          trigger={(api) => (
            <IconButton
              icon={Icons.More}
              size="sm"
              label={`Actions for ${props.name.trim() === "" ? "unnamed preset" : props.name}`}
              active={api.open}
              onClick={() => api.toggle()}
            />
          )}
        >
          <MenuItem
            icon={Icons.Duplicate}
            label="Duplicate"
            onClick={() => duplicatePreset(props.id)}
          />
          <MenuSeparator />
          <MenuItem
            icon={Icons.Delete}
            label="Delete"
            danger
            onClick={() => requestPresetDelete(props.id)}
          />
        </Menu>
      }
    />
  );
}

/** One table's presets for one section, under a heading whose "+" starts
 * another. */
function SectionGroup(props: {
  table: string;
  section: Section;
  presets: readonly Preset[];
}): JSX.Element {
  const { table, section } = props;
  const { openPresetDraft } = useAppActions();
  const SectionIcon = SECTION_ICONS[section];
  const noun = sectionNoun(section);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-sm">
        <SectionIcon className="text-ink-weak size-4" />
        <span className="text-ink">{noun}</span>
        <IconButton
          icon={Icons.Add}
          size="sm"
          label={`New ${noun.toLowerCase()} preset for ${table}`}
          onClick={() => openPresetDraft(table, section)}
        />
      </div>
      {/* A preset is as wide as its heading, unless it's open. */}
      <div className="flex flex-col items-start gap-1">
        {props.presets.length > 0 ? (
          props.presets.map((p) => (
            <ManagedPresetRow key={p.id} id={p.id} name={p.name} />
          ))
        ) : (
          <div className="text-ink-weak py-0.5 text-xs">None</div>
        )}
      </div>
    </div>
  );
}

/** One table: a heading that collapses it, with its preset count, and its
 * three sections when it's expanded. */
function TableGroup(props: { group: PresetTableGroup }): JSX.Element {
  const { table, count, sections } = props.group;
  const expanded = useApp((s) =>
    s.presetManager.expandedTables.includes(table),
  );
  const reveal = useApp((s) => s.presetManager.revealTable === table);
  const { toggleManagedTable, clearPresetManagerReveal } = useAppActions();

  // "Manage presets" asks for this table. Run once the page is showing, which
  // an effect only is.
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!reveal) return;
    sectionRef.current?.scrollIntoView({ block: "start" });
    clearPresetManagerReveal();
  }, [reveal, clearPresetManagerReveal]);

  return (
    <section ref={sectionRef} className="flex flex-col">
      <h2 className={cx({ "border-edge border-b": !expanded })}>
        <button
          type="button"
          aria-expanded={expanded}
          className={cx(
            "text-ink hover:bg-hover flex w-full items-center gap-1.5 px-1 py-1 text-left text-base font-semibold",
            expanded ? "rounded-md" : "rounded-t-md",
          )}
          onClick={(e) => toggleManagedTable(table, e.ctrlKey || e.metaKey)}
        >
          <span className="text-ink-weak flex size-4 shrink-0 items-center justify-center">
            {expanded ? <Icons.ExpandOpen /> : <Icons.ExpandClosed />}
          </span>
          <Icons.Table className="text-ink-weak size-4 shrink-0" />
          <span className="min-w-0 truncate">{table}</span>
          <span
            className="bg-hover text-ink-weak min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs leading-4 font-normal tabular-nums"
            aria-label={`${count} ${count === 1 ? "preset" : "presets"}`}
          >
            {count}
          </span>
        </button>
      </h2>
      {expanded && (
        /* Its left edge lines up with the heading's table icon. */
        <div className="flex flex-col gap-3 pt-1 pb-4 pl-[26px]">
          {sections.map((group) => (
            <SectionGroup
              key={group.section}
              table={table}
              section={group.section}
              presets={group.presets}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** The preset manager tab's page. */
export default function PresetManager(): JSX.Element {
  const presets = useApp((s) => s.presets);
  const unsaved = useApp((s) => s.unsavedPresets);
  const drafts = useApp((s) => s.presetManager.drafts);
  const listedNames = useApp((s) => s.presetManager.listedNames);
  const openTabs = useApp((s) => s.tabs);
  const tables = useApp((s) => s.schema.tables);
  const status = useApp((s) => s.presetsStatus);

  const groups = useMemo(() => {
    // An unsaved preset is here as long as it's being written, here or in a
    // query.
    const listed = unsaved.filter(
      (p) =>
        drafts.includes(p.id) ||
        openTabs.some(
          (t) =>
            (t.kind === "query" || t.kind === "playlist") &&
            usesPreset(t.live, p.id),
        ),
    );
    return groupPresets(
      [...presets, ...listed],
      tables.map((t) => t.name),
      listedNames,
    );
  }, [presets, unsaved, drafts, openTabs, tables, listedNames]);

  let empty: string | null = null;
  if (groups.length === 0) {
    if (status === "loading") empty = "Loading presets…";
    else if (status === "error") empty = "The presets couldn't be loaded.";
    else empty = "No tables";
  }

  return (
    <>
      {/* The listing takes the whole page and scrolls within it. */}
      <div
        data-testid="preset-manager"
        className="bg-panel min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3"
      >
        {empty !== null ? (
          <div className="text-ink-weak px-2 py-3 text-[13px]">{empty}</div>
        ) : (
          <div className="flex flex-col gap-1">
            {groups.map((g) => (
              <TableGroup key={g.table} group={g} />
            ))}
          </div>
        )}
      </div>

      <PresetDeleteModal />
    </>
  );
}
