import type { JSX, MouseEvent, PointerEvent } from "react";
import type { SourceKind } from "api-client";
import { TREE_INDENT, TREE_PAD } from "../gestures/useTreeDrag";
import { Icons } from "../icons";
import TreeNameField from "./TreeNameField";
import { cx } from "./ui/cx";

/** A row in the "Sources" tree: a saved source — a query or a playlist, each
 * with its own icon — `depth` folders deep. Clicking (or Enter) opens it, F2
 * renames it in place, and pressing on it can also pick it up to drag (see
 * `SourceTree`). Unlike the Opened rows, source rows never show the unsaved (✱)
 * marker — that state belongs to open tabs, not the saved catalog.
 *
 * The row carries its source's id and kind as data attributes, which is how
 * result rows dragged over the tree find the playlist they'd be dropped on
 * (see `QueryResults`); that playlist's row is then outlined (`dropTarget`).
 *
 * The icon sits one chevron's width in from the row's edge, so a source lines
 * up with the folder icons beside it rather than with their chevrons. */
export default function SourceRow(props: {
  /** The source's id. */
  id: string;
  kind: SourceKind;
  name: string;
  depth: number;
  renaming: boolean;
  /** Whether it's the row being dragged (which stays put, dimmed). */
  dragging: boolean;
  /** Whether result rows being dragged would be dropped on it. */
  dropTarget: boolean;
  onOpen: () => void;
  onBeginRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
}): JSX.Element {
  const Icon = props.kind === "playlist" ? Icons.Playlist : Icons.Query;
  return (
    <div
      data-tree-row
      data-source-id={props.id}
      data-source-kind={props.kind}
      role="treeitem"
      aria-label={props.name}
      aria-level={props.depth + 1}
      tabIndex={0}
      className={cx(
        "hover:bg-hover flex w-full cursor-default items-center py-1 pr-2 text-left outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-1 focus-visible:ring-inset",
        {
          "opacity-50": props.dragging,
          "ring-accent ring-2 ring-inset": props.dropTarget,
          "focus-visible:ring-accent": !props.dropTarget,
        },
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
      <Icon className="text-ink-weak size-[14px] shrink-0" />
      {props.renaming ? (
        <TreeNameField
          label={props.kind === "playlist" ? "Playlist name" : "Query name"}
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
