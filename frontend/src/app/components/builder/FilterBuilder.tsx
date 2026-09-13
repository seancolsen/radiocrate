import { useRef, type JSX } from "react";
import {
  selectExpandedPreset,
  selectPresetName,
  selectQueryTab,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import CustomInput from "./CustomInput";
import PresetEditor from "./PresetEditor";
import PresetTab from "./PresetTab";
import { useBuilderFocus } from "./useBuilderFocus";

/** One preset tab in the filter row, subscribed narrowly to its own name and
 * expanded state — like `Explorer`'s `OpenedTabRow` — so one preset's tab
 * doesn't re-render because another's expanded. */
function FilterPresetTab(props: { tabId: string; id: string }): JSX.Element {
  const name = useApp((s) => selectPresetName(s, props.id));
  const expanded = useApp(
    (s) => selectExpandedPreset(s, props.tabId) === props.id,
  );
  const { toggleExpandPreset } = useAppActions();
  return (
    <PresetTab
      name={name}
      expanded={expanded}
      onClick={() => toggleExpandPreset(props.tabId, props.id)}
    />
  );
}

/** The filter builder. A custom Querydown input combined (via AND at run time)
 * with any number of presets, the latter shown as right-aligned tabs beside
 * the input. When the input would grow too narrow the tabs wrap to their own
 * right-aligned row below it (flex-wrap). Expanding a preset reveals its
 * inline editor full-width below the row. */
export default function FilterBuilder(props: { tabId: string }): JSX.Element {
  const live = useApp((s) => selectQueryTab(s, props.tabId)?.live);
  const expandedPreset = useApp((s) => selectExpandedPreset(s, props.tabId));
  const { setFilterCustom, clearFilterCustom, openPresetSave } =
    useAppActions();

  const presets = live?.filter.presets ?? [];
  const canSave = (live?.base.trim() ?? "") !== "";
  const expandedInFilter =
    expandedPreset && presets.includes(expandedPreset) ? expandedPreset : null;

  // `query.focus_filter` opens this section and asks for the caret. The
  // request is consumed once: `useBuilderFocus` also fires on mount (when the
  // command is what opened the section), so a later manual open doesn't
  // re-steal focus.
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  useBuilderFocus(props.tabId, "filter", inputRef);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-[400px]">
          <CustomInput
            ref={inputRef}
            value={live?.filter.custom ?? ""}
            hint="Filter"
            canSave={canSave}
            onInput={(t) => setFilterCustom(props.tabId, t)}
            onClear={() => clearFilterCustom(props.tabId)}
            onSaveAsPreset={() =>
              openPresetSave("filter", live?.filter.custom ?? "")
            }
          />
        </div>
        {presets.length > 0 && (
          <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
            {presets.map((id) => (
              <FilterPresetTab key={id} tabId={props.tabId} id={id} />
            ))}
          </div>
        )}
      </div>
      {expandedInFilter && (
        <PresetEditor tabId={props.tabId} presetId={expandedInFilter} />
      )}
    </div>
  );
}
