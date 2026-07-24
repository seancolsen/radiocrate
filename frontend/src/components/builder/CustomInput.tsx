import { Show, type JSX } from "solid-js";
import { Icons } from "../../icons";
import { Menu, MenuItem } from "../ui/Menu";

/** An auto-growing monospace Querydown editor with an optional trailing ⋮ menu
 * (Clear / Save as preset), shown only while the input is non-empty — the DOM
 * analog of `builder.rs:filter_custom_input` / `code_editor`. The textarea grows
 * to its line count (at least one line). "Save as preset" is disabled until a
 * base table is chosen (`canSave`). */
export default function CustomInput(props: {
  value: string;
  hint: string;
  onInput: (text: string) => void;
  onClear: () => void;
  onSaveAsPreset: () => void;
  canSave: boolean;
}): JSX.Element {
  const hasText = () => props.value.trim() !== "";
  const rows = () => Math.max(1, props.value.split("\n").length);

  return (
    <div class="relative w-full">
      <textarea
        class="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent block w-full resize-none rounded-md border px-2.5 py-1.5 font-mono text-sm leading-5 outline-none"
        classList={{ "pr-9": hasText() }}
        rows={rows()}
        spellcheck={false}
        placeholder={props.hint}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
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
            <MenuItem
              icon={Icons.Save}
              label="Save as preset"
              disabled={!props.canSave}
              onClick={() => props.onSaveAsPreset()}
            />
          </Menu>
        </div>
      </Show>
    </div>
  );
}
