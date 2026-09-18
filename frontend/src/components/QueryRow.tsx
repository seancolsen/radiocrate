import type { JSX, PointerEvent } from "react";
import { TREE_INDENT, TREE_PAD } from "../gestures/useTreeDrag";
import { Icons } from "../icons";
import { cx } from "./ui/cx";

/** A row in the "Queries" tree: a saved query, `depth` folders deep. Clicking
 * opens it; pressing on it can also pick it up to drag (see `QueryTree`).
 * Unlike the Opened rows, saved-query rows never show the unsaved (✱) marker —
 * that state belongs to open tabs, not the saved catalog.
 *
 * The icon sits one chevron's width in from the row's edge, so a query lines up
 * with the folder icons beside it rather than with their chevrons. */
export default function QueryRow(props: {
  name: string;
  depth: number;
  /** Whether it's the row being dragged (which stays put, dimmed). */
  dragging: boolean;
  onOpen: () => void;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-tree-row
      role="treeitem"
      aria-level={props.depth + 1}
      className={cx(
        "hover:bg-hover flex w-full items-center py-1 pr-2 text-left select-none [-webkit-touch-callout:none]",
        { "opacity-50": props.dragging },
      )}
      style={{ paddingLeft: TREE_PAD + props.depth * TREE_INDENT }}
      onPointerDown={props.onPointerDown}
      onClick={() => props.onOpen()}
    >
      <span className="size-4 shrink-0" aria-hidden="true" />
      <Icons.Query className="text-ink-weak size-[14px] shrink-0" />
      <span className="text-ink ml-1 truncate text-sm">{props.name}</span>
    </button>
  );
}
