import { forwardRef, type ForwardedRef, type KeyboardEvent } from "react";
import { Icons } from "../../icons";
import { Menu, MenuItem } from "../ui/Menu";
import { cx } from "../ui/cx";

/** The look of a Querydown editor, shared by every place one appears: the
 * toolbar's builder sections and the record picker's search / sort / display
 * boxes. */
const FIELD_CLASS =
  "bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent block w-full rounded-md border px-2.5 py-1.5 font-mono text-sm leading-5 outline-none";

/** Assigns a `forwardRef` ref, whichever shape it was given — needed because
 * this component forwards to one of two element types (a callback or object
 * ref typed for their union doesn't assign directly to either's own setter). */
function assignRef<T>(ref: ForwardedRef<T>, el: T | null): void {
  if (typeof ref === "function") ref(el);
  else if (ref) ref.current = el;
}

/** An auto-growing monospace Querydown editor with an optional trailing ⋮ menu
 * (Clear / Save as preset), shown only while the input is non-empty. The
 * textarea grows to its line count (at least one line). "Save as preset" is
 * offered only to a caller that has somewhere to save to (`onSaveAsPreset`), and
 * is disabled until a base table is chosen (`canSave`). The ref forwards to the
 * underlying `<textarea>`/`<input>`, so a caller (a `query.focus_*` command's
 * builder) can focus it — see `useBuilderFocus`. */
const CustomInput = forwardRef<
  HTMLTextAreaElement | HTMLInputElement,
  {
    value: string;
    hint: string;
    onInput: (text: string) => void;
    onClear: () => void;
    /** Absent for an input that belongs to no query — the record picker's,
     * which live and die with one modal — which drops the entry from the ⋮
     * menu. */
    onSaveAsPreset?: () => void;
    canSave?: boolean;
    /** Renders an `<input>` instead of a `<textarea>`, so the field cannot hold
     * a newline at all — what the record picker's search box needs. */
    singleLine?: boolean;
    onKeyDown?: (
      e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
    ) => void;
  }
>(function CustomInput(props, ref) {
  const hasText = props.value.trim() !== "";
  const rows = Math.max(1, props.value.split("\n").length);

  return (
    <div className="relative w-full">
      {props.singleLine ? (
        <input
          ref={(el) => assignRef(ref, el)}
          type="text"
          className={cx(FIELD_CLASS, { "pr-9": hasText })}
          spellCheck={false}
          placeholder={props.hint}
          value={props.value}
          onChange={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => props.onKeyDown?.(e)}
        />
      ) : (
        <textarea
          ref={(el) => assignRef(ref, el)}
          className={cx(FIELD_CLASS, "resize-none", { "pr-9": hasText })}
          rows={rows}
          spellCheck={false}
          placeholder={props.hint}
          value={props.value}
          onChange={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => props.onKeyDown?.(e)}
        />
      )}
      {hasText && (
        <div className="absolute top-1 right-1">
          <Menu
            align="end"
            width="190px"
            trigger={(api) => (
              <button
                type="button"
                aria-label="Custom input options"
                className="text-ink-weak hover:text-ink flex size-6 items-center justify-center rounded"
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
        </div>
      )}
    </div>
  );
});

export default CustomInput;
