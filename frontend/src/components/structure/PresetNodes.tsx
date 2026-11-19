import type { JSX } from "react";
import type { Preset } from "api-client";
import { Icons, type IconComponent } from "../../icons";
import { sectionNoun, type Section } from "../../query/definition";
import type { PresetSectionGroup } from "../../query/presetGroups";
import {
  presetItemId,
  presetSectionItemId,
  querySettingsItemId,
} from "../../query/structure";
import { useApp, useAppActions } from "../../stores/react";
import PresetRow from "../builder/PresetRow";
import IconButton from "../ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { TreeEmpty, TreeName, TreeNode, useTreeRowProps } from "./Tree";

// A table's query settings on the Data structure page: its presets, a list for
// each section of a query. A preset is the same row, with the same editor, as in
// a query's builder (and the same preset, so a change made in one shows in the
// other), and any number can be open; its ⋮ menu duplicates or deletes it. Each
// list's "+" starts a new preset, unsaved, at the top of it.

const SECTION_ICONS: Record<Section, IconComponent> = {
  filter: Icons.Filter,
  sort: Icons.Sort,
  display: Icons.Display,
};

/** A preset as the page lists it, with its ⋮ menu of what can be done to one
 * outside a query. Its heading is its row of the tree. */
function ManagedPresetRow(props: { id: string; name: string }): JSX.Element {
  const { id } = props;
  const expanded = useApp(
    (s) => s.structure.expanded[presetItemId(id)] === true,
  );
  const { toggleManagedPreset, duplicatePreset, requestPresetDelete } =
    useAppActions();
  const rowProps = useTreeRowProps({
    expanded,
    toggle: (open) => {
      if (open !== expanded) toggleManagedPreset(id);
    },
  });
  return (
    // No box of its own: the preset is as wide as its heading, or, open, as its
    // list, which is between it and the list to decide.
    <div data-tree-node="" className="contents">
      <PresetRow
        id={id}
        expanded={expanded}
        onToggle={() => toggleManagedPreset(id)}
        toggleProps={rowProps}
        actions={
          <Menu
            align="end"
            width="160px"
            trigger={(api) => (
              <IconButton
                icon={Icons.More}
                size="sm"
                nested
                label={`Actions for ${props.name.trim() === "" ? "unnamed preset" : props.name}`}
                active={api.open}
                onClick={() => api.toggle()}
              />
            )}
          >
            <MenuItem
              icon={Icons.Duplicate}
              label="Duplicate"
              onClick={() => duplicatePreset(id)}
            />
            <MenuSeparator />
            <MenuItem
              icon={Icons.Delete}
              label="Delete"
              danger
              onClick={() => requestPresetDelete(id)}
            />
          </Menu>
        }
      />
    </div>
  );
}

/** One table's presets for one section of a query, under a row whose "+" starts
 * another. */
function PresetSectionNode(props: {
  table: string;
  section: Section;
  presets: readonly Preset[];
}): JSX.Element {
  const { table, section } = props;
  const { openPresetDraft } = useAppActions();
  const SectionIcon = SECTION_ICONS[section];
  const noun = sectionNoun(section);
  return (
    <TreeNode
      id={presetSectionItemId(table, section)}
      expandable
      label={
        <>
          <SectionIcon className="text-ink-weak size-4 shrink-0" />
          <TreeName>{noun} presets</TreeName>
        </>
      }
      actions={
        <IconButton
          icon={Icons.Add}
          size="sm"
          label={`New ${noun.toLowerCase()} preset for ${table}`}
          onClick={() => openPresetDraft(table, section)}
        />
      }
    >
      {props.presets.length > 0 ? (
        // A preset is as wide as its heading, unless it's open.
        <div className="flex flex-col items-start gap-1 py-1 pl-5">
          {props.presets.map((p) => (
            <ManagedPresetRow key={p.id} id={p.id} name={p.name} />
          ))}
        </div>
      ) : (
        <TreeEmpty>None</TreeEmpty>
      )}
    </TreeNode>
  );
}

/** A table's "Query settings": its presets, by section. */
export function QuerySettingsNode(props: {
  table: string;
  sections: readonly PresetSectionGroup[];
}): JSX.Element {
  return (
    <TreeNode
      id={querySettingsItemId(props.table)}
      expandable
      label={
        <>
          <Icons.Presets className="text-ink-weak size-4 shrink-0" />
          <TreeName>Query settings</TreeName>
        </>
      }
    >
      {props.sections.map((group) => (
        <PresetSectionNode
          key={group.section}
          table={props.table}
          section={group.section}
          presets={group.presets}
        />
      ))}
    </TreeNode>
  );
}
