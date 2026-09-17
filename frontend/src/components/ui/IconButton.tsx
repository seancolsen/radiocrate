import { forwardRef, type MouseEvent } from "react";
import type { IconComponent } from "../../icons";
import { cx } from "./cx";

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
 * The ref forwards to the `<button>` so callers (e.g. a menu trigger) can
 * anchor to it. */
const IconButton = forwardRef<
  HTMLButtonElement,
  {
    icon: IconComponent;
    label: string;
    /** Extra classes for the *glyph* rather than the button — the button's own
     * look is this component's to decide, but what the icon is doing inside it
     * isn't (the toolbar's Refresh spins while its query runs). */
    iconClassName?: string;
    onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    danger?: boolean;
    active?: boolean;
    size?: "sm" | "md";
    tabIndex?: number;
  }
>(function IconButton(props, ref) {
  const Icon = props.icon;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      tabIndex={props.tabIndex}
      className={cx(
        "flex shrink-0 items-center justify-center rounded ring-1 ring-transparent ring-inset",
        {
          "size-5": props.size === "sm",
          "size-[26px]": props.size !== "sm",
          "text-ink-weak hover:ring-accent": !props.disabled && !props.danger,
          "text-danger hover:ring-accent": !props.disabled && props.danger,
          "text-ink-weak/40": props.disabled,
          "bg-hover": props.active,
        },
      )}
      onMouseDown={(e) => props.tabIndex === -1 && e.preventDefault()}
      onClick={(e) => props.onClick?.(e)}
    >
      <Icon className={cx("size-4", props.iconClassName)} />
    </button>
  );
});

export default IconButton;
