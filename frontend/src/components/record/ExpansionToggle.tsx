import { Show } from "solid-js";
import { Icons } from "../../icons";

/** The chevron that expands or collapses a form item.
 *
 * An item that can't be expanded gets no toggle — but it still gets the toggle's
 * *space*, so every field label in the form lines up on the same left edge
 * whatever its neighbors can do. */
export default function ExpansionToggle(props: {
  expandable: boolean;
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <Show
      when={props.expandable}
      fallback={<span class="size-4 shrink-0" aria-hidden="true" />}
    >
      <button
        type="button"
        aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.label}`}
        aria-expanded={props.expanded}
        class="text-ink-weak hover:text-ink flex size-4 shrink-0 items-center justify-center"
        onClick={() => props.onToggle()}
      >
        <Show when={props.expanded} fallback={<Icons.ExpandClosed />}>
          <Icons.ExpandOpen />
        </Show>
      </button>
    </Show>
  );
}
