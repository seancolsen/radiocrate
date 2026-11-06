import { useRef, type JSX } from "react";
import { Icons } from "../../icons";
import { sectionLabel } from "../../query/definition";
import { sectionGrammar } from "../../editor/querydownEditor";
import {
  selectEditorDiagnostic,
  selectPageBase,
  selectPageSections,
  selectPrelude,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import CustomInput from "./CustomInput";
import { SortEntryActions } from "./EntryActions";
import { BuiltinPresetRow } from "./PresetRow";
import QueryPresetRow from "./QueryPresetRow";
import { useBuilderFocus } from "./useBuilderFocus";

/** The sort/display builder. The section holds exactly one thing: a custom
 * Querydown block, a single (expandable) preset, or a built-in preset —
 * Shuffle, or a playlist's "Playlist order". On a playlist, a sort that
 * applies puts "Commit this track order to playlist" at the foot. */
export default function SingleBuilder(props: {
  tabId: string;
  section: "sort" | "display";
}): JSX.Element {
  const content = useApp(
    (s) => selectPageSections(s, props.tabId)?.[props.section],
  );
  const base = useApp((s) => selectPageBase(s, props.tabId));
  const prelude = useApp(selectPrelude);
  const diagnostic = useApp((s) =>
    selectEditorDiagnostic(s, props.tabId, props.section),
  );
  const { setSectionCustomText, openPresetSave, reshuffle } = useAppActions();

  // `query.focus_sort` / `query.focus_display` open this section and ask for
  // the caret; see the twin hook use in `FilterBuilder`. A section holding a
  // preset (or Shuffle) has no text input, so the request is still consumed —
  // the section is open, which is all there is to focus.
  const inputRef = useRef<HTMLElement>(null);
  useBuilderFocus(props.tabId, props.section, inputRef);

  return (
    <div className="flex flex-col gap-2">
      {content && "custom" in content && (
        <CustomInput
          ref={inputRef}
          value={content.custom}
          context={{
            grammar: sectionGrammar(props.section),
            baseTable: base,
            definitions: prelude,
          }}
          hint={sectionLabel(props.section)}
          diagnostic={diagnostic}
          canSave={base !== ""}
          onInput={(t) => setSectionCustomText(props.tabId, props.section, t)}
          onClear={() => setSectionCustomText(props.tabId, props.section, "")}
          onSaveAsPreset={() => openPresetSave(props.section, content.custom)}
        />
      )}
      {content && "preset" in content && (
        <div className="flex flex-col items-start">
          <QueryPresetRow
            tabId={props.tabId}
            section={props.section}
            id={content.preset}
          />
        </div>
      )}
      {content &&
        "builtin" in content &&
        content.builtin.preset === "shuffle" && (
          <div className="flex">
            <BuiltinPresetRow name="Shuffle">
              <button
                type="button"
                className="border-edge text-ink hover:bg-hover ml-1 flex items-center gap-1.5 rounded border px-2 text-sm"
                onClick={() => reshuffle(props.tabId, props.section)}
              >
                <Icons.Shuffle className="text-ink-weak size-4" />
                Reshuffle
              </button>
            </BuiltinPresetRow>
          </div>
        )}
      {content &&
        "builtin" in content &&
        content.builtin.preset === "playlist_order" && (
          <div className="flex">
            <BuiltinPresetRow name="Playlist order" />
          </div>
        )}
      {props.section === "sort" && <SortEntryActions tabId={props.tabId} />}
    </div>
  );
}
