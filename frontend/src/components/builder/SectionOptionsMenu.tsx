import type { JSX } from "react";
import { useShallow } from "zustand/shallow";
import { Icons } from "../../icons";
import {
  sectionLabel,
  sectionSeedText,
  type Section,
} from "../../query/definition";
import { selectPresetsFor, selectQueryTab } from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import { MenuHeading, MenuSeparator, MenuToggleItem } from "../ui/Menu";

/** The body of a section's ⋮ options menu — the shared flat list. The filter
 * section combines presets, so its rows are checkboxes (toggle membership);
 * sort/display pick exactly one thing, so theirs are radios (exclusive).
 * Rendered inside the `SplitButton`'s `Menu`.
 *
 * Layout: the always-present "Custom …" entry, then (sort-of-track only) the
 * built-in Shuffle preset under a BUILT-IN heading, then the user presets. */
export default function SectionOptionsMenu(props: {
  tabId: string;
  section: Section;
}): JSX.Element {
  const live = useApp((s) => selectQueryTab(s, props.tabId)?.live);
  const presets = useApp(
    useShallow((s) =>
      selectPresetsFor(
        s,
        selectQueryTab(s, props.tabId)?.live.base.trim() ?? "",
        props.section,
      ),
    ),
  );
  const allPresets = useApp((s) => s.presets);
  const { setSectionContent, toggleFilterPreset, reshuffle } = useAppActions();

  const base = live?.base.trim() ?? "";
  const kind = props.section === "filter" ? "checkbox" : "radio";
  const customLabel = `Custom ${sectionLabel(props.section).toLowerCase()}`;
  const showShuffle =
    props.section === "sort" && base.toLowerCase() === "track";

  // Filter: "Custom filter" is always checked and disabled (it can't be removed).
  // Sort/display: the custom radio is selected when the section holds custom text.
  const customChecked =
    props.section === "filter"
      ? true
      : live != null && "custom" in live[props.section];
  const shuffleChecked = live != null && "builtin" in live.sort;
  const presetChecked = (id: string): boolean => {
    if (props.section === "filter")
      return live?.filter.presets.includes(id) ?? false;
    const content = live?.[props.section];
    return content != null && "preset" in content && content.preset === id;
  };

  const chooseCustom = () => {
    if (props.section === "filter") return; // disabled — no-op
    const content = live?.[props.section];
    if (!content || "custom" in content) return; // already custom
    setSectionContent(props.tabId, props.section, {
      custom: sectionSeedText(content, allPresets),
    });
  };
  const choosePreset = (id: string) => {
    if (props.section === "filter") {
      toggleFilterPreset(props.tabId, id);
    } else if (!presetChecked(id)) {
      setSectionContent(props.tabId, props.section, { preset: id });
    }
  };

  return (
    <div className="min-w-[220px]">
      <MenuToggleItem
        kind={kind}
        icon={Icons.Custom}
        label={customLabel}
        checked={customChecked}
        disabled={props.section === "filter"}
        onClick={chooseCustom}
      />
      {showShuffle && (
        <>
          <MenuSeparator />
          <MenuHeading text="BUILT IN PRESETS" />
          <MenuToggleItem
            kind="radio"
            icon={Icons.Shuffle}
            label="Shuffle"
            checked={shuffleChecked}
            onClick={() => {
              if (!shuffleChecked) reshuffle(props.tabId, "sort");
            }}
          />
        </>
      )}
      {presets.length > 0 && (
        <>
          <MenuSeparator />
          <MenuHeading text="USER DEFINED PRESETS" />
          {presets.map((preset) => (
            <MenuToggleItem
              key={preset.id}
              kind={kind}
              icon={Icons.Preset}
              label={preset.name}
              checked={presetChecked(preset.id)}
              onClick={() => choosePreset(preset.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}
