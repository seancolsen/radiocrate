import { forwardRef } from "react";
import { cx } from "./cx";

/** A labelled checkbox matching the builder's "Apply by default" control. The
 * box is a bordered square that fills accent-blue with a check when checked,
 * and rings when the (visually hidden) input has keyboard focus.
 *
 * The ref forwards to the `<input>`, so a caller can focus it. */
export const Checkbox = forwardRef<
  HTMLInputElement,
  {
    checked: boolean;
    label: string;
    onChange: (checked: boolean) => void;
  }
>(function Checkbox(props, ref) {
  return (
    <label className="group text-ink flex cursor-pointer items-center gap-2 text-sm select-none">
      <span
        className={cx(
          "border-ink-weak group-has-focus-visible:ring-accent flex size-4 shrink-0 items-center justify-center rounded-sm border group-has-focus-visible:ring-2",
          { "bg-accent border-accent": props.checked },
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
      <span>{props.label}</span>
      <input
        ref={ref}
        type="checkbox"
        className="sr-only"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </label>
  );
});
