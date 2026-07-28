import type { Component, JSX } from "solid-js";

/** A frameless icon button — 26px square by default, or a 20px `size="sm"` for
 * controls set inline within a tighter row (the record editor's field-row
 * buttons). The hover affordance is a 1px accent ring painted *inside* the
 * square (`ring-inset`) so hovering never shifts layout. This is the app's one
 * button style — every icon-only control uses it, so hovering reads the same
 * everywhere. Content is the icon gray by default; `danger` tints it red and a
 * disabled button dims and stops responding.
 *
 * `tabIndex={-1}` marks a control *on* another focusable item (like the
 * expansion toggle beside it) rather than an item of its own: it takes clicks
 * but not the keyboard, and doesn't steal focus from what's already focused
 * when clicked.
 *
 * `ref` is forwarded so callers (e.g. a menu trigger) can anchor to the button. */
export default function IconButton(props: {
  icon: Component<{ class?: string }>;
  label: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
  size?: "sm" | "md";
  tabIndex?: number;
  ref?: (el: HTMLButtonElement) => void;
}): JSX.Element {
  return (
    <button
      ref={props.ref}
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      tabindex={props.tabIndex}
      class="flex shrink-0 items-center justify-center rounded ring-1 ring-transparent ring-inset"
      classList={{
        "size-5": props.size === "sm",
        "size-[26px]": props.size !== "sm",
        "text-ink-weak hover:ring-accent": !props.disabled && !props.danger,
        "text-danger hover:ring-accent": !props.disabled && props.danger,
        "text-ink-weak/40": props.disabled,
        "bg-hover": props.active,
      }}
      onMouseDown={(e) => props.tabIndex === -1 && e.preventDefault()}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.icon({ class: "size-4" })}
    </button>
  );
}
