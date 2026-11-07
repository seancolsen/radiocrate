import { forwardRef } from "react";
import { Icons } from "../icons";
import DragChip from "./ui/DragChip";

/** The chip that follows the pointer while result rows are being dragged,
 * saying how many tracks are in hand ("3 tracks").
 *
 * Its owner places it, imperatively, as the pointer moves (its
 * `style.transform`), so a move costs no render. */
const RowDragChip = forwardRef<HTMLDivElement, { count: number }>(
  function RowDragChip(props, ref) {
    return (
      <DragChip
        ref={ref}
        icon={Icons.Playlist}
        label={props.count === 1 ? "1 track" : `${props.count} tracks`}
      />
    );
  },
);

export default RowDragChip;
