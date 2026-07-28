import { Show, type JSX } from "solid-js";
import { Icons } from "../../icons";
import { Menu, MenuItem } from "../ui/Menu";

/** The look of a Querydown editor, shared by every place one appears: the
 * toolbar's builder sections and the record picker's search / sort / display
 * boxes. */
const FIELD_CLASS =
  "bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent block w-full rounded-md border px-2.5 py-1.5 font-mono text-sm leading-5 outline-none";

/** An auto-growing monospace Querydown editor with an optional trailing ⋮ menu
 * (Clear / Save as preset), shown only while the input is non-empty. The
 * textarea grows to its line count (at least one line). "Save as preset" is
 * offered only to a caller that has somewhere to save to (`onSaveAsPreset`), and
 * is disabled until a base table is chosen (`canSave`). */
export default function CustomInput(props: {
  value: string;
  hint: string;
  onInput: (text: string) => void;
  onClear: () => void;
  /** Absent for an input that belongs to no query — the record picker's, which
   * live and die with one modal — which drops the entry from the ⋮ menu. */
  onSaveAsPreset?: () => void;
  canSave?: boolean;
  /** Renders an `<input>` instead of a `<textarea>`, so the field cannot hold a
   * newline at all — what the record picker's search box needs. */
  singleLine?: boolean;
  onKeyDown?: (e: KeyboardEvent) => void;
  /** Hands the field to the caller, which focuses it when a `query.focus_*`
   * command asks for the caret (or, in the picker, when the modal opens). */
  ref?: (el: HTMLTextAreaElement | HTMLInputElement) => void;
}): JSX.Element {
  const hasText = () => props.value.trim() !== "";
  const rows = () => Math.max(1, props.value.split("\n").length);

  return (
    <div class="relative w-full">
      <Show
        when={props.singleLine}
        fallback={
          <textarea
            ref={(el) => props.ref?.(el)}
            class={`${FIELD_CLASS} resize-none`}
            classList={{ "pr-9": hasText() }}
            rows={rows()}
            spellcheck={false}
            placeholder={props.hint}
            value={props.value}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            onKeyDown={(e) => props.onKeyDown?.(e)}
          />
        }
      >
        <input
          ref={(el) => props.ref?.(el)}
          type="text"
          class={FIELD_CLASS}
          classList={{ "pr-9": hasText() }}
          spellcheck={false}
          placeholder={props.hint}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => props.onKeyDown?.(e)}
        />
      </Show>
      <Show when={hasText()}>
        <div class="absolute top-1 right-1">
          <Menu
            align="end"
            width="190px"
            trigger={(api) => (
              <button
                type="button"
                aria-label="Custom input options"
                class="text-ink-weak hover:text-ink flex size-6 items-center justify-center rounded"
                onClick={() => api.toggle()}
              >
                <Icons.More class="size-4" />
              </button>
            )}
          >
            <MenuItem
              icon={Icons.Clear}
              label="Clear"
              onClick={() => props.onClear()}
            />
            <Show when={props.onSaveAsPreset}>
              {(save) => (
                <MenuItem
                  icon={Icons.Save}
                  label="Save as preset"
                  disabled={!props.canSave}
                  onClick={() => save()()}
                />
              )}
            </Show>
          </Menu>
        </div>
      </Show>
    </div>
  );
}
