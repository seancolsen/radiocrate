import { Show } from "solid-js";
import { Icons } from "../icons";

/** A collapsible section heading (chevron + title) spanning the sidebar width,
 * toggling the section when clicked. The "Queries" header additionally shows a
 * refresh button at the right edge (its own click doesn't toggle the section). */
export default function CollapseHeader(props: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  onRefresh?: () => void;
}) {
  return (
    <div class="relative">
      <button
        type="button"
        class="hover:bg-hover flex h-7 w-full items-center gap-1.5 pr-8 pl-2.5 text-left"
        onClick={() => props.onToggle()}
      >
        <span class="text-ink-weak flex size-[18px] items-center justify-center">
          <Show when={props.collapsed} fallback={<Icons.ExpandOpen />}>
            <Icons.ExpandClosed />
          </Show>
        </span>
        <span class="text-ink text-base">{props.title}</span>
      </button>
      <Show when={props.onRefresh}>
        <button
          type="button"
          aria-label="Refresh queries"
          class="text-ink-weak hover:text-ink absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center"
          onClick={() => props.onRefresh?.()}
        >
          <Icons.Refresh class="size-[18px]" />
        </button>
      </Show>
    </div>
  );
}
