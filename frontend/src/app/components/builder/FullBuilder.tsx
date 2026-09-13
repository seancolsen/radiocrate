import { useRef, type JSX } from "react";
import { selectQueryTab } from "../../stores/app";
import { useApp, useAppActions } from "../../stores/react";
import CustomInput from "./CustomInput";
import { useBuilderFocus } from "./useBuilderFocus";

/** The full-Querydown builder: one editor holding the entire query, base table
 * and all. It replaces the filter/sort/display builders outright (a full-mode
 * query has no sections), so there is nothing here to save as a preset — presets
 * are fragments of a section. */
export default function FullBuilder(props: { tabId: string }): JSX.Element {
  const text = useApp((s) => selectQueryTab(s, props.tabId)?.live.full ?? "");
  const { setFullText } = useAppActions();

  // The `query.focus_*` commands have no section to aim at here, so any of
  // them lands the caret in this one editor (see the twin hook use in
  // `FilterBuilder` and `SingleBuilder`) — no `section` to check.
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  useBuilderFocus(props.tabId, undefined, inputRef);

  return (
    <CustomInput
      ref={inputRef}
      value={text}
      hint="Querydown"
      onInput={(t) => setFullText(props.tabId, t)}
      onClear={() => setFullText(props.tabId, "")}
    />
  );
}
