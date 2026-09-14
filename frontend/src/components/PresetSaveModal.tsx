import { useLayoutEffect, useRef, type JSX } from "react";
import { sectionNoun } from "../query/definition";
import { useApp, useAppActions } from "../stores/react";
import type { PresetSave } from "../stores/app";
import { Checkbox } from "./ui/Checkbox";
import { Modal } from "./ui/Modal";

/** The dialog's body, mounted fresh each time a save is pending — which is what
 * gives the name field a freshly-focused caret every time (see
 * `PresetSaveModal`'s conditional render below, and `SettingModal`'s identical
 * split). */
function PresetSaveModalBody(props: {
  tabId: string;
  save: PresetSave;
}): JSX.Element {
  const { cancelPresetSave, patchPresetSave, confirmPresetSave } =
    useAppActions();
  const nameOk = props.save.name.trim() !== "";

  const fieldRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    fieldRef.current?.focus();
  }, []);

  return (
    <Modal onClose={() => cancelPresetSave()} width="300px">
      <h2 className="text-ink mb-3 text-base font-semibold">
        Save {sectionNoun(props.save.section).toLowerCase()} preset
      </h2>
      <input
        ref={fieldRef}
        type="text"
        placeholder="Preset name"
        className="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent mb-3 w-full rounded-md border px-2.5 py-1.5 text-sm outline-none"
        value={props.save.name}
        onChange={(e) => patchPresetSave({ name: e.currentTarget.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && nameOk) confirmPresetSave(props.tabId);
        }}
      />
      <Checkbox
        label="Apply by default"
        checked={props.save.isDefault}
        onChange={(checked) => patchPresetSave({ isDefault: checked })}
      />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => cancelPresetSave()}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!nameOk}
          className="bg-accent text-panel rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => confirmPresetSave(props.tabId)}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

/** The "Save as preset" naming dialog. Confirming creates a preset (locally
 * this session) and points the working definition at it. */
export default function PresetSaveModal(props: {
  tabId: string;
}): JSX.Element | null {
  const save = useApp((s) => s.presetSave);
  return save ? <PresetSaveModalBody tabId={props.tabId} save={save} /> : null;
}
