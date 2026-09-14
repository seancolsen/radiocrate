import type { JSX, ReactNode } from "react";
import { Icons, type IconComponent } from "../../icons";
import { Menu } from "./Menu";
import { cx } from "./cx";

/** A labelled toggle button. Its main (icon + label) area toggles a builder
 * section via `onMainClick`. While `active` it takes the blue
 * fill and, unless `showMenu` is false, grows an embedded ⋮ trigger (set off by a
 * lighter tint) that opens the section's options `menu`. `showLabel` drops the
 * text label on a narrow toolbar, leaving the icon (and, while active, the ⋮). */
export default function SplitButton(props: {
  icon: IconComponent;
  label: string;
  active: boolean;
  showLabel?: boolean;
  showMenu?: boolean;
  onMainClick: () => void;
  menu?: ReactNode;
}): JSX.Element {
  const Icon = props.icon;
  const showLabel = props.showLabel !== false;
  const withMenu =
    props.active && props.showMenu !== false && props.menu != null;

  return (
    <div
      className={cx(
        "relative inline-flex h-[26px] shrink-0 items-stretch rounded",
        {
          "bg-split-active": props.active,
          "hover:ring-accent ring-1 ring-transparent ring-inset": !props.active,
        },
      )}
    >
      <button
        type="button"
        aria-pressed={props.active}
        className={cx("flex items-center gap-[5px] rounded-l px-1.5", {
          "rounded-r": !withMenu,
        })}
        onClick={() => props.onMainClick()}
      >
        <span className="text-ink-weak flex size-4 items-center justify-center">
          <Icon className="size-4" />
        </span>
        {showLabel && (
          <span className="text-ink text-[13px] whitespace-nowrap">
            {props.label}
          </span>
        )}
      </button>
      {withMenu && (
        <Menu
          align="end"
          trigger={(api) => (
            <button
              type="button"
              aria-label={`${props.label} options`}
              className="bg-split-trigger text-ink-weak hover:text-ink flex h-full w-[22px] items-center justify-center rounded-r"
              onClick={() => api.toggle()}
            >
              <Icons.More className="size-4" />
            </button>
          )}
        >
          {props.menu}
        </Menu>
      )}
    </div>
  );
}
