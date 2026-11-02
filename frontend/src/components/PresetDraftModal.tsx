import { useLayoutEffect, useRef, type JSX } from "react";
import { asSection, SECTIONS, sectionNoun } from "../query/definition";
import type { PresetDraft } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { Checkbox } from "./ui/Checkbox";
import { Modal } from "./ui/Modal";

const FIELD_CLASS =
  "bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent rounded-md border px-2.5 py-1.5 text-sm outline-none";

/** The dialog's body, mounted fresh each time it opens — which is what gives
 * the name field a freshly-focused caret every time (as `PresetSaveModal`). */
function PresetDraftModalBody(props: { draft: PresetDraft }): JSX.Element {
  const { draft } = props;
  const tables = useApp((s) => s.schema.tables);
  const { patchPresetDraft, cancelPresetDraft, confirmPresetDraft } =
    useAppActions();
  const canCreate = draft.name.trim() !== "" && draft.baseTable.trim() !== "";

  // The schema's tables — plus the draft's own, should it name one the schema
  // doesn't list (or hasn't loaded yet), so the select can still show it.
  const tableNames = tables.map((t) => t.name);
  if (!tableNames.includes(draft.baseTable))
    tableNames.unshift(draft.baseTable);

  const fieldRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, []);

  return (
    <Modal onClose={() => cancelPresetDraft()} width="420px">
      <h2 className="text-ink mb-3 text-base font-semibold">
        {draft.duplicateOf === null ? "New preset" : "Duplicate preset"}
      </h2>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canCreate) confirmPresetDraft();
        }}
      >
        <input
          ref={fieldRef}
          type="text"
          aria-label="Preset name"
          placeholder="Preset name"
          className={FIELD_CLASS}
          value={draft.name}
          onChange={(e) => patchPresetDraft({ name: e.currentTarget.value })}
        />
        <div className="flex gap-2">
          <label className="text-ink flex min-w-0 flex-1 flex-col gap-1 text-xs">
            Table
            <select
              className={FIELD_CLASS}
              value={draft.baseTable}
              onChange={(e) =>
                patchPresetDraft({ baseTable: e.currentTarget.value })
              }
            >
              {tableNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-ink flex min-w-0 flex-1 flex-col gap-1 text-xs">
            Section
            <select
              className={FIELD_CLASS}
              value={draft.section}
              onChange={(e) =>
                patchPresetDraft({ section: asSection(e.currentTarget.value) })
              }
            >
              {SECTIONS.map((section) => (
                <option key={section} value={section}>
                  {sectionNoun(section)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          aria-label="Preset definition"
          placeholder="Querydown"
          className={`${FIELD_CLASS} block w-full resize-y font-mono leading-5`}
          rows={4}
          spellCheck={false}
          value={draft.definition}
          onChange={(e) =>
            patchPresetDraft({ definition: e.currentTarget.value })
          }
        />
        <Checkbox
          label="Apply by default"
          checked={draft.isDefault}
          onChange={(checked) => patchPresetDraft({ isDefault: checked })}
        />
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            className="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
            onClick={() => cancelPresetDraft()}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className="bg-accent text-panel rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The preset manager's "New preset" / "Duplicate preset" dialog: name,
 * table, section, definition and "Apply by default", all editable. Creating
 * saves the preset and opens it in the manager. */
export default function PresetDraftModal(): JSX.Element | null {
  const draft = useApp((s) => s.presetDraft);
  return draft ? <PresetDraftModalBody draft={draft} /> : null;
}
