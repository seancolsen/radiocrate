import type { JSX } from "react";
import { Icons } from "../../icons";
import type { Section } from "../../query/definition";
import {
  selectPreset,
  selectPresetExpanded,
  selectPresetHasDiagnostic,
} from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import IconButton from "../ui/IconButton";
import PresetRow, { PresetRowView } from "./PresetRow";

/** A preset in a query's builder: what the preset manager shows, opening
 * independently of the page's other presets, with what a query can do about
 * one of its presets — remove it beside the name while it's closed, and fold it
 * into the custom Querydown from within its open editor. A reference to a preset that's been deleted
 * still gets a row, since removing it is how the query gets over it. */
export default function QueryPresetRow(props: {
  tabId: string;
  section: Section;
  id: string;
}): JSX.Element {
  const { tabId, section, id } = props;
  const missing = useApp((s) => selectPreset(s, id) === undefined);
  const expanded = useApp((s) => selectPresetExpanded(s, tabId, id));
  const problem = useApp((s) => selectPresetHasDiagnostic(s, tabId, id));
  const { toggleExpandPreset, inlinePreset, removePreset } = useAppActions();

  const remove = (
    <IconButton
      icon={Icons.Close}
      size="sm"
      nested
      label="Remove preset"
      onClick={() => removePreset(tabId, section, id)}
    />
  );

  if (missing) {
    return (
      <PresetRowView
        name="(missing preset)"
        expanded={false}
        problem={problem}
        onToggle={() => {}}
        actions={remove}
      />
    );
  }

  return (
    <PresetRow
      id={id}
      expanded={expanded}
      problem={problem}
      onToggle={() => toggleExpandPreset(tabId, id)}
      actions={!expanded && remove}
      editorActions={
        <button
          type="button"
          className="control text-ink border-edge hover:bg-hover flex items-center gap-1.5 rounded-md border text-xs"
          onClick={() => inlinePreset(tabId, section, id)}
        >
          <Icons.Merge className="text-ink-weak size-4" />
          Inline into custom
        </button>
      }
    />
  );
}
