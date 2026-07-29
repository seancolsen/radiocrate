import { createEffect, type JSX } from "solid-js";
import { useAppState } from "../../state/store";
import CustomInput from "./CustomInput";

/** The full-Querydown builder: one editor holding the entire query, base table
 * and all. It replaces the filter/sort/display builders outright (a full-mode
 * query has no sections), so there is nothing here to save as a preset — presets
 * are fragments of a section. */
export default function FullBuilder(props: { tabId: string }): JSX.Element {
  const store = useAppState();
  const text = () => store.queryTab(props.tabId)?.live.full ?? "";

  // The `query.focus_*` commands have no section to aim at here, so any of them
  // lands the caret in this one editor (see the twin effects in `FilterBuilder`
  // and `SingleBuilder`).
  let input: HTMLElement | undefined;
  createEffect(() => {
    if (store.builderFocus()?.tabId !== props.tabId) return;
    input?.focus();
    store.clearBuilderFocus();
  });

  return (
    <CustomInput
      ref={(el) => (input = el)}
      value={text()}
      hint="Querydown"
      onInput={(t) => store.setFullText(props.tabId, t)}
      onClear={() => store.setFullText(props.tabId, "")}
    />
  );
}
