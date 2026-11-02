import { useEffect, useRef, type JSX } from "react";
import { Icons } from "../../icons";
import {
  selectPresetDirty,
  selectPresetEdit,
  type PresetEdit,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import IconButton from "../ui/IconButton";
import { Checkbox } from "../ui/Checkbox";
import { useElementWidth } from "../ui/useElementWidth";

/** Inline detail editor for an expanded preset — in a query's builder, or in
 * the preset manager. A pink-tinted panel with an
 * editable name and definition and the "Apply by default" checkbox; while the
 * preset has unsaved edits it also shows the red ✱ marker plus revert and save
 * controls (save enabled once the name is non-empty). The checkbox wraps onto
 * its own line when the panel is too narrow to hold the name, controls, and
 * checkbox side by side. Saving commits the preset and re-runs every open
 * page that uses it. */
export default function PresetEditor(props: { presetId: string }): JSX.Element {
  const edit = useApp((s) => selectPresetEdit(s, props.presetId));
  const dirty = useApp((s) => selectPresetDirty(s, props.presetId));
  const {
    beginPresetEdit,
    patchPresetEdit,
    revertPresetEdit,
    commitPresetEdit,
  } = useAppActions();

  // Seed the edit buffer the first time this preset is expanded; a persisted
  // buffer is reused so unsaved changes are never wiped. This component isn't
  // recreated when a caller switches which preset is expanded (the parent
  // toggles `presetId` in place), so this only ever fires for the preset that
  // was expanded when it first mounted.
  useEffect(() => {
    if (!edit) beginPresetEdit(props.presetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once seed, see comment above
  }, []);

  return (
    <PresetEditorPanel
      edit={edit}
      dirty={dirty}
      onPatch={(patch) => patchPresetEdit(props.presetId, patch)}
      onRevert={() => revertPresetEdit(props.presetId)}
      onSave={() => commitPresetEdit(props.presetId)}
    />
  );
}

/** The editor's panel, over any buffer: a saved preset's edits (above), or a
 * preset not yet created (the preset manager's drafts, which are always
 * "dirty" — their revert discards them and their save creates them, under
 * the labels given). `autoFocus` focuses the name field on mount. */
export function PresetEditorPanel(props: {
  edit: PresetEdit | undefined;
  dirty: boolean;
  onPatch: (patch: Partial<PresetEdit>) => void;
  onRevert: () => void;
  onSave: () => void;
  revertLabel?: string;
  saveLabel?: string;
  autoFocus?: boolean;
}): JSX.Element {
  const { edit, dirty } = props;

  // Wrap the checkbox onto its own line when the row can't hold the name field,
  // the dirty controls, and the checkbox side by side.
  const frameRef = useRef<HTMLDivElement>(null);
  const wrapDefault = useElementWidth(frameRef) < (dirty ? 428 : 342);

  const nameOk = (edit?.name.trim() ?? "") !== "";

  const applyByDefault = (
    <Checkbox
      label="Apply by default"
      checked={edit?.isDefault ?? false}
      onChange={(checked) => props.onPatch({ isDefault: checked })}
    />
  );

  return (
    <div
      ref={frameRef}
      className="bg-preset flex flex-col gap-2 rounded-md p-2"
    >
      {edit && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="text"
              autoFocus={props.autoFocus}
              aria-label="Preset name"
              placeholder="Preset name"
              className="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent w-[180px] rounded-md border px-2.5 py-1.5 text-sm outline-none"
              value={edit.name}
              onChange={(e) => props.onPatch({ name: e.currentTarget.value })}
            />
            {dirty && (
              <>
                <Icons.Unsaved
                  className="text-danger size-4"
                  aria-label="Unsaved changes"
                />
                <IconButton
                  icon={Icons.Revert}
                  label={props.revertLabel ?? "Revert preset changes"}
                  onClick={props.onRevert}
                />
                <IconButton
                  icon={Icons.Save}
                  label={props.saveLabel ?? "Save preset"}
                  disabled={!nameOk}
                  onClick={props.onSave}
                />
              </>
            )}
            {!wrapDefault && <div className="ml-auto">{applyByDefault}</div>}
          </div>
          {wrapDefault && applyByDefault}
          <textarea
            aria-label="Preset definition"
            className="bg-panel border-edge text-ink focus:border-accent block w-full resize-none rounded-md border px-2.5 py-1.5 font-mono text-sm leading-5 outline-none"
            rows={Math.max(1, edit.definition.split("\n").length)}
            spellCheck={false}
            value={edit.definition}
            onChange={(e) =>
              props.onPatch({ definition: e.currentTarget.value })
            }
          />
        </>
      )}
    </div>
  );
}
