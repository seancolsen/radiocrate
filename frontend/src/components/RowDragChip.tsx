import { forwardRef } from "react";
import { Icons } from "../icons";

/** The chip that follows the pointer while result rows are being dragged,
 * saying how many tracks are in hand ("3 tracks").
 *
 * Its owner places it, imperatively, as the pointer moves (its
 * `style.transform`), so a move costs no render. It's never a hit target, so
 * the drop target found under the pointer is never the chip itself. */
const RowDragChip = forwardRef<HTMLDivElement, { count: number }>(
  function RowDragChip(props, ref) {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className="bg-accent text-panel pointer-events-none fixed top-0 left-0 z-50 flex items-center gap-1 rounded-md px-2 py-1 text-sm whitespace-nowrap shadow-md"
      >
        <Icons.Playlist className="size-[14px] shrink-0" />
        {props.count === 1 ? "1 track" : `${props.count} tracks`}
      </div>
    );
  },
);

export default RowDragChip;
