import type { JSX, KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { TREE_INDENT, TREE_PAD } from "../gestures/useTreeDrag";
import { Icons } from "../icons";
import ExpansionToggle from "./record/ExpansionToggle";
import TreeNameField from "./TreeNameField";
import { cx } from "./ui/cx";

/** A folder row in the "Queries" tree: a chevron that shows or hides its
 * contents, a folder icon and its name. A single click does nothing — the
 * chevron is what opens it — and a double-click renames it in place. */
export default function FolderRow(props: {
  name: string;
  depth: number;
  expanded: boolean;
  renaming: boolean;
  /** Whether it's the row being dragged (which stays put, dimmed). */
  dragging: boolean;
  /** Whether the dragged item would drop into this folder. */
  dropTarget: boolean;
  onToggle: () => void;
  onBeginRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
}): JSX.Element {
  const Icon = props.expanded ? Icons.FolderOpen : Icons.Folder;
  return (
    <div
      data-tree-row
      role="treeitem"
      aria-label={props.name}
      aria-level={props.depth + 1}
      aria-expanded={props.expanded}
      tabIndex={0}
      className={cx(
        "hover:bg-hover flex w-full items-center rounded-sm py-1 pr-2 outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-1 focus-visible:ring-inset",
        {
          "opacity-50": props.dragging,
          "ring-accent ring-2 ring-inset": props.dropTarget,
          "focus-visible:ring-accent": !props.dropTarget,
        },
      )}
      style={{ paddingLeft: TREE_PAD + props.depth * TREE_INDENT }}
      onPointerDown={props.onPointerDown}
      onDoubleClick={() => {
        if (!props.renaming) props.onBeginRename();
      }}
      onContextMenu={props.onContextMenu}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (props.renaming || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") props.onToggle();
        else if (e.key === "F2") props.onBeginRename();
        else return;
        e.preventDefault();
      }}
    >
      {/* A quick pair of clicks on the chevron is two toggles, not a rename. */}
      <span className="contents" onDoubleClick={(e) => e.stopPropagation()}>
        <ExpansionToggle
          expandable
          expanded={props.expanded}
          label={props.name}
          onToggle={() => props.onToggle()}
        />
      </span>
      <Icon className="text-ink-weak size-[14px] shrink-0" />
      {props.renaming ? (
        <TreeNameField
          label="Folder name"
          name={props.name}
          onCommit={props.onCommitRename}
          onCancel={props.onCancelRename}
        />
      ) : (
        <span className="text-ink ml-1 truncate text-sm">{props.name}</span>
      )}
    </div>
  );
}
