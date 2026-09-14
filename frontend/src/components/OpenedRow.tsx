import type { JSX } from "react";
import { Icons, type IconComponent } from "../icons";
import { cx } from "./ui/cx";

/** A row in the "Opened" section: an open tab of any kind, its icon taken from
 * that kind. Clicking the body selects it; a close (×) sits at the right. The
 * active row is marked with a left accent bar (matching the tab bar's blue top
 * edge), not a fill. A red ✱ marks an open tab with unsaved edits. */
export default function OpenedRow(props: {
  name: string;
  icon: IconComponent;
  active: boolean;
  unsaved: boolean;
  onSelect: () => void;
  onClose: () => void;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <div
      className={cx(
        "hover:bg-hover relative flex h-[30px] items-center pr-1 pl-2.5",
        { "bg-transparent": !props.active },
      )}
    >
      {/* Blue left edge marks the active item. Overlaid, so content never shifts. */}
      <div
        className={cx("bg-accent absolute top-0 left-0 h-full w-1", {
          hidden: !props.active,
        })}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center text-left"
        onClick={() => props.onSelect()}
      >
        <Icon className="text-ink-weak size-[14px] shrink-0" />
        <span className="text-ink ml-2 min-w-0 truncate text-sm">
          {props.name}
        </span>
        {props.unsaved && (
          <Icons.Unsaved
            className="text-danger ml-1 size-3 shrink-0"
            aria-label="Unsaved changes"
          />
        )}
      </button>
      <button
        type="button"
        aria-label={`Close ${props.name}`}
        className="text-ink-weak hover:bg-hover hover:text-ink ml-1 flex size-[22px] shrink-0 items-center justify-center rounded"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        <Icons.Close className="size-[15px]" />
      </button>
    </div>
  );
}
