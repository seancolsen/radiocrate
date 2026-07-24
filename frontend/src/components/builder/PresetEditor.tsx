import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Icons } from "../../icons";
import { useAppState } from "../../state/store";
import IconButton from "../ui/IconButton";
import { Checkbox } from "../ui/Checkbox";

/** Inline detail editor for an expanded preset — the DOM analog of
 * `builder.rs:preset_editor`. A pink-tinted panel with an editable name and
 * definition and the "Apply by default" checkbox; while the preset has unsaved
 * edits it also shows the red ✱ marker plus revert and save controls (save
 * enabled once the name is non-empty). The checkbox wraps onto its own line when
 * the panel is too narrow to hold the name, controls, and checkbox side by side
 * (mirroring the egui width check). Saving commits locally and re-runs. */
export default function PresetEditor(props: {
  tabId: string;
  presetId: string;
}): JSX.Element {
  const store = useAppState();
  // Seed the edit buffer the first time this preset is expanded; a persisted
  // buffer is reused so unsaved changes are never wiped.
  onMount(() => {
    if (!store.presetEdit(props.presetId))
      store.beginPresetEdit(props.presetId);
  });

  const edit = () => store.presetEdit(props.presetId);
  const dirty = () => store.presetDirty(props.presetId);

  // Wrap the checkbox onto its own line when the row can't hold the name field,
  // the dirty controls, and the checkbox side by side (mirrors the egui check).
  const [width, setWidth] = createSignal(9999);
  const wrapDefault = () => width() < (dirty() ? 428 : 342);
  let frame!: HTMLDivElement;
  const ro = new ResizeObserver((entries) => {
    setWidth(entries[0].contentRect.width);
  });
  const attach = (el: HTMLDivElement) => {
    frame = el;
    ro.observe(frame);
  };
  onCleanup(() => ro.disconnect());

  const nameOk = () => (edit()?.name.trim() ?? "") !== "";

  const applyByDefault = () => (
    <Checkbox
      label="Apply by default"
      checked={edit()?.isDefault ?? false}
      onChange={(checked) =>
        store.patchPresetEdit(props.presetId, { isDefault: checked })
      }
    />
  );

  return (
    <div ref={attach} class="bg-preset flex flex-col gap-2 rounded-md p-2">
      <Show when={edit()}>
        {(e) => (
          <>
            <div class="flex items-center gap-2">
              <input
                type="text"
                placeholder="Preset name"
                class="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent w-[180px] rounded-md border px-2.5 py-1.5 text-sm outline-none"
                value={e().name}
                onInput={(ev) =>
                  store.patchPresetEdit(props.presetId, {
                    name: ev.currentTarget.value,
                  })
                }
              />
              <Show when={dirty()}>
                <Icons.Unsaved
                  class="text-danger size-4"
                  aria-label="Unsaved changes"
                />
                <IconButton
                  icon={Icons.Revert}
                  label="Revert preset changes"
                  onClick={() => store.revertPresetEdit(props.presetId)}
                />
                <IconButton
                  icon={Icons.Save}
                  label="Save preset"
                  disabled={!nameOk()}
                  onClick={() =>
                    store.commitPresetEdit(props.tabId, props.presetId)
                  }
                />
              </Show>
              <Show when={!wrapDefault()}>
                <div class="ml-auto">{applyByDefault()}</div>
              </Show>
            </div>
            <Show when={wrapDefault()}>{applyByDefault()}</Show>
            <textarea
              class="bg-panel border-edge text-ink focus:border-accent block w-full resize-none rounded-md border px-2.5 py-1.5 font-mono text-sm leading-5 outline-none"
              rows={Math.max(1, e().definition.split("\n").length)}
              spellcheck={false}
              value={e().definition}
              onInput={(ev) =>
                store.patchPresetEdit(props.presetId, {
                  definition: ev.currentTarget.value,
                })
              }
            />
          </>
        )}
      </Show>
    </div>
  );
}
