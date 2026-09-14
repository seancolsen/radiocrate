import { useEffect, useRef, useState, type JSX } from "react";
import { Icons } from "../../icons";
import { selectPresetDirty, selectPresetEdit } from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import IconButton from "../ui/IconButton";
import { Checkbox } from "../ui/Checkbox";

/** Inline detail editor for an expanded preset. A pink-tinted panel with an
 * editable name and definition and the "Apply by default" checkbox; while the
 * preset has unsaved edits it also shows the red ✱ marker plus revert and save
 * controls (save enabled once the name is non-empty). The checkbox wraps onto
 * its own line when the panel is too narrow to hold the name, controls, and
 * checkbox side by side. Saving commits locally and re-runs. */
export default function PresetEditor(props: {
  tabId: string;
  presetId: string;
}): JSX.Element {
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

  // Wrap the checkbox onto its own line when the row can't hold the name field,
  // the dirty controls, and the checkbox side by side.
  const [width, setWidth] = useState(9999);
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const wrapDefault = width < (dirty ? 428 : 342);

  const nameOk = (edit?.name.trim() ?? "") !== "";

  const applyByDefault = (
    <Checkbox
      label="Apply by default"
      checked={edit?.isDefault ?? false}
      onChange={(checked) =>
        patchPresetEdit(props.presetId, { isDefault: checked })
      }
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
              placeholder="Preset name"
              className="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent w-[180px] rounded-md border px-2.5 py-1.5 text-sm outline-none"
              value={edit.name}
              onChange={(e) =>
                patchPresetEdit(props.presetId, { name: e.currentTarget.value })
              }
            />
            {dirty && (
              <>
                <Icons.Unsaved
                  className="text-danger size-4"
                  aria-label="Unsaved changes"
                />
                <IconButton
                  icon={Icons.Revert}
                  label="Revert preset changes"
                  onClick={() => revertPresetEdit(props.presetId)}
                />
                <IconButton
                  icon={Icons.Save}
                  label="Save preset"
                  disabled={!nameOk}
                  onClick={() => commitPresetEdit(props.tabId, props.presetId)}
                />
              </>
            )}
            {!wrapDefault && <div className="ml-auto">{applyByDefault}</div>}
          </div>
          {wrapDefault && applyByDefault}
          <textarea
            className="bg-panel border-edge text-ink focus:border-accent block w-full resize-none rounded-md border px-2.5 py-1.5 font-mono text-sm leading-5 outline-none"
            rows={Math.max(1, edit.definition.split("\n").length)}
            spellCheck={false}
            value={edit.definition}
            onChange={(e) =>
              patchPresetEdit(props.presetId, {
                definition: e.currentTarget.value,
              })
            }
          />
        </>
      )}
    </div>
  );
}
