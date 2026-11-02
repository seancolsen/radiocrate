import { useMemo, type JSX } from "react";
import type { Preset } from "api-client";
import { Icons, type IconComponent } from "../icons";
import { sectionNoun, type Section } from "../query/definition";
import { groupPresets, type PresetTableGroup } from "../query/presetGroups";
import { presetDraftKey, selectPreset, selectPresetDirty } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import PresetEditor, { PresetEditorPanel } from "./builder/PresetEditor";
import PresetDeleteModal from "./PresetDeleteModal";
import IconButton from "./ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { cx } from "./ui/cx";

// The preset manager: every table's saved presets, in one tab, listed by table
// and then by section. Each table collapses to its heading (all of them, at
// once, on a Ctrl+Click). A preset opens the same inline editor a query's
// builder does (sharing its edit buffers, so an edit begun in one shows in the
// other), and its ⋮ menu duplicates or deletes it. Each section heading's "+"
// starts a new preset in that same editor, at the top of the section.
//
// The Settings menu's "Query presets" and the `presets.manage` command open
// the tab. Its listing state (the tables and preset open, the new presets
// being written) lives in the app store's `presetManager`.

const SECTION_ICONS: Record<Section, IconComponent> = {
  filter: Icons.Filter,
  sort: Icons.Sort,
  display: Icons.Display,
};

/** Marks what toggles a preset open or closed, for its frame's hover border. */
const TOGGLE = "preset-toggle";

/** One preset: a heading as wide as its content — name, badges and ⋮ menu —
 * and below it, when open, its editor. Its own component so a row's
 * subscriptions are narrow to its own preset. */
function PresetRow(props: { id: string }): JSX.Element | null {
  const preset = useApp((s) => selectPreset(s, props.id));
  const expanded = useApp((s) => s.presetManager.expanded === props.id);
  const dirty = useApp((s) => selectPresetDirty(s, props.id));
  const { toggleManagedPreset, duplicatePreset, requestPresetDelete } =
    useAppActions();
  if (!preset) return null;

  return (
    // The border lights while the pointer is on anything that toggles.
    <div
      className={cx(
        "bg-preset has-[.preset-toggle:hover]:border-accent max-w-full rounded-md border border-transparent",
        { "self-stretch": expanded },
      )}
    >
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={expanded}
          className={cx(
            TOGGLE,
            "flex min-w-0 items-center gap-1.5 self-stretch py-1 pr-1.5 pl-2 text-left text-sm",
          )}
          onClick={() => toggleManagedPreset(props.id)}
        >
          <span className="text-ink-weak flex size-4 shrink-0 items-center justify-center">
            {expanded ? <Icons.ExpandOpen /> : <Icons.ExpandClosed />}
          </span>
          <span className="text-ink min-w-0 truncate">{preset.name}</span>
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
        </button>
        <div className="shrink-0 py-0.5 pr-0.5">
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
        {/* The rest of an open preset's heading toggles it too. A pointer
            target only: the button is the heading's keyboard control. */}
        {expanded && (
          <div
            aria-hidden="true"
            className={cx(TOGGLE, "min-w-0 flex-1 self-stretch")}
            onClick={() => toggleManagedPreset(props.id)}
          />
        )}
      </div>
      {expanded && <PresetEditor presetId={props.id} />}
    </div>
  );
}

/** A new preset being written at the top of `table`'s `section`, in the
 * editor a saved one opens: its revert discards it, and its save creates it.
 * Its parent keys it by the draft's id, so a fresh draft (a duplicate in place
 * of one being written) gets a fresh, focused name field. */
function PresetDraftRow(props: {
  table: string;
  section: Section;
}): JSX.Element | null {
  const { table, section } = props;
  const draft = useApp(
    (s) => s.presetManager.drafts[presetDraftKey(table, section)],
  );
  const { patchPresetDraft, cancelPresetDraft, confirmPresetDraft } =
    useAppActions();
  if (!draft) return null;
  return (
    <div className="bg-preset self-stretch rounded-md border border-transparent">
      <PresetEditorPanel
        edit={draft}
        dirty
        autoFocus
        onPatch={(patch) => patchPresetDraft(table, section, patch)}
        onRevert={() => cancelPresetDraft(table, section)}
        onSave={() => confirmPresetDraft(table, section)}
        revertLabel="Discard new preset"
        saveLabel="Create preset"
      />
    </div>
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
  const draftId = useApp(
    (s) => s.presetManager.drafts[presetDraftKey(table, section)]?.id,
  );
  const { openPresetDraft } = useAppActions();
  const SectionIcon = SECTION_ICONS[section];
  const noun = sectionNoun(section);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 pl-2 text-xs">
        <SectionIcon className="text-ink-weak size-4" />
        <span className="text-ink">{noun}</span>
        <IconButton
          icon={Icons.Add}
          size="sm"
          label={`New ${noun.toLowerCase()} preset for ${table}`}
          onClick={() => openPresetDraft(table, section)}
        />
      </div>
      {/* Indented under the heading, a preset's chevron lining up with its
          label. A preset is as wide as its heading, unless it's open. */}
      <div className="flex flex-col items-start gap-1 pl-[21px]">
        {draftId !== undefined && (
          <PresetDraftRow key={draftId} table={table} section={section} />
        )}
        {props.presets.length > 0
          ? props.presets.map((p) => <PresetRow key={p.id} id={p.id} />)
          : draftId === undefined && (
              <div className="text-ink-weak py-0.5 pl-[9px] text-xs">None</div>
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
  const { toggleManagedTable } = useAppActions();
  return (
    <section className="flex flex-col">
      <h2 className="border-edge border-b">
        <button
          type="button"
          aria-expanded={expanded}
          className="text-ink hover:bg-hover flex w-full items-center gap-1.5 rounded-t-md px-1 py-1 text-left text-sm font-semibold"
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
        <div className="flex flex-col gap-3 pt-2 pb-4">
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
  const tables = useApp((s) => s.schema.tables);
  const status = useApp((s) => s.presetsStatus);

  const groups = useMemo(
    () =>
      groupPresets(
        presets,
        tables.map((t) => t.name),
      ),
    [presets, tables],
  );

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
