import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { placeDropdown } from "./menuGeometry";

/** A tooltip of our own drawing, in place of the browser's `title`: `content`
 * in a small panel hung below (or, without room, above) whatever `children`
 * is, while the pointer is over it or the keyboard focus is in it. The panel
 * is portaled out to the body and placed like a menu, kept wholly inside the
 * viewport; `align` lines it up with the trigger's left (`start`) or right
 * (`end`) edge.
 *
 * `children` renders the trigger, given the panel's id to describe it by
 * (`aria-describedby`) while it shows. Escape hides it. */
export function Tooltip(props: {
  content: ReactNode;
  align?: "start" | "end";
  children: (describedBy: string | undefined) => ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const align = props.align ?? "start";

  // Placed before paint, so it never shows anywhere but where it belongs.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!open || !trigger || !panel) return;
    const root = document.documentElement;
    const p = placeDropdown(
      trigger.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: root.clientWidth, height: root.clientHeight },
      "below",
      align,
    );
    panel.style.left = `${p.left}px`;
    panel.style.top = `${p.top}px`;
  }, [open, align]);

  return (
    <span
      ref={triggerRef}
      className="inline-flex"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {props.children(open ? id : undefined)}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="tooltip"
            className="bg-panel border-edge text-ink pointer-events-none fixed top-0 left-0 z-[200] max-w-xs rounded-md border px-2.5 py-2 text-xs leading-5 shadow-lg"
          >
            {props.content}
          </div>,
          document.body,
        )}
    </span>
  );
}
