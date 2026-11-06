import { useRef, type JSX } from "react";
import {
  selectEditorDiagnostic,
  selectPageBase,
  selectPageSections,
  selectPrelude,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import CustomInput from "./CustomInput";
import { FilterEntryActions } from "./EntryActions";
import QueryPresetRow from "./QueryPresetRow";
import { useBuilderFocus } from "./useBuilderFocus";

/** The filter builder. A custom Querydown input combined (via AND at run time)
 * with any number of presets, listed below it, one to a line, each opening its
 * own inline editor. On a playlist, a filter that applies puts "Remove these
 * tracks" and "Keep only these tracks" at the foot. */
export default function FilterBuilder(props: { tabId: string }): JSX.Element {
  const live = useApp((s) => selectPageSections(s, props.tabId));
  const base = useApp((s) => selectPageBase(s, props.tabId));
  const canSave = base !== "";
  const prelude = useApp(selectPrelude);
  const diagnostic = useApp((s) =>
    selectEditorDiagnostic(s, props.tabId, "filter"),
  );
  const { setFilterCustom, clearFilterCustom, openPresetSave } =
    useAppActions();

  const presets = live?.filter.presets ?? [];

  // `query.focus_filter` opens this section and asks for the caret. The
  // request is consumed once: `useBuilderFocus` also fires on mount (when the
  // command is what opened the section), so a later manual open doesn't
  // re-steal focus.
  const inputRef = useRef<HTMLElement>(null);
  useBuilderFocus(props.tabId, "filter", inputRef);

  return (
    <div className="flex flex-col gap-2">
      <CustomInput
        ref={inputRef}
        value={live?.filter.custom ?? ""}
        context={{
          grammar: "conditions",
          baseTable: base,
          definitions: prelude,
        }}
        hint="Filter"
        diagnostic={diagnostic}
        canSave={canSave}
        onInput={(t) => setFilterCustom(props.tabId, t)}
        onClear={() => clearFilterCustom(props.tabId)}
        onSaveAsPreset={() =>
          openPresetSave("filter", live?.filter.custom ?? "")
        }
      />
      {presets.length > 0 && (
        <div className="flex flex-col items-start gap-1">
          {presets.map((id) => (
            <QueryPresetRow
              key={id}
              tabId={props.tabId}
              section="filter"
              id={id}
            />
          ))}
        </div>
      )}
      <FilterEntryActions tabId={props.tabId} />
    </div>
  );
}
