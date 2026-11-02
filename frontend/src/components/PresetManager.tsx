import { useMemo, type JSX } from "react";
import { Icons, type IconComponent } from "../icons";
import { sectionNoun, type Section } from "../query/definition";
import { groupPresets, type PresetSectionGroup } from "../query/presetGroups";
import { selectPreset, selectPresetDirty } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import PresetEditor from "./builder/PresetEditor";
import PresetDeleteModal from "./PresetDeleteModal";
import PresetDraftModal from "./PresetDraftModal";
import TreeNameField from "./TreeNameField";
import IconButton from "./ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { cx } from "./ui/cx";

// The preset manager: every saved preset of every table, in one tab, listed by
// table and then by section. A row opens the same inline editor a query's
// builder does (sharing its edit buffers, so an edit begun in one shows in the
// other), and its ⋮ menu renames, duplicates or deletes it. "New preset", and
// each section heading's "+", create one.
//
// The Settings menu's "Query presets" and the `presets.manage` command open
// the tab. Its listing state (search, the open editor, an in-place rename)
// lives in the app store's `presetManager`.

const SECTION_ICONS: Record<Section, IconComponent> = {
  filter: Icons.Filter,
  sort: Icons.Sort,
  display: Icons.Display,
};

/** One preset's row, and its editor when open. Its own component so a row's
 * subscriptions are narrow to its own preset. */
function PresetRow(props: { id: string }): JSX.Element | null {
  const preset = useApp((s) => selectPreset(s, props.id));
  const expanded = useApp((s) => s.presetManager.expanded === props.id);
  const renaming = useApp((s) => s.presetManager.renaming === props.id);
  const dirty = useApp((s) => selectPresetDirty(s, props.id));
  const {
    toggleManagedPreset,
    beginPresetRename,
    cancelPresetRename,
    renamePreset,
    duplicatePreset,
    requestPresetDelete,
  } = useAppActions();
  if (!preset) return null;

  // What the row shows of a preset, past its name: whether new queries get it,
  // whether it has edits not yet saved, and — unless its editor is open
  // below, showing all of it — the start of its definition.
  const details = (
    <>
      {preset.isDefault && (
        <span className="border-edge text-ink-weak shrink-0 rounded border px-1.5 text-xs leading-4">
          Default
        </span>
      )}
      {dirty && (
        <Icons.Unsaved
          className="text-danger size-4 shrink-0"
          aria-label="Unsaved changes"
        />
      )}
      {!expanded && (
        <span className="text-ink-weak min-w-0 flex-1 truncate font-mono text-xs">
          {preset.definition.replace(/\s+/g, " ")}
        </span>
      )}
    </>
  );

  return (
    <div className={cx("rounded-md", { "bg-preset": expanded })}>
      <div
        className={cx("flex items-center gap-1 rounded-md pr-1", {
          "hover:bg-hover": !expanded,
        })}
      >
        {renaming ? (
          // Not a button while the name is a field: a field can't sit inside
          // one.
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-sm">
            <ChevronAndIcon expanded={expanded} />
            <TreeNameField
              label="Rename preset"
              name={preset.name}
              onCommit={(name) => renamePreset(props.id, name)}
              onCancel={() => cancelPresetRename()}
            />
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-sm"
            onClick={() => toggleManagedPreset(props.id)}
          >
            <ChevronAndIcon expanded={expanded} />
            <span className="text-ink shrink-0 whitespace-nowrap">
              {preset.name}
            </span>
            {details}
          </button>
        )}
        <Menu
          align="end"
          width="160px"
          trigger={(api) => (
            <IconButton
              icon={Icons.More}
              label={`Actions for ${preset.name}`}
              active={api.open}
              onClick={() => api.toggle()}
            />
          )}
        >
          <MenuItem
            icon={Icons.Rename}
            label="Rename"
            onClick={() => beginPresetRename(props.id)}
          />
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
      </div>
      {expanded && <PresetEditor presetId={props.id} />}
    </div>
  );
}

/** A row's leading expand chevron and preset glyph, as the builder's preset
 * tabs have them. */
function ChevronAndIcon(props: { expanded: boolean }): JSX.Element {
  return (
    <>
      <span className="text-ink-weak flex size-4 shrink-0 items-center justify-center">
        {props.expanded ? <Icons.ExpandOpen /> : <Icons.ExpandClosed />}
      </span>
      <Icons.Preset className="text-ink-weak size-4 shrink-0" />
    </>
  );
}

/** One table's presets for one section, under a heading whose "+" creates
 * another. */
function SectionGroup(props: {
  table: string;
  group: PresetSectionGroup;
}): JSX.Element {
  const { openPresetDraft } = useAppActions();
  const SectionIcon = SECTION_ICONS[props.group.section];
  const noun = sectionNoun(props.group.section);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-ink-weak flex items-center gap-1.5 pl-2 text-xs">
        <SectionIcon className="size-4" />
        <span>{noun}</span>
        <IconButton
          icon={Icons.Add}
          size="sm"
          label={`New ${noun.toLowerCase()} preset for ${props.table}`}
          onClick={() =>
            openPresetDraft({
              baseTable: props.table,
              section: props.group.section,
            })
          }
        />
      </div>
      {props.group.presets.length > 0 ? (
        props.group.presets.map((p) => <PresetRow key={p.id} id={p.id} />)
      ) : (
        <div className="text-ink-weak py-1 pl-[30px] text-sm">None</div>
      )}
    </div>
  );
}

/** The preset manager tab's page. */
export default function PresetManager(): JSX.Element {
  const presets = useApp((s) => s.presets);
  const status = useApp((s) => s.presetsStatus);
  const search = useApp((s) => s.presetManager.search);
  const { setPresetSearch, openPresetDraft } = useAppActions();

  const groups = useMemo(
    () => groupPresets(presets, search),
    [presets, search],
  );

  let empty: string | null = null;
  if (groups.length === 0) {
    if (status === "loading") empty = "Loading presets…";
    else if (status === "error") empty = "The presets couldn't be loaded.";
    else if (search.trim() !== "") empty = "No matching presets";
    else
      empty =
        "No presets yet. Save one from a query's builder, or create one with New preset.";
  }

  return (
    <>
      <div
        data-testid="preset-manager"
        className="bg-panel flex min-h-0 min-w-0 flex-1 flex-col px-3 pt-3"
      >
        <h1 className="text-ink mb-3 text-lg font-semibold">Query presets</h1>

        {/* Search, and New preset. The field stops widening at 420px, as the
            shortcuts editor's does. */}
        <div className="mb-3 flex items-center gap-2">
          <input
            type="text"
            placeholder="Search by name or table"
            className="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent h-[34px] max-w-[420px] min-w-0 flex-1 rounded-md border px-2.5 text-sm outline-none"
            value={search}
            onChange={(e) => setPresetSearch(e.currentTarget.value)}
          />
          <button
            type="button"
            className="border-edge text-ink hover:bg-hover flex h-[34px] shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm"
            onClick={() => openPresetDraft()}
          >
            <Icons.Add className="size-4" />
            New preset
          </button>
        </div>

        {/* The listing takes the rest of the page and scrolls within it. */}
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-3">
          {empty !== null ? (
            <div className="text-ink-weak px-2 py-3 text-[13px]">{empty}</div>
          ) : (
            <div className="flex max-w-[760px] flex-col gap-5">
              {groups.map((g) => (
                <section key={g.table} className="flex flex-col gap-2">
                  <h2 className="text-ink border-edge flex items-center gap-1.5 border-b px-1 pb-1 text-sm font-semibold">
                    <Icons.Table className="text-ink-weak size-4" />
                    {g.table}
                  </h2>
                  {g.sections.map((group) => (
                    <SectionGroup
                      key={group.section}
                      table={g.table}
                      group={group}
                    />
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      <PresetDraftModal />
      <PresetDeleteModal />
    </>
  );
}
