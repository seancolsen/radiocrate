import { createEffect, Match, Show, Switch, type JSX } from "solid-js";
import { useAppState } from "../../state/store";
import { sectionLabel } from "../../query/definition";
import CustomInput from "./CustomInput";
import PresetTab from "./PresetTab";
import PresetEditor from "./PresetEditor";

/** The sort/display builder — the DOM analog of `builder.rs:single_builder_ui`.
 * The section holds exactly one thing: a custom Querydown block, a single
 * (expandable) preset, or the built-in Shuffle preset. */
export default function SingleBuilder(props: {
  tabId: string;
  section: "sort" | "display";
}): JSX.Element {
  const store = useAppState();
  const content = () => store.tab(props.tabId)?.live[props.section];
  const asCustom = () => content() as { custom: string };
  const asPreset = () => content() as { preset: string };

  // `query.focus_sort` / `query.focus_display` open this section and ask for the
  // caret; see the twin effect in `FilterBuilder`. A section holding a preset
  // (or Shuffle) has no text input, so the request is still consumed — the
  // section is open, which is all there is to focus.
  let input: HTMLTextAreaElement | undefined;
  createEffect(() => {
    const req = store.builderFocus();
    if (req?.tabId !== props.tabId || req.section !== props.section) return;
    input?.focus();
    store.clearBuilderFocus();
  });

  return (
    <div class="flex flex-col gap-2">
      <Switch>
        <Match when={content() && "custom" in content()!}>
          <CustomInput
            ref={(el) => (input = el)}
            value={asCustom().custom}
            hint={sectionLabel(props.section)}
            canSave={(store.tab(props.tabId)?.live.base.trim() ?? "") !== ""}
            onInput={(t) =>
              store.setSectionCustomText(props.tabId, props.section, t)
            }
            onClear={() =>
              store.setSectionCustomText(props.tabId, props.section, "")
            }
            onSaveAsPreset={() =>
              store.openPresetSave(props.section, asCustom().custom)
            }
          />
        </Match>
        <Match when={content() && "preset" in content()!}>
          <div class="flex">
            <PresetTab
              name={store.presetName(asPreset().preset)}
              expanded={store.expandedPreset(props.tabId) === asPreset().preset}
              onClick={() =>
                store.toggleExpandPreset(props.tabId, asPreset().preset)
              }
            />
          </div>
          <Show when={store.expandedPreset(props.tabId) === asPreset().preset}>
            <PresetEditor tabId={props.tabId} presetId={asPreset().preset} />
          </Show>
        </Match>
        <Match when={content() && "builtin" in content()!}>
          <div class="flex">
            <PresetTab
              builtin
              name="Shuffle"
              onReshuffle={() => store.reshuffle(props.tabId, props.section)}
            />
          </div>
        </Match>
      </Switch>
    </div>
  );
}
