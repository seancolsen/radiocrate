import { For, Show, type JSX } from "solid-js";
import { Icons } from "../../icons";
import { useAppState } from "../../state/store";
import {
  sectionLabel,
  sectionSeedText,
  type Section,
} from "../../query/definition";
import { MenuHeading, MenuSeparator, MenuToggleItem } from "../ui/Menu";

/** The body of a section's ⋮ options menu — the shared flat list from
 * `builder.rs:section_options_menu`. The filter section combines presets, so its
 * rows are checkboxes (toggle membership); sort/display pick exactly one thing,
 * so theirs are radios (exclusive). Rendered inside the `SplitButton`'s `Menu`.
 *
 * Layout: the always-present "Custom …" entry, then (sort-of-track only) the
 * built-in Shuffle preset under a BUILT-IN heading, then the user presets. */
export default function SectionOptionsMenu(props: {
  tabId: string;
  section: Section;
}): JSX.Element {
  const store = useAppState();
  const live = () => store.queryTab(props.tabId)?.live;
  const base = () => live()?.base.trim() ?? "";
  const kind = () => (props.section === "filter" ? "checkbox" : "radio");
  const customLabel = () =>
    `Custom ${sectionLabel(props.section).toLowerCase()}`;

  const presets = () => store.presetsFor(base(), props.section);
  const showShuffle = () =>
    props.section === "sort" && base().toLowerCase() === "track";

  // Filter: "Custom filter" is always checked and disabled (it can't be removed).
  // Sort/display: the custom radio is selected when the section holds custom text.
  const customChecked = () => {
    if (props.section === "filter") return true;
    const content = live()?.[props.section];
    return content != null && "custom" in content;
  };
  const shuffleChecked = () => {
    const content = live()?.sort;
    return content != null && "builtin" in content;
  };
  const presetChecked = (id: string): boolean => {
    if (props.section === "filter")
      return live()?.filter.presets.includes(id) ?? false;
    const content = live()?.[props.section];
    return content != null && "preset" in content && content.preset === id;
  };

  const chooseCustom = () => {
    if (props.section === "filter") return; // disabled — no-op
    const content = live()?.[props.section];
    if (!content || "custom" in content) return; // already custom
    store.setSectionContent(props.tabId, props.section, {
      custom: sectionSeedText(content, store.state.presets),
    });
  };
  const choosePreset = (id: string) => {
    if (props.section === "filter") {
      store.toggleFilterPreset(props.tabId, id);
    } else if (!presetChecked(id)) {
      store.setSectionContent(props.tabId, props.section, { preset: id });
    }
  };

  return (
    <div class="min-w-[220px]">
      <MenuToggleItem
        kind={kind()}
        icon={Icons.Custom}
        label={customLabel()}
        checked={customChecked()}
        disabled={props.section === "filter"}
        onClick={chooseCustom}
      />
      <Show when={showShuffle()}>
        <MenuSeparator />
        <MenuHeading text="BUILT IN PRESETS" />
        <MenuToggleItem
          kind="radio"
          icon={Icons.Shuffle}
          label="Shuffle"
          checked={shuffleChecked()}
          onClick={() => {
            if (!shuffleChecked()) store.reshuffle(props.tabId, "sort");
          }}
        />
      </Show>
      <Show when={presets().length > 0}>
        <MenuSeparator />
        <MenuHeading text="USER DEFINED PRESETS" />
        <For each={presets()}>
          {(preset) => (
            <MenuToggleItem
              kind={kind()}
              icon={Icons.Preset}
              label={preset.name}
              checked={presetChecked(preset.id)}
              onClick={() => choosePreset(preset.id)}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
