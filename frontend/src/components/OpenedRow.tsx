import type { JSX, MouseEvent } from "react";
import { Icons, type IconComponent } from "../icons";
import TreeNameField from "./TreeNameField";
import { cx } from "./ui/cx";
import { useTooltip } from "./ui/Tooltip";

/** A row in the "Opened" section: an open tab of any kind, its icon taken from
 * that kind. Clicking the body selects it; a close (×) sits at the right. The
 * active row is marked with a left accent bar (matching the tab bar's blue top
 * edge), not a fill. A red ✱ marks an open tab with unsaved edits. An unsaved
 * query, which has no name yet, reads "new" in gray, as its tab
 * handle does.
 *
 * A right-click (or, on a touch screen, a press held on it) raises the row's
 * context menu through `onContextMenu`. While `renaming`, the name is a text
 * field — Enter or leaving it keeps the edit, Escape abandons it — and the
 * field's own menu is left to the browser. */
export default function OpenedRow(props: {
  name: string;
  icon: IconComponent;
  active: boolean;
  unsaved: boolean;
  renaming: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
}): JSX.Element {
  const Icon = props.icon;
  const closeTip = useTooltip({
    label: `Close ${props.name || "new query"}`,
    command: props.active ? "tabs.close_active" : undefined,
  });
  return (
    <div
      className={cx(
        "hover:bg-hover relative flex h-[30px] items-center pr-1 pl-2.5 select-none [-webkit-touch-callout:none]",
        { "bg-transparent": !props.active },
      )}
      onContextMenu={(e) => {
        if (!props.renaming) props.onContextMenu(e);
      }}
    >
      {/* Blue left edge marks the active item. Overlaid, so content never shifts. */}
      <div
        className={cx("bg-accent absolute top-0 left-0 h-full w-1", {
          hidden: !props.active,
        })}
      />
      {props.renaming ? (
        // Not in the select button: a field can't sit inside a button, and a
        // click in it is editing, not choosing the tab.
        <div className="flex min-w-0 flex-1 items-center">
          <Icon className="text-ink-weak size-[14px] shrink-0" />
          <TreeNameField
            label={`Name of ${props.name || "new query"}`}
            name={props.name}
            onCommit={props.onCommitRename}
            onCancel={props.onCancelRename}
          />
        </div>
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center text-left"
          onClick={() => props.onSelect()}
        >
          <Icon className="text-ink-weak size-[14px] shrink-0" />
          <span
            className={cx("ml-2 min-w-0 truncate text-sm", {
              "text-ink": props.name !== "",
              "text-ink-weak": props.name === "",
            })}
          >
            {props.name || "new"}
          </span>
          {props.unsaved && (
            <Icons.Unsaved
              className="text-danger ml-1 size-3 shrink-0"
              aria-label="Unsaved changes"
            />
          )}
        </button>
      )}
      <button
        type="button"
        {...closeTip.triggerProps}
        className="text-ink-weak hover:text-ink ml-1 flex size-[22px] shrink-0 items-center justify-center rounded"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        <Icons.Close className="size-[15px]" />
      </button>
      {closeTip.tooltip}
    </div>
  );
}
