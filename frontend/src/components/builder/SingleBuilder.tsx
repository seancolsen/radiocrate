import { useRef, type JSX } from "react";
import { sectionLabel } from "../../query/definition";
import {
  selectExpandedPreset,
  selectPageBase,
  selectPageSections,
  selectPresetName,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import CustomInput from "./CustomInput";
import { SortEntryActions } from "./EntryActions";
import PresetEditor from "./PresetEditor";
import PresetTab from "./PresetTab";
import { useBuilderFocus } from "./useBuilderFocus";

/** The sort/display builder. The section holds exactly one thing: a custom
 * Querydown block, a single (expandable) preset, or a built-in preset —
 * Shuffle, or a playlist's "Playlist order". On a playlist, a sort that
 * applies puts "Commit this track order to playlist" at the foot. */
export default function SingleBuilder(props: {
  tabId: string;
  section: "sort" | "display";
}): JSX.Element {
  const content = useApp(
    (s) => selectPageSections(s, props.tabId)?.[props.section],
  );
  const base = useApp((s) => selectPageBase(s, props.tabId));
  const expandedPreset = useApp((s) => selectExpandedPreset(s, props.tabId));
  const presetId = content && "preset" in content ? content.preset : undefined;
  const presetName = useApp((s) =>
    presetId ? selectPresetName(s, presetId) : "",
  );
  const {
    setSectionCustomText,
    openPresetSave,
    toggleExpandPreset,
    reshuffle,
  } = useAppActions();

  // `query.focus_sort` / `query.focus_display` open this section and ask for
  // the caret; see the twin hook use in `FilterBuilder`. A section holding a
  // preset (or Shuffle) has no text input, so the request is still consumed —
  // the section is open, which is all there is to focus.
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  useBuilderFocus(props.tabId, props.section, inputRef);

  return (
    <div className="flex flex-col gap-2">
      {content && "custom" in content && (
        <CustomInput
          ref={inputRef}
          value={content.custom}
          hint={sectionLabel(props.section)}
          canSave={base !== ""}
          onInput={(t) => setSectionCustomText(props.tabId, props.section, t)}
          onClear={() => setSectionCustomText(props.tabId, props.section, "")}
          onSaveAsPreset={() => openPresetSave(props.section, content.custom)}
        />
      )}
      {content && "preset" in content && (
        <>
          <div className="flex">
            <PresetTab
              name={presetName}
              expanded={expandedPreset === content.preset}
              onClick={() => toggleExpandPreset(props.tabId, content.preset)}
            />
          </div>
          {expandedPreset === content.preset && (
            <PresetEditor tabId={props.tabId} presetId={content.preset} />
          )}
        </>
      )}
      {content &&
        "builtin" in content &&
        content.builtin.preset === "shuffle" && (
          <div className="flex">
            <PresetTab
              builtin
              name="Shuffle"
              onReshuffle={() => reshuffle(props.tabId, props.section)}
            />
          </div>
        )}
      {content &&
        "builtin" in content &&
        content.builtin.preset === "playlist_order" && (
          <div className="flex">
            <PresetTab builtin name="Playlist order" />
          </div>
        )}
      {props.section === "sort" && <SortEntryActions tabId={props.tabId} />}
    </div>
  );
}
