import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Calls `onResize` with the element behind `ref` as soon as it mounts, again
 * whenever the element's size changes, and again whenever `onResize` itself
 * changes — so a callback that also depends on other inputs (the text a value
 * shows, say) re-evaluates when those do. One `ResizeObserver` serves the
 * element's whole life; it always calls the latest callback, read through a
 * ref.
 *
 * Both effects are layout effects, so whatever the callback measures on mount
 * is in place before the first paint.
 */
export function useResizeObserver<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onResize: (el: T) => void,
): void {
  const callback = useRef(onResize);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => callback.current(el));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  useLayoutEffect(() => {
    callback.current = onResize;
    const el = ref.current;
    if (el) onResize(el);
  }, [ref, onResize]);
}

/** Which width {@link useElementWidth} reports. `"content"` is the content box
 * (padding and border excluded, fractional), which is what a layout threshold
 * compares against. `"client"` is `clientWidth` (padding included, whole
 * pixels). */
export type WidthBox = "content" | "client";

/** The element's width, kept current as it resizes, and measured before the
 * first paint. */
export function useElementWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
  box: WidthBox = "content",
): number {
  const [width, setWidth] = useState(0);
  useResizeObserver(ref, (el) =>
    setWidth(box === "client" ? el.clientWidth : contentWidth(el)),
  );
  return width;
}

/** The width of `el`'s content box, the same value a `ResizeObserver` entry's
 * `contentRect.width` reports. */
function contentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const px = (value: string) => Number.parseFloat(value) || 0;
  return (
    el.getBoundingClientRect().width -
    px(style.paddingLeft) -
    px(style.paddingRight) -
    px(style.borderLeftWidth) -
    px(style.borderRightWidth)
  );
}
