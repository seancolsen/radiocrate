import { useId, type JSX } from "react";
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
 * box rings when the (visually hidden) input has keyboard focus.
 *
 * `description` is a quieter line under the label, for a choice that needs a
 * word on what it means; it describes the input for a screen reader too. A
 * `disabled` checkbox shows its state, dimmed, and can't be changed: a choice
 * that's already been made for the user. */
export function Checkbox(props: {
  checked: boolean;
  label: string;
  description?: string;
  disabled?: boolean;
  /** A smaller label, for a checkbox set among other small controls. */
  small?: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <label
      className={cx(
        "group text-ink flex gap-2 select-none",
        props.description === undefined ? "items-center" : "items-start",
        props.disabled ? "cursor-default" : "cursor-pointer",
        props.small ? "text-xs" : "text-sm",
      )}
    >
      <CheckboxBox
        checked={props.checked}
        className={cx(
          "group-has-focus-visible:ring-accent group-has-focus-visible:ring-2",
          // Level with the label's first line, when a description follows it.
          { "mt-0.5": props.description !== undefined },
          { "opacity-50": props.disabled },
        )}
      />
      {props.description === undefined ? (
        <span>{props.label}</span>
      ) : (
        <span className="min-w-0">
          <span id={labelId} className="block">
            {props.label}
          </span>
          <span id={descriptionId} className="text-ink-weak block text-xs">
            {props.description}
          </span>
        </span>
      )}
      <input
        type="checkbox"
        className="sr-only"
        checked={props.checked}
        disabled={props.disabled}
        // Named by the label alone: the description would otherwise be read
        // as part of the name, since both are inside the `<label>`.
        aria-labelledby={props.description === undefined ? undefined : labelId}
        aria-describedby={
          props.description === undefined ? undefined : descriptionId
        }
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}
