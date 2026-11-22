import type { JSX } from "react";
import { cx } from "./cx";

/** The accent dot that marks a control whose data was changed on another
 * device since it was read: the Refresh that would bring it up to date (live
 * updates, `specs/2026-11-live-updates`). `corner` pins it to the top right
 * of a `relative` box, such as an icon button; otherwise it sits inline. */
export function ChangedDot(props: { corner?: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cx("bg-accent pointer-events-none size-1.5 rounded-full", {
        "absolute top-0.5 right-0.5": props.corner,
        "ml-1.5 inline-block shrink-0 align-middle": !props.corner,
      })}
    />
  );
}

/** What a control marked with {@link ChangedDot} says about it. */
export const CHANGED_ELSEWHERE = "Changed on another device";
