import { forwardRef, type CSSProperties } from "react";
import type { IconComponent } from "../../icons";

/** The chip that follows the pointer while something is being dragged, saying
 * what's in hand. Rendered into `document.body`, at the top left of the viewport,
 * for its owner to place through `style.transform` (see {@link dragChipTransform}).
 * It's never a hit target, so the drop target found under the pointer is never
 * the chip itself. */
const DragChip = forwardRef<
  HTMLDivElement,
  { icon: IconComponent; label: string; style?: CSSProperties }
>(function DragChip(props, ref) {
  const Icon = props.icon;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={props.style}
      className="control bg-accent text-panel pointer-events-none fixed top-0 left-0 z-50 flex items-center gap-1 rounded-md px-2 whitespace-nowrap shadow-md"
    >
      <Icon className="size-[14px] shrink-0" />
      {props.label}
    </div>
  );
});

export default DragChip;

/** Where a chip goes for a pointer at viewport point (x, y): just below and to
 * the right of it, where it doesn't cover what the pointer is over. */
export function dragChipTransform(x: number, y: number): string {
  return `translate(${x + 12}px, ${y + 12}px)`;
}
