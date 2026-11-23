import { useEffect, useState, type RefObject } from "react";
import { tabbable, type FocusableElement } from "tabbable";

/** Keeps the keyboard inside a modal surface (`ref`) for as long as it's
 * mounted: Tab and Shift+Tab cycle through its focusable elements — in tab
 * order, as `tabbable` finds them — wrapping at either end rather than leaving
 * for the page behind it.
 *
 * As the surface mounts, focus moves onto it, unless something within it has
 * already taken it (a field that focuses itself in a layout effect): the
 * surface itself, which must be focusable (`tabIndex={-1}`). As it unmounts,
 * focus goes back to what held it before — when nothing else has taken it in
 * the meantime, as an action closing the surface may have.
 *
 * Focus that's somewhere else altogether is left alone: a menu raised from
 * inside the surface is portaled out of it and keeps its own trap, and a
 * dialog raised over this one keeps its own. Nor does a Tab something within
 * the surface has already handled (`defaultPrevented`) count — a code editor
 * accepting a completion with it. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  // What had focus before the surface was there — read as it first renders,
  // before anything inside it can focus itself.
  const [previous] = useState(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );

  useEffect(() => {
    const surface = ref.current;
    if (!surface) return;
    if (!surface.contains(document.activeElement)) {
      surface.focus({ preventScroll: true });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      const lost = active === null || active === document.body;
      if (!lost && !surface.contains(active)) return;
      e.preventDefault();
      const stops = tabbable(surface);
      if (stops.length === 0) {
        surface.focus({ preventScroll: true });
        return;
      }
      const next = nextStop(stops, lost ? null : active, surface, e.shiftKey);
      next.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const now = document.activeElement;
      if (
        (now === null || now === document.body || surface.contains(now)) &&
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !surface.contains(previous)
      ) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [ref, previous]);
}

/** The stop Tab (or Shift+Tab, `back`) moves to from `active`. From the
 * surface itself or from nothing, that's the first stop (or the last); from an
 * element that isn't a stop itself (one with `tabIndex={-1}`, say), it's the
 * stop after it in the document (or before it). Either way it wraps around. */
function nextStop(
  list: readonly FocusableElement[],
  active: Element | null,
  surface: HTMLElement,
  back: boolean,
): FocusableElement {
  const first = list[0];
  const last = list[list.length - 1];
  if (active === null || active === surface) return back ? last : first;
  const at = list.indexOf(active as FocusableElement);
  if (at >= 0) {
    return list[(at + (back ? -1 : 1) + list.length) % list.length];
  }
  if (back) {
    const before = list.filter(
      (stop) =>
        stop.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return before[before.length - 1] ?? last;
  }
  return (
    list.find(
      (stop) =>
        stop.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING,
    ) ?? first
  );
}
