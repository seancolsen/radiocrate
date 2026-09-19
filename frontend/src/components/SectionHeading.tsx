import type { JSX, ReactNode } from "react";
import { cx } from "./ui/cx";

/** An explorer section's heading row: its title, and any `children` —
 * controls set at the right edge (the Queries section's actions menu). The
 * sections don't collapse, so the heading itself does nothing when clicked.
 * `spaced` sets it apart from a section heading above it. */
export default function SectionHeading(props: {
  title: string;
  spaced: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cx("flex h-7 items-center pr-0.5 pl-2", {
        "mt-2": props.spaced,
      })}
    >
      <h2 className="text-ink min-w-0 flex-1 truncate text-sm font-bold">
        {props.title}
      </h2>
      {props.children}
    </div>
  );
}
