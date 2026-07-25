import { Show, type Component, type JSX } from "solid-js";
import { Icons } from "../../icons";
import { Menu } from "./Menu";

/** A labelled toggle button. Its main (icon + label) area toggles a builder
 * section via `onMainClick`. While `active` it takes the blue
 * fill and, unless `showMenu` is false, grows an embedded ⋮ trigger (set off by a
 * lighter tint) that opens the section's options `menu`. `showLabel` drops the
 * text label on a narrow toolbar, leaving the icon (and, while active, the ⋮). */
export default function SplitButton(props: {
  icon: Component<{ class?: string }>;
  label: string;
  active: boolean;
  showLabel?: boolean;
  showMenu?: boolean;
  onMainClick: () => void;
  menu?: JSX.Element;
}): JSX.Element {
  const showLabel = () => props.showLabel !== false;
  const withMenu = () =>
    props.active && props.showMenu !== false && props.menu != null;

  return (
    <div
      class="relative inline-flex h-[26px] shrink-0 items-stretch rounded"
      classList={{
        "bg-split-active": props.active,
        "ring-1 ring-inset ring-transparent hover:ring-accent": !props.active,
      }}
    >
      <button
        type="button"
        aria-pressed={props.active}
        class="flex items-center gap-[5px] rounded-l px-1.5"
        classList={{ "rounded-r": !withMenu() }}
        onClick={() => props.onMainClick()}
      >
        <span class="text-ink-weak flex size-4 items-center justify-center">
          {props.icon({ class: "size-4" })}
        </span>
        <Show when={showLabel()}>
          <span class="text-ink text-[13px] whitespace-nowrap">
            {props.label}
          </span>
        </Show>
      </button>
      <Show when={withMenu()}>
        <Menu
          align="end"
          trigger={(api) => (
            <button
              type="button"
              aria-label={`${props.label} options`}
              class="bg-split-trigger text-ink-weak hover:text-ink flex h-full w-[22px] items-center justify-center rounded-r"
              onClick={() => api.toggle()}
            >
              <Icons.More class="size-4" />
            </button>
          )}
        >
          {props.menu}
        </Menu>
      </Show>
    </div>
  );
}
