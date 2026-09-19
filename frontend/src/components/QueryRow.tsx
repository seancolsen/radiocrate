import type { JSX, MouseEvent, PointerEvent } from "react";
import { TREE_INDENT, TREE_PAD } from "../gestures/useTreeDrag";
import { Icons } from "../icons";
import TreeNameField from "./TreeNameField";
import { cx } from "./ui/cx";

/** A row in the "Queries" tree: a saved query, `depth` folders deep. Clicking
 * (or Enter) opens it, F2 renames it in place, and pressing on it can also
 * pick it up to drag (see `QueryTree`). Unlike the Opened rows, saved-query
 * rows never show the unsaved (✱) marker — that state belongs to open tabs,
 * not the saved catalog.
 *
 * The icon sits one chevron's width in from the row's edge, so a query lines up
 * with the folder icons beside it rather than with their chevrons. */
export default function QueryRow(props: {
  name: string;
  depth: number;
  renaming: boolean;
  /** Whether it's the row being dragged (which stays put, dimmed). */
  dragging: boolean;
  onOpen: () => void;
  onBeginRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
}): JSX.Element {
  return (
    <div
      data-tree-row
      role="treeitem"
      aria-label={props.name}
      aria-level={props.depth + 1}
      tabIndex={0}
      className={cx(
        "hover:bg-hover focus-visible:ring-accent flex w-full cursor-default items-center py-1 pr-2 text-left outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-1 focus-visible:ring-inset",
        { "opacity-50": props.dragging },
      )}
      style={{ paddingLeft: TREE_PAD + props.depth * TREE_INDENT }}
      onPointerDown={props.onPointerDown}
      onClick={() => {
        if (!props.renaming) props.onOpen();
      }}
      onContextMenu={props.onContextMenu}
      onKeyDown={(e) => {
        if (props.renaming || e.target !== e.currentTarget) return;
        if (e.key === "Enter") props.onOpen();
        else if (e.key === "F2") props.onBeginRename();
        else return;
        e.preventDefault();
      }}
    >
      <span className="size-4 shrink-0" aria-hidden="true" />
      <Icons.Query className="text-ink-weak size-[14px] shrink-0" />
      {props.renaming ? (
        <TreeNameField
          label="Query name"
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
