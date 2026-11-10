import type { RefObject } from "react";
import { movedTo } from "../record/childOrder";
import { usePressDrag, type DragLocation } from "./usePressDrag";

/** Drag-to-rearrange for the records of a multi-record field kept in order, in
 * the record editor: {@link usePressDrag}, over the rows one page of the list
 * shows, picked up by a record's embedded record.
 *
 * What's in hand can be more than the record pressed on: the selection it's
 * part of, taken along in the order it's in (`moving`). The drop is a gap
 * between the rows shown — 0 before the first, `ids.length` after the last —
 * and a gap that would leave them where they are is none.
 *
 * Like a field's row, a record's row can be tall, holding the record's own form
 * once it's opened. Only the rows of this list count, whichever nested row the
 * pointer happens to be over, and each row's gap is the nearer of the two
 * around it.
 *
 * `listRef` is the element whose direct children are the rows (each marked
 * `data-child-row`, in `ids` order). */
export function useChildDrag(opts: {
  listRef: RefObject<HTMLElement | null>;
  ids: readonly string[];
  /** The records picking up `id` takes along: it, or the selection it's in. */
  moving: (id: string) => readonly string[];
  /** Makes the drop; returns whether anything actually moved. */
  onDrop: (id: string, gap: number) => boolean;
  /** A touch held on the record and let go without moving it — the touch
   * equivalent of a right-click, at viewport point (x, y). */
  onHold: (id: string, x: number, y: number) => void;
}) {
  const { listRef, ids, moving, onDrop, onHold } = opts;

  const locate = (id: string, _x: number, y: number): DragLocation<number> => {
    const none = { target: null, lineTop: 0 };
    const list = listRef.current;
    if (!list) return none;
    const rows = Array.from(list.children).filter((el) =>
      el.hasAttribute("data-child-row"),
    );
    if (rows.length !== ids.length || rows.length === 0) return none;

    let gap = rows.findIndex((row) => {
      const r = row.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (gap === -1) gap = rows.length;
    const next = movedTo(ids, moving(id), gap);
    if (next.every((child, i) => child === ids[i])) return none;

    const edge =
      gap < rows.length
        ? rows[gap].getBoundingClientRect().top
        : rows[rows.length - 1].getBoundingClientRect().bottom;
    return { target: gap, lineTop: edge - list.getBoundingClientRect().top };
  };

  return usePressDrag<string, number>({
    listRef,
    scroller: () => listRef.current?.closest("[data-scroll-area]"),
    locate,
    onDrop,
    onHold,
  });
}
