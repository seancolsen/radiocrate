import type { JSX } from "react";
import { Icons } from "../../icons";
import { cx } from "../ui/cx";

/** A collapsed preset "tab". For a user preset it's a single clickable row
 * (chevron + preset icon + name) padded
 * to a one-line input's height; it gains a faint outline on hover and the pink
 * background when `expanded` (its bottom corners squared so it reads as joined to
 * the detail editor below). The built-in variant shows the preset name beside a
 * Reshuffle button and never expands. */
export default function PresetTab(props: {
  name: string;
  expanded?: boolean;
  builtin?: boolean;
  onClick?: () => void;
  onReshuffle?: () => void;
}): JSX.Element {
  if (props.builtin) {
    return (
      <div className="flex items-center gap-2 rounded px-[7px] py-1 text-sm">
        <Icons.Preset className="text-ink-weak size-4" />
        <span className="text-ink">{props.name}</span>
        <button
          type="button"
          className="border-edge text-ink hover:bg-hover ml-1 flex items-center gap-1.5 rounded border px-2 py-0.5 text-sm"
          onClick={() => props.onReshuffle?.()}
        >
          <Icons.Shuffle className="text-ink-weak size-4" />
          Reshuffle
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      className={cx("flex items-center gap-1.5 rounded px-[7px] py-1 text-sm", {
        "bg-preset rounded-b-none": props.expanded,
        "hover:ring-preset ring-1 ring-transparent ring-inset": !props.expanded,
      })}
      onClick={() => props.onClick?.()}
    >
      <span className="text-ink-weak flex size-4 items-center justify-center">
        {props.expanded ? <Icons.ExpandOpen /> : <Icons.ExpandClosed />}
      </span>
      <Icons.Preset className="text-ink-weak size-4" />
      <span className="text-ink whitespace-nowrap">{props.name}</span>
    </button>
  );
}
