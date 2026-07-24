import type { Component, JSX } from "solid-js";

/** A frameless, fixed 26px-square icon button — the DOM analog of
 * `frontend-old-egui/src/button.rs:Button`. The hover affordance is a 1px accent
 * ring painted *inside* the square (`ring-inset`) so hovering never shifts
 * layout. Content is the icon gray by default; `danger` tints it red and a
 * disabled button dims and stops responding.
 *
 * `ref` is forwarded so callers (e.g. a menu trigger) can anchor to the button. */
export default function IconButton(props: {
  icon: Component<{ class?: string }>;
  label: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  ref?: (el: HTMLButtonElement) => void;
}): JSX.Element {
  return (
    <button
      ref={props.ref}
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      class="flex size-[26px] shrink-0 items-center justify-center rounded ring-1 ring-transparent ring-inset"
      classList={{
        "text-ink-weak hover:ring-accent": !props.disabled && !props.danger,
        "text-danger hover:ring-accent": !props.disabled && props.danger,
        "text-ink-weak/40": props.disabled,
        "bg-hover": props.active,
      }}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.icon({ class: "size-4" })}
    </button>
  );
}
