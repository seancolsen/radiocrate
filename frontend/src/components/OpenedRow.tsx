import { Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Icons } from "../icons";

/** A row in the "Opened" section: an open tab of any kind, its icon taken from
 * that kind. Clicking the body selects it; a close (×) sits at the right. The
 * active row is marked with a left accent bar (matching the tab bar's blue top
 * edge), not a fill. A red ✱ marks an open tab with unsaved edits. */
export default function OpenedRow(props: {
  name: string;
  icon: Component<{ class?: string }>;
  active: boolean;
  unsaved: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      class="hover:bg-hover relative flex h-[30px] items-center pr-1 pl-2.5"
      classList={{ "bg-transparent": !props.active }}
    >
      {/* Blue left edge marks the active item. Overlaid, so content never shifts. */}
      <div
        class="bg-accent absolute top-0 left-0 h-full w-1"
        classList={{ hidden: !props.active }}
      />
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center text-left"
        onClick={() => props.onSelect()}
      >
        <Dynamic
          component={props.icon}
          class="text-ink-weak size-[14px] shrink-0"
        />
        <span class="text-ink ml-2 min-w-0 truncate text-sm">{props.name}</span>
        <Show when={props.unsaved}>
          <Icons.Unsaved
            class="text-danger ml-1 size-3 shrink-0"
            aria-label="Unsaved changes"
          />
        </Show>
      </button>
      <button
        type="button"
        aria-label={`Close ${props.name}`}
        class="text-ink-weak hover:bg-hover hover:text-ink ml-1 flex size-[22px] shrink-0 items-center justify-center rounded"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        <Icons.Close class="size-[15px]" />
      </button>
    </div>
  );
}
