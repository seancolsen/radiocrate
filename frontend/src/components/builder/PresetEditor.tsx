import { useEffect, useMemo, useRef, type JSX } from "react";
import { Icons } from "../../icons";
import { checkFragment } from "../../query/compile";
import { asSection } from "../../query/definition";
import { sectionGrammar } from "../../editor/querydownEditor";
import {
  selectPreset,
  selectPresetIsNew,
  selectPresetUnsaved,
  selectPrelude,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import IconButton from "../ui/IconButton";
import { Checkbox } from "../ui/Checkbox";
import { useElementWidth } from "../ui/useElementWidth";
import QuerydownEditor from "./QuerydownEditor";
import DiagnosticMessage, { diagnosticPlace } from "./DiagnosticMessage";
import { useCheckContext, useSettledDiagnostic } from "./useDiagnostics";

/** Inline detail editor for an open preset — in a query's builder, or in the
 * preset manager: its editable name and definition, and the "Apply by default"
 * checkbox, which wraps onto its own line when the panel is too narrow to hold
 * it beside the name.
 *
 * Every change is in force at once and saved by itself (see `patchPreset`),
 * and leaving the editor sends what's waiting without waiting for the app to go
 * quiet. A hidden tab's effects are cleaned up too, so that counts as leaving.
 * Save and Revert only show when that isn't working out: for a preset that's
 * never been saved (revert discards it), or after a failed write or with a
 * blank name.
 *
 * The definition is checked as it's typed, compiled as the preset's section of a
 * query on its table, and a problem with it shows under it. A new preset
 * focuses its name on mount. */
export default function PresetEditor(props: { presetId: string }): JSX.Element {
  const { presetId } = props;
  const preset = useApp((s) => selectPreset(s, presetId));
  const isNew = useApp((s) => selectPresetIsNew(s, presetId));
  const unsaved = useApp((s) => selectPresetUnsaved(s, presetId));
  const { patchPreset, savePreset, revertPreset, flushPresetSave } =
    useAppActions();

  useEffect(() => () => flushPresetSave(presetId), [presetId, flushPresetSave]);

  // Wrap the checkbox onto its own line when the row can't hold the name field,
  // the save controls, and the checkbox side by side.
  const frameRef = useRef<HTMLDivElement>(null);
  const wrapDefault = useElementWidth(frameRef) < (unsaved ? 400 : 342);

  const baseTable = preset?.baseTable ?? "";
  const section = asSection(preset?.section ?? "filter");
  const definition = preset?.definition;
  const name = preset?.name ?? "";

  const check = useCheckContext();
  const schemaJson = check?.schemaJson;
  const prelude = useApp(selectPrelude);
  const latest = useMemo(
    () =>
      schemaJson === undefined || definition === undefined || baseTable === ""
        ? null
        : checkFragment(schemaJson, prelude, baseTable, section, definition, {
            kind: "preset",
            id: presetId,
            section,
          }),
    [schemaJson, prelude, baseTable, section, definition, presetId],
  );
  const problem = useSettledDiagnostic(latest);

  const applyByDefault = (
    <Checkbox
      label="Apply by default"
      checked={preset?.isDefault ?? false}
      onChange={(checked) => patchPreset(presetId, { isDefault: checked })}
    />
  );

  return (
    <div ref={frameRef} className="flex flex-col gap-1.5 px-1.5 pt-0.5 pb-1.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          autoFocus={isNew}
          aria-label="Preset name"
          placeholder="Preset name"
          className="control bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent w-[180px] rounded-md outline-none"
          value={name}
          onChange={(e) =>
            patchPreset(presetId, { name: e.currentTarget.value })
          }
        />
        {unsaved && (
          <>
            <IconButton
              icon={Icons.Revert}
              label={isNew ? "Discard new preset" : "Revert preset changes"}
              onClick={() => revertPreset(presetId)}
            />
            <IconButton
              icon={Icons.Save}
              label={isNew ? "Create preset" : "Save preset"}
              disabled={name.trim() === ""}
              onClick={() => savePreset(presetId)}
            />
          </>
        )}
        {!wrapDefault && <div className="ml-auto">{applyByDefault}</div>}
      </div>
      {wrapDefault && applyByDefault}
      <QuerydownEditor
        label="Preset definition"
        value={definition ?? ""}
        context={{
          grammar: sectionGrammar(section),
          baseTable,
          definitions: prelude,
        }}
        onChange={(text) => patchPreset(presetId, { definition: text })}
        diagnostic={problem?.origin?.kind === "preset" ? problem : null}
      />
      {problem && (
        <DiagnosticMessage
          diagnostic={problem}
          place={diagnosticPlace(problem, name.trim())}
        />
      )}
    </div>
  );
}
