import { forwardRef, type MouseEvent } from "react";
import type { CommandId } from "../../commands/registry";
import type { IconComponent } from "../../icons";
import { useTooltip } from "./Tooltip";
import { NESTED_BUTTON_CLASS, cx } from "./cx";

/** A frameless icon button — 26px square by default, or a 20px `size="sm"` for
 * controls set inline within a tighter row (the record editor's field-row
 * buttons). The hover affordance is a 1px accent ring painted *inside* the
 * square (`ring-inset`) so hovering never shifts layout. This is the app's one
 * button style — every icon-only control uses it, so hovering reads the same
 * everywhere. Content is the icon gray by default; `danger` tints it red and a
 * disabled button dims and stops responding. `nested` is for a button set
 * inside a standard-height control (a preset's actions), which takes color in
 * place of the ring (see `NESTED_BUTTON_CLASS`).
 *
 * `tabIndex={-1}` marks a control *on* another focusable item (like the
 * expansion toggle beside it) rather than an item of its own: it takes clicks
 * but not the keyboard, and doesn't steal focus from what's already focused
 * when clicked.
 *
 * Having no text of its own, it wears a tooltip: `label` is said once, and is
 * both what the tooltip shows and the button's `aria-label`. `command` names
 * the command a keyboard shortcut runs to the same effect, so its chord shows
 * in the tooltip too (and goes out as `aria-keyshortcuts`). See `useTooltip`.
 *
 * The ref forwards to the `<button>` so callers (e.g. a menu trigger) can
 * anchor to it. */
const IconButton = forwardRef<
  HTMLButtonElement,
  {
    icon: IconComponent;
    /** The button's name: its tooltip and its `aria-label`. */
    label: string;
    /** The command whose keyboard shortcut does what this button does. */
    command?: CommandId;
    /** Longer text the tooltip shows in place of `label`, for a help button
     * (see `TooltipSpec.description`). */
    description?: string;
    /** Which of the button's edges the tooltip lines up with (centered by
     * default). */
    tooltipAlign?: "start" | "center" | "end";
    /** Extra classes for the *glyph* rather than the button — the button's own
     * look is this component's to decide, but what the icon is doing inside it
     * isn't (the toolbar's Refresh spins while its query runs). */
    iconClassName?: string;
    onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
    danger?: boolean;
    active?: boolean;
    nested?: boolean;
    size?: "sm" | "md";
    tabIndex?: number;
  }
>(function IconButton(props, ref) {
  const Icon = props.icon;
  const { triggerProps, tooltip } = useTooltip({
    label: props.label,
    command: props.command,
    description: props.description,
    align: props.tooltipAlign,
  });
  return (
    <>
      <button
        ref={ref}
        type="button"
        {...triggerProps}
        disabled={props.disabled}
        tabIndex={props.tabIndex}
        className={cx(
          "flex shrink-0 items-center justify-center rounded",
          props.nested
            ? NESTED_BUTTON_CLASS
            : "ring-1 ring-transparent ring-inset",
          {
            "size-5": props.size === "sm",
            "size-[26px]": props.size !== "sm",
            "text-ink-weak": !props.disabled && !props.danger,
            "text-danger": !props.disabled && props.danger,
            "hover:ring-accent": !props.disabled && !props.nested,
            "text-ink-weak/40": props.disabled,
            "bg-hover": props.active && !props.nested,
            "bg-ink/10": props.active && props.nested,
          },
        )}
        onMouseDown={(e) => props.tabIndex === -1 && e.preventDefault()}
        onClick={(e) => props.onClick?.(e)}
      >
        <Icon className={cx("size-4", props.iconClassName)} />
      </button>
      {tooltip}
    </>
  );
});

export default IconButton;
