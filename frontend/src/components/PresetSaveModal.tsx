import { Show, type JSX } from "solid-js";
import { useAppState } from "../state/store";
import { sectionNoun } from "../query/definition";
import { Modal } from "./ui/Modal";
import { Checkbox } from "./ui/Checkbox";

/** The "Save as preset" naming dialog — the DOM analog of
 * `builder.rs:render_preset_save_modal`. Confirming creates a preset (locally
 * this session) and points the working definition at it. */
export default function PresetSaveModal(props: { tabId: string }): JSX.Element {
  const store = useAppState();
  const save = () => store.state.presetSave;
  const nameOk = () => (save()?.name.trim() ?? "") !== "";

  return (
    <Show when={save()}>
      {(s) => (
        <Modal onClose={() => store.cancelPresetSave()} width="300px">
          <h2 class="text-ink mb-3 text-base font-semibold">
            Save {sectionNoun(s().section).toLowerCase()} preset
          </h2>
          <input
            type="text"
            autofocus
            placeholder="Preset name"
            class="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent mb-3 w-full rounded-md border px-2.5 py-1.5 text-sm outline-none"
            value={s().name}
            onInput={(e) =>
              store.patchPresetSave({ name: e.currentTarget.value })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameOk())
                store.confirmPresetSave(props.tabId);
            }}
          />
          <Checkbox
            label="Apply by default"
            checked={s().is_default}
            onChange={(checked) =>
              store.patchPresetSave({ is_default: checked })
            }
          />
          <div class="mt-4 flex justify-end gap-2">
            <button
              type="button"
              class="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
              onClick={() => store.cancelPresetSave()}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!nameOk()}
              class="bg-accent text-panel rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
              onClick={() => store.confirmPresetSave(props.tabId)}
            >
              Save
            </button>
          </div>
        </Modal>
      )}
    </Show>
  );
}
