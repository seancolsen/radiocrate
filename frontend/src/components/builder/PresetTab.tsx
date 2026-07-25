import { Show, type JSX } from "solid-js";
import { Icons } from "../../icons";

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
  return (
    <Show
      when={!props.builtin}
      fallback={
        <div class="flex items-center gap-2 rounded px-[7px] py-1 text-sm">
          <Icons.Preset class="text-ink-weak size-4" />
          <span class="text-ink">{props.name}</span>
          <button
            type="button"
            class="border-edge text-ink hover:bg-hover ml-1 flex items-center gap-1.5 rounded border px-2 py-0.5 text-sm"
            onClick={() => props.onReshuffle?.()}
          >
            <Icons.Shuffle class="text-ink-weak size-4" />
            Reshuffle
          </button>
        </div>
      }
    >
      <button
        type="button"
        aria-expanded={props.expanded}
        class="flex items-center gap-1.5 rounded px-[7px] py-1 text-sm"
        classList={{
          "bg-preset rounded-b-none": props.expanded,
          "ring-1 ring-inset ring-transparent hover:ring-preset":
            !props.expanded,
        }}
        onClick={() => props.onClick?.()}
      >
        <span class="text-ink-weak flex size-4 items-center justify-center">
          <Show when={props.expanded} fallback={<Icons.ExpandClosed />}>
            <Icons.ExpandOpen />
          </Show>
        </span>
        <Icons.Preset class="text-ink-weak size-4" />
        <span class="text-ink whitespace-nowrap">{props.name}</span>
      </button>
    </Show>
  );
}
