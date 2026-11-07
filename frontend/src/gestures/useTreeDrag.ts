import type { RefObject } from "react";
import {
  dropBetween,
  dropInto,
  subtreeIds,
  type DropTarget,
  type TreeItemRef,
  type TreeNode,
  type TreeRow,
} from "../query/explorerTree";
import { usePressDrag, type DragLocation } from "./usePressDrag";

/** A tree row's left padding at depth 0, and the extra indent per level (px).
 * The rows lay themselves out with these, and the drop line is indented by
 * them, so the two always agree. */
export const TREE_PAD = 8;
export const TREE_INDENT = 16;

/** Drag-to-rearrange for the explorer's query tree: {@link usePressDrag}, over
 * rows that nest.
 *
 * The drop indicator is a line between two rows, indented to the nesting depth
 * the drop would land at, or an outline around a folder the item would drop into.
 * Which depth a between-rows line stands for follows the pointer's horizontal
 * position — the further right, the deeper, within what the rows on either side
 * allow.
 *
 * `listRef` is the element holding the rows (each marked `data-tree-row`, in
 * `rows` order); `scrollRef` is the element that scrolls them. */
export function useTreeDrag(opts: {
  listRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  tree: readonly TreeNode[];
  rows: readonly TreeRow[];
  /** Makes the drop; returns whether anything actually moved. */
  onDrop: (item: TreeItemRef, target: DropTarget) => boolean;
  /** A touch held on the row and let go without moving it — the touch
   * equivalent of a right-click, at viewport point (x, y). */
  onHold: (item: TreeItemRef, x: number, y: number) => void;
}) {
  const { listRef, scrollRef, tree, rows, onDrop, onHold } = opts;

  /** Where the pointer at (x, y) would drop the dragged item, and where to
   * draw the line for it. */
  const locate = (
    item: TreeItemRef,
    x: number,
    y: number,
  ): DragLocation<DropTarget> => {
    const list = listRef.current;
    const none = { target: null, lineTop: 0 };
    if (!list) return none;
    const box = list.getBoundingClientRect();
    const els = Array.from(
      list.querySelectorAll<HTMLElement>("[data-tree-row]"),
    );
    if (els.length !== rows.length) return none;
    const blocked = subtreeIds(tree, item);

    let gap = rows.length;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (y >= r.bottom) continue;
      const frac = (y - r.top) / r.height;
      if (rows[i].node.kind === "folder") {
        if (frac >= 0.25 && frac <= 0.75) {
          return { target: dropInto(rows[i].node.id, blocked), lineTop: 0 };
        }
        gap = frac < 0.25 ? i : i + 1;
      } else {
        gap = frac < 0.5 ? i : i + 1;
      }
      break;
    }

    const depth = Math.floor((x - box.left - TREE_PAD) / TREE_INDENT);
    const target = dropBetween(rows, gap, depth, blocked);
    const edge =
      gap < els.length
        ? els[gap].getBoundingClientRect().top
        : (els[els.length - 1]?.getBoundingClientRect().bottom ?? box.top);
    return { target, lineTop: edge - box.top };
  };

  return usePressDrag<TreeItemRef, DropTarget>({
    listRef,
    scroller: () => scrollRef.current,
    locate,
    onDrop,
    onHold,
  });
}
