import { forwardRef } from "react";
import { Icons } from "../../icons";
import type { QueryDiagnostic } from "../../query/diagnostics";
import type { QuerydownContext } from "../../editor/querydownEditor";
import { Menu, MenuItem } from "../ui/Menu";
import { useTooltip } from "../ui/Tooltip";
import { NESTED_FOCUS_CLASS, cx } from "../ui/cx";
import QuerydownEditor from "./QuerydownEditor";

/** An auto-growing monospace Querydown editor — the toolbar's builder
 * sections, and the record picker's search / sort / display boxes — with an
 * optional trailing ⋮ menu (Clear / Save as preset), shown only while the
 * input is non-empty. The editor grows to its text's height (at least one
 * line). "Save as preset" is offered only to a caller that has somewhere to
 * save to (`onSaveAsPreset`), and is disabled until a base table is chosen
 * (`canSave`). The ref forwards to the element that takes the caret, so a
 * caller (a `query.focus_*` command's builder) can focus it — see
 * `useBuilderFocus`. `diagnostic` is the problem the error strip shows, when
 * it's in this input's text: it's bordered in red and the spot underlined.
 * `context` is what the text is to the compiler (see `QuerydownEditor`). */
const CustomInput = forwardRef<
  HTMLElement,
  {
    value: string;
    context: QuerydownContext;
    hint: string;
    onInput: (text: string) => void;
    onClear: () => void;
    /** Absent for an input that belongs to no query — the record picker's,
     * which live and die with one modal — which drops the entry from the ⋮
     * menu. */
    onSaveAsPreset?: () => void;
    canSave?: boolean;
    diagnostic?: QueryDiagnostic | null;
    /** Keeps the input to one line, as an `<input>` would: it can't hold a
     * newline at all — what the record picker's search box needs. */
    singleLine?: boolean;
    onKeyDown?: (e: KeyboardEvent) => void;
  }
>(function CustomInput(props, ref) {
  const hasText = props.value.trim() !== "";
  const menuTip = useTooltip({ label: "Input options" });

  return (
    <div className="relative w-full">
      <QuerydownEditor
        ref={ref}
        value={props.value}
        onChange={props.onInput}
        context={props.context}
        placeholder={props.hint}
        singleLine={props.singleLine}
        trailingSpace={hasText}
        diagnostic={props.diagnostic}
        onKeyDown={props.onKeyDown}
      />
      {hasText && (
        <div className="absolute top-0.5 right-0.5">
          <Menu
            align="end"
            width="190px"
            trigger={(api) => (
              <button
                type="button"
                {...menuTip.triggerProps}
                className={cx(
                  "text-ink-weak hover:text-ink flex size-[22px] items-center justify-center rounded",
                  NESTED_FOCUS_CLASS,
                )}
                onClick={() => api.toggle()}
              >
                <Icons.More className="size-4" />
              </button>
            )}
          >
            <MenuItem
              icon={Icons.Clear}
              label="Clear"
              onClick={() => props.onClear()}
            />
            {props.onSaveAsPreset && (
              <MenuItem
                icon={Icons.Save}
                label="Save as preset"
                disabled={!props.canSave}
                onClick={() => props.onSaveAsPreset?.()}
              />
            )}
          </Menu>
          {menuTip.tooltip}
        </div>
      )}
    </div>
  );
});

export default CustomInput;
