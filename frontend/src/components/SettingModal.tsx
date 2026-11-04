import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { checkPrelude } from "../query/compile";
import type { QueryDiagnostic } from "../query/diagnostics";
import { selectSettingValue } from "../stores/app";
import { useApp, useAppActions } from "../stores/react";
import { SETTINGS, type SettingKey } from "../state/settings";
import DiagnosticMessage, {
  diagnosticPlace,
} from "./builder/DiagnosticMessage";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "./builder/useDiagnostics";
import QuerydownEditor from "./builder/QuerydownEditor";
import { Modal } from "./ui/Modal";

/** The editor for one setting: its name, what it does, and its value in a
 * monospace text area — the values here are code (the Querydown prelude), not
 * prose. Takes its values as props, like {@link AboutDialog}, so the visual
 * harness can render it without a backend; {@link SettingModal} is the wired
 * version.
 *
 * Edits are held in a local draft until Save, so Cancel (and Escape) leave the
 * stored value alone. "Reset to default" only fills the draft with the default —
 * saving that is what actually clears the customization, since the store records
 * a value equal to the default as no override at all.
 *
 * `diagnose`, given, checks the draft as it's typed: a problem with it shows
 * under the field, and keeps it from being saved. */
export function SettingDialog(props: {
  name: string;
  description: string;
  value: string;
  defaultValue: string;
  diagnose?: (value: string) => QueryDiagnostic | null;
  onSave: (value: string) => void;
  onClose: () => void;
}): JSX.Element {
  // The draft is `undefined` until the first edit, and the field shows the
  // stored value until then — rather than seeding state from `props.value`,
  // which would read it once and never again if the prop later changed.
  const [edited, setEdited] = useState<string>();
  const draft = edited ?? props.value;
  const isDefault = draft === props.defaultValue;
  const changed = draft !== props.value;
  const { diagnose } = props;
  const latest = useMemo(() => diagnose?.(draft) ?? null, [diagnose, draft]);
  const problem = useSettledDiagnostic(latest);

  // Focus the field, with the caret where the editor starts it: at the top of
  // the value, scrolled to its first line.
  const fieldRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    fieldRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <Modal onClose={() => props.onClose()} width="640px">
      <h2 className="text-ink mb-1 text-base font-semibold">{props.name}</h2>
      <p className="text-ink-weak mb-3 text-sm">{props.description}</p>
      <QuerydownEditor
        ref={fieldRef}
        look="sheet"
        label={props.name}
        value={draft}
        onChange={setEdited}
        diagnostic={problem}
      />
      {problem && (
        <div className="mt-2">
          <DiagnosticMessage
            diagnostic={problem}
            place={diagnosticPlace(problem)}
          />
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={isDefault}
          className="text-ink hover:bg-hover mr-auto rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => setEdited(props.defaultValue)}
        >
          Reset to default
        </button>
        <button
          type="button"
          className="text-ink hover:bg-hover rounded-md px-3 py-1.5 text-sm"
          onClick={() => props.onClose()}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!changed || latest !== null}
          title={latest ? "Fix the problem to save" : undefined}
          className="bg-accent text-panel rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
          onClick={() => props.onSave(draft)}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

/** The setting editor wired to the store: raised by the Settings menu's entry
 * for whichever setting it names, saved back through `saveSetting` (which
 * persists it and re-runs the open queries under the new value). */
function SettingModalBody(props: { settingKey: SettingKey }): JSX.Element {
  const value = useApp((s) => selectSettingValue(s, props.settingKey));
  const actions = useAppActions();
  const definition = SETTINGS[props.settingKey];
  // The prelude is checked as it's typed; nothing else is Querydown.
  const schemaJson = useCheckContext()?.schemaJson;
  const isPrelude = props.settingKey === "querydown_prelude";
  const diagnose = useCallback(
    (value: string) =>
      schemaJson === undefined ? null : checkPrelude(schemaJson, value),
    [schemaJson],
  );

  return (
    <SettingDialog
      name={definition.name}
      description={definition.description}
      value={value}
      defaultValue={definition.default}
      diagnose={isPrelude ? diagnose : undefined}
      onSave={(next) => {
        actions.saveSetting(props.settingKey, next);
        actions.closeSetting();
      }}
      onClose={() => actions.closeSetting()}
    />
  );
}

/** The setting editor's mount point: an app-wide overlay, like the About
 * dialog. */
export default function SettingModal(): JSX.Element | null {
  const settingEditor = useApp((s) => s.settingEditor);
  return settingEditor ? <SettingModalBody settingKey={settingEditor} /> : null;
}
