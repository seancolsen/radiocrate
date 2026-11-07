import { useLayoutEffect, useRef, type JSX, type PointerEvent } from "react";
import { Icons, type IconComponent } from "../icons";
import { cx } from "./ui/cx";
import { useTooltip } from "./ui/Tooltip";

/** The inline rename `<input>`, mounted only while `renaming` is true — so it
 * gets a fresh instance (and thus a fresh mount) each time renaming starts,
 * which is what lets it focus and select itself on the way in. Split out so
 * that mount effect runs exactly once per rename, not once per keystroke. */
function RenameInput(props: {
  value: string;
  onInput: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      className="control border-edge bg-panel text-ink focus:border-accent min-w-0 flex-1 rounded outline-none"
      value={props.value}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => props.onInput(e.currentTarget.value)}
      onBlur={() => props.onCommit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          props.onCommit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          props.onCancel();
        }
      }}
    />
  );
}

/** One tab handle: the page kind's icon, the name (ellipsis when crowded; an
 * unsaved query that hasn't been named reads "new" in gray), an
 * unsaved-changes ✱ marker, and a close × (a middle-click on the handle closes
 * it too). Only the top corners are rounded so it
 * sits flush with the content below.
 *  - Active: filled with the content-panel color + a 4px accent-blue top edge,
 *    name at full-strength text.
 *  - Inactive: bar-colored (darker on hover), icon + name dimmed.
 *
 * `renameable` is what a non-query page turns off: a settings tab's handle text
 * is fixed, so double-clicking it does nothing (the query-only affordances
 * stand down for a non-query `TabKind`). On a query tab, saved or not, a
 * double-click starts an inline rename, replacing the name with a text field. */
export default function TabHandle(props: {
  id: string;
  name: string;
  icon: IconComponent;
  active: boolean;
  unsaved: boolean;
  renameable: boolean;
  /** Whether it's the handle being dragged (which stays put, dimmed). */
  dragging: boolean;
  renaming: boolean;
  renameBuffer: string;
  onSelect: () => void;
  onClose: () => void;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onRenameStart: () => void;
  onRenameInput: (text: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}): JSX.Element {
  const Icon = props.icon;
  const closeTip = useTooltip({
    label: `Close ${props.name || "new query"}`,
    command: props.active ? "tabs.close_active" : undefined,
  });
  return (
    <div
      data-tab-id={props.id}
      className={cx(
        "border-edge relative flex h-full max-w-[220px] min-w-0 shrink items-center gap-[5px] rounded-t border-r pr-1.5 pl-2 select-none",
        {
          "bg-panel text-ink": props.active,
          "bg-bar text-ink-weak hover:bg-hover": !props.active,
          "opacity-50": props.dragging,
        },
      )}
      onPointerDown={(e) => props.onPointerDown(e)}
      // A middle-click would otherwise start the browser's autoscroll.
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        props.onClose();
      }}
      onClick={() => props.onSelect()}
      onDoubleClick={() => props.renameable && props.onRenameStart()}
    >
      {/* 4px accent top edge on the active handle. */}
      <div
        className={cx("bg-accent absolute top-0 right-0 left-0 h-1 rounded-t", {
          hidden: !props.active,
        })}
      />
      {/* Active handle: icon stays the default gray while the name goes full-strength. */}
      <Icon
        className={
          props.active ? "text-ink-weak size-4 shrink-0" : "size-4 shrink-0"
        }
      />
      {props.renaming ? (
        <RenameInput
          value={props.renameBuffer}
          onInput={props.onRenameInput}
          onCommit={props.onRenameCommit}
          onCancel={props.onRenameCancel}
        />
      ) : (
        <>
          <span
            className={cx("min-w-0 flex-1 truncate text-sm", {
              "text-ink-weak": props.name === "",
            })}
          >
            {props.name || "new"}
          </span>
          {props.unsaved && (
            <Icons.Unsaved
              className="text-danger size-3 shrink-0"
              aria-label="Unsaved changes"
            />
          )}
        </>
      )}
      <button
        type="button"
        {...closeTip.triggerProps}
        className="text-ink-weak hover:text-ink flex size-[18px] shrink-0 items-center justify-center rounded"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          closeTip.triggerProps.onPointerDown?.();
        }}
      >
        <Icons.Close className="size-[15px]" />
      </button>
      {closeTip.tooltip}
    </div>
  );
}
