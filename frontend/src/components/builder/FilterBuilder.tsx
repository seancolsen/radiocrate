import { For, Show, type JSX } from "solid-js";
import { useAppState } from "../../state/store";
import CustomInput from "./CustomInput";
import PresetTab from "./PresetTab";
import PresetEditor from "./PresetEditor";

/** The filter builder — the DOM analog of `builder.rs:filter_builder_ui`. A
 * custom Querydown input combined (via AND at run time) with any number of
 * presets, the latter shown as right-aligned tabs beside the input. When the
 * input would grow too narrow the tabs wrap to their own right-aligned row below
 * it (flex-wrap, mirroring the egui width check). Expanding a preset reveals its
 * inline editor full-width below the row. */
export default function FilterBuilder(props: { tabId: string }): JSX.Element {
  const store = useAppState();
  const live = () => store.tab(props.tabId)?.live;
  const presets = () => live()?.filter.presets ?? [];
  const canSave = () => (live()?.base.trim() ?? "") !== "";
  const expandedInFilter = () => {
    const e = store.expandedPreset(props.tabId);
    return e && presets().includes(e) ? e : null;
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-start gap-2">
        <div class="min-w-0 flex-1 basis-[400px]">
          <CustomInput
            value={live()?.filter.custom ?? ""}
            hint="Filter"
            canSave={canSave()}
            onInput={(t) => store.setFilterCustom(props.tabId, t)}
            onClear={() => store.clearFilterCustom(props.tabId)}
            onSaveAsPreset={() =>
              store.openPresetSave("filter", live()?.filter.custom ?? "")
            }
          />
        </div>
        <Show when={presets().length > 0}>
          <div class="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
            <For each={presets()}>
              {(id) => (
                <PresetTab
                  name={store.presetName(id)}
                  expanded={store.expandedPreset(props.tabId) === id}
                  onClick={() => store.toggleExpandPreset(props.tabId, id)}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
      <Show when={expandedInFilter()}>
        {(id) => <PresetEditor tabId={props.tabId} presetId={id()} />}
      </Show>
    </div>
  );
}
