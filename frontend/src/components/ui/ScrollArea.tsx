import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { cx } from "./cx";

/** The thumb's geometry (px): the same overlay bar the results grid draws
 * (`canvasGrid.ts`). */
const THUMB_MIN_HEIGHT = 24;
/** How long the thumb stays after the last scroll or mouse move (ms). */
const HIDE_AFTER_MS = 1000;

/** A vertically scrolling region whose scrollbar comes and goes: an overlay
 * thumb that takes no room from the content, showing while the region scrolls
 * or the mouse moves over it and fading out once that stops. Under a mouse it
 * can also be dragged; under a finger it's only an indicator, and never gets
 * between the finger and what it's scrolling.
 *
 * Fills its flex parent. The forwarded ref is the element that actually scrolls.
 *
 * `touch-pan-y` is on the scroller because that's the one place it counts: a
 * scroller starts its descendants' pan restrictions afresh, whatever its
 * ancestors say. It leaves horizontal movement for a swipe to read. */
const ScrollArea = forwardRef<
  HTMLDivElement,
  {
    /** Classes for the content inside the scroller (its padding, say). */
    className?: string;
    children: ReactNode;
  }
>(function ScrollArea(props, ref) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => viewportRef.current!);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !content || !thumb) return;

    let hideTimer: number | undefined;
    let hovering = false;
    let dragging = false;

    const layout = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const range = scrollHeight - clientHeight;
      thumb.hidden = range <= 0;
      if (range <= 0) return;
      const height = Math.max(
        THUMB_MIN_HEIGHT,
        (clientHeight * clientHeight) / scrollHeight,
      );
      // An iOS overscroll bounce takes scrollTop out of range.
      const at = Math.max(0, Math.min(1, scrollTop / range));
      thumb.style.height = `${height}px`;
      thumb.style.transform = `translateY(${at * (clientHeight - height)}px)`;
    };

    const show = () => {
      window.clearTimeout(hideTimer);
      thumb.dataset.visible = "";
      if (hovering || dragging) return;
      hideTimer = window.setTimeout(() => {
        delete thumb.dataset.visible;
      }, HIDE_AFTER_MS);
    };

    const onScroll = () => {
      layout();
      show();
    };
    const onViewportPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch") show();
    };
    const onThumbEnter = () => {
      hovering = true;
      show();
    };
    const onThumbLeave = () => {
      hovering = false;
      show();
    };

    const onThumbDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const pointerId = e.pointerId;
      const startY = e.clientY;
      const startTop = viewport.scrollTop;
      thumb.setPointerCapture(pointerId);
      dragging = true;
      show();
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const { scrollHeight, clientHeight } = viewport;
        const travel = clientHeight - thumb.offsetHeight;
        if (travel <= 0) return;
        viewport.scrollTop =
          startTop +
          ((ev.clientY - startY) / travel) * (scrollHeight - clientHeight);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        thumb.removeEventListener("pointermove", onMove);
        thumb.removeEventListener("pointerup", onUp);
        thumb.removeEventListener("pointercancel", onUp);
        dragging = false;
        show();
      };
      thumb.addEventListener("pointermove", onMove);
      thumb.addEventListener("pointerup", onUp);
      thumb.addEventListener("pointercancel", onUp);
    };

    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("pointermove", onViewportPointerMove);
    thumb.addEventListener("pointerenter", onThumbEnter);
    thumb.addEventListener("pointerleave", onThumbLeave);
    thumb.addEventListener("pointerdown", onThumbDown);
    // Rows added, or the panel resized: nothing scrolled, but the thumb's
    // size is out of date.
    const observer = new ResizeObserver(layout);
    observer.observe(viewport);
    observer.observe(content);
    layout();

    return () => {
      window.clearTimeout(hideTimer);
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("pointermove", onViewportPointerMove);
      thumb.removeEventListener("pointerenter", onThumbEnter);
      thumb.removeEventListener("pointerleave", onThumbLeave);
      thumb.removeEventListener("pointerdown", onThumbDown);
    };
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewportRef}
        data-testid="scroll-area-scroller"
        className="absolute inset-0 touch-pan-y touch-pinch-zoom [scrollbar-width:none] overflow-y-auto overscroll-y-contain [&::-webkit-scrollbar]:hidden"
      >
        <div ref={contentRef} className={cx(props.className)}>
          {props.children}
        </div>
      </div>
      <div
        ref={thumbRef}
        aria-hidden="true"
        data-testid="scroll-thumb"
        hidden
        className="pointer-events-none absolute top-0 right-0.5 w-2 rounded-full bg-[rgb(130_130_130/0.55)] opacity-0 transition-opacity duration-200 data-visible:opacity-100 motion-reduce:transition-none pointer-fine:data-visible:pointer-events-auto"
      />
    </div>
  );
});

export default ScrollArea;
