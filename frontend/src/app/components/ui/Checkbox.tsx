import type { JSX } from "react";
import { cx } from "./cx";

/** A labelled checkbox matching the builder's "Apply by default" control. The
 * box is a bordered square that fills accent-blue with a check when checked. */
export function Checkbox(props: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="text-ink flex cursor-pointer items-center gap-2 text-sm select-none">
      <span
        className={cx(
          "border-ink-weak flex size-4 shrink-0 items-center justify-center rounded-sm border",
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
        type="checkbox"
        className="sr-only"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}
