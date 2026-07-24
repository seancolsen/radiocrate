import { Show, type JSX } from "solid-js";

/** A labelled checkbox matching the builder's "Apply by default" control. The
 * box is a bordered square that fills accent-blue with a check when checked. */
export function Checkbox(props: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label class="text-ink flex cursor-pointer items-center gap-2 text-sm select-none">
      <span
        class="border-ink-weak flex size-4 shrink-0 items-center justify-center rounded-sm border"
        classList={{ "bg-accent border-accent": props.checked }}
      >
        <Show when={props.checked}>
          <svg viewBox="0 0 16 16" class="text-panel size-3" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M3.5 8.5l3 3 6-6.5"
            />
          </svg>
        </Show>
      </span>
      <span>{props.label}</span>
      <input
        type="checkbox"
        class="sr-only"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}
