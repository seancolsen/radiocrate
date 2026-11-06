import type { JSX } from "react";
import { cx } from "./cx";

/** The box of a checkbox: a bordered square that fills accent-blue with a check
 * when checked. Shared by {@link Checkbox} and a menu's checkbox rows.
 * `className` extends the box. */
export function CheckboxBox(props: {
  checked: boolean;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cx(
        "border-ink-weak flex size-4 shrink-0 items-center justify-center rounded-sm border",
        { "bg-accent border-accent": props.checked },
        props.className,
      )}
    >
      {props.checked && (
        <svg
          viewBox="0 0 16 16"
          className="text-panel size-3"
          aria-hidden="true"
        >
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3.5 8.5l3 3 6-6.5"
          />
        </svg>
      )}
    </span>
  );
}

/** A labelled checkbox matching the builder's "Apply by default" control. The
 * box rings when the (visually hidden) input has keyboard focus. */
export function Checkbox(props: {
  checked: boolean;
  label: string;
  /** A smaller label, for a checkbox set among other small controls. */
  small?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label
      className={cx(
        "group text-ink flex cursor-pointer items-center gap-2 select-none",
        props.small ? "text-xs" : "text-sm",
      )}
    >
      <CheckboxBox
        checked={props.checked}
        className="group-has-focus-visible:ring-accent group-has-focus-visible:ring-2"
      />
      <span>{props.label}</span>
      <input
        type="checkbox"
        className="sr-only"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}
