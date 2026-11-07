import type { RefObject } from "react";
import { usePressDrag, type DragLocation } from "./usePressDrag";

/** Where a dragged field would land: between the fields shown just above and
 * just below, either of which is `undefined` at an edge. */
export interface FieldDropTarget {
  above: string | undefined;
  below: string | undefined;
}

/** Drag-to-rearrange for a record's fields in the record editor:
 * {@link usePressDrag}, over one flat list, picked up by a field's label.
 *
 * A row can be tall, since it also holds whatever the field expands into, nested
 * lists of fields included. Only the rows of this list count, whichever nested
 * row the pointer happens to be over, and each row's gap is the nearer of the two
 * around it.
 *
 * `listRef` is the element whose direct children are the rows (each marked
 * `data-field-row`, in `keys` order). */
export function useFieldDrag(opts: {
  listRef: RefObject<HTMLElement | null>;
  keys: readonly string[];
  /** Makes the drop; returns whether anything actually moved. */
  onDrop: (key: string, target: FieldDropTarget) => boolean;
  /** A touch held on the label and let go without moving it — the touch
   * equivalent of a right-click, at viewport point (x, y). */
  onHold: (key: string, x: number, y: number) => void;
}) {
  const { listRef, keys, onDrop, onHold } = opts;

  const locate = (
    key: string,
    _x: number,
    y: number,
  ): DragLocation<FieldDropTarget> => {
    const none = { target: null, lineTop: 0 };
    const list = listRef.current;
    if (!list) return none;
    const rows = Array.from(list.children).filter((el) =>
      el.hasAttribute("data-field-row"),
    );
    if (rows.length !== keys.length) return none;

    let gap = rows.findIndex((row) => {
      const r = row.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    if (gap === -1) gap = rows.length;
    // Either side of the field in hand leaves it where it is.
    const from = keys.indexOf(key);
    if (gap === from || gap === from + 1) return none;

    const edge =
      gap < rows.length
        ? rows[gap].getBoundingClientRect().top
        : rows[rows.length - 1].getBoundingClientRect().bottom;
    return {
      target: { above: keys[gap - 1], below: keys[gap] },
      lineTop: edge - list.getBoundingClientRect().top,
    };
  };

  return usePressDrag<string, FieldDropTarget>({
    listRef,
    scroller: () => listRef.current?.closest("[data-scroll-area]"),
    locate,
    onDrop,
    onHold,
  });
}
