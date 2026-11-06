import { useRef, type JSX, type ReactNode } from "react";
import { revealStyles, useSwipeToClose } from "../../gestures/useSwipeToClose";
import { cx } from "./cx";
import SidebarResizeHandle from "./SidebarResizeHandle";
import { usePersistentSidebar } from "./usePersistentSidebar";

/** The least width a persistent panel leaves to the main content. */
const MIN_MAIN_WIDTH = 240;
/** The least width a drawer leaves uncovered, for its scrim to be tapped on. */
const MIN_SCRIM_WIDTH = 48;

/** The panel's own chrome — surface, right edge, resize handle — around whatever
 * it was given to hold. How wide that makes it is up to the layout around it,
 * bar the space `reserve` that a drag can't take away. */
function Panel(props: {
  label?: string;
  reserve: number;
  onResize: (px: number) => void;
  onResizeEnd: () => void;
  className?: string;
  style?: { width: string; maxWidth: string };
  children: ReactNode;
}): JSX.Element {
  return (
    <aside
      aria-label={props.label}
      className={cx(
        "bg-panel border-edge relative flex h-full flex-col border-r",
        props.className,
      )}
      style={props.style}
    >
      {props.children}
      <SidebarResizeHandle
        edge="right"
        label={`Resize ${props.label?.toLowerCase() ?? "sidebar"}`}
        maxWidth={() => window.innerWidth - props.reserve}
        onResize={props.onResize}
        onCommit={props.onResizeEnd}
      />
    </aside>
  );
}

/** The panel as a modal drawer over the main content, behind a dimming scrim.
 * Closes on a tap on the scrim, or a swipe across either (`useSwipeToClose`).
 *
 * It stays mounted while closed, so it can slide; `invisible` then takes it out
 * of the tab order and the accessibility tree, once the slide is over. */
function Drawer(props: {
  open: boolean;
  onClose: () => void;
  width: number;
  children: ReactNode;
}): JSX.Element {
  const zoneRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  useSwipeToClose({
    zoneRef,
    panelRef,
    scrimRef,
    enabled: props.open,
    onClose: props.onClose,
  });
  const styles = revealStyles(props.open ? 1 : 0);

  return (
    <div
      ref={zoneRef}
      className="group pointer-events-none absolute inset-0 z-20"
    >
      <div
        ref={scrimRef}
        aria-hidden="true"
        className={cx(
          "absolute inset-0 touch-pan-y touch-pinch-zoom bg-black transition-[opacity,visibility] duration-200 ease-out group-data-swiping:transition-none motion-reduce:transition-none",
          { "pointer-events-auto": props.open, invisible: !props.open },
        )}
        style={styles.scrim}
        onClick={() => props.onClose()}
      />
      <div
        ref={panelRef}
        className={cx(
          "absolute top-0 left-0 h-full touch-pan-y touch-pinch-zoom transition-[transform,visibility] duration-200 ease-out group-data-swiping:transition-none group-data-swiping:will-change-transform motion-reduce:transition-none",
          { "pointer-events-auto": props.open, invisible: !props.open },
        )}
        style={{
          ...styles.panel,
          width: `${props.width}px`,
          maxWidth: `calc(100% - ${MIN_SCRIM_WIDTH}px)`,
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

/** A general-purpose left sidebar with the app's two layouts, and nothing about
 * what either one holds: wide enough, `children` is a persistent column left of
 * `main`; narrower, it becomes a modal drawer over `main`. Either way its width
 * is the caller's, which the panel's handle asks to change.
 *
 * `main` keeps its place among the children in both layouts, so crossing from
 * one to the other (rotating a phone) doesn't remount the page. */
export default function SidebarLeft(props: {
  open: boolean;
  onClose: () => void;
  /** The panel's width in CSS px. */
  width: number;
  /** A new width, while the panel's handle is being dragged… */
  onResize: (px: number) => void;
  /** …and the drag is over. */
  onResizeEnd: () => void;
  /** Accessible name for the panel. */
  label?: string;
  /** The panel's contents. */
  children: ReactNode;
  /** Everything right of (or beneath) the panel. */
  main: ReactNode;
}): JSX.Element {
  const persistent = usePersistentSidebar();
  const panel = (
    reserve: number,
    className?: string,
    style?: { width: string; maxWidth: string },
  ) => (
    <Panel
      label={props.label}
      reserve={reserve}
      onResize={props.onResize}
      onResizeEnd={props.onResizeEnd}
      className={className}
      style={style}
    >
      {props.children}
    </Panel>
  );

  return (
    <>
      {persistent &&
        props.open &&
        panel(MIN_MAIN_WIDTH, "shrink-0", {
          width: `${props.width}px`,
          maxWidth: `calc(100% - ${MIN_MAIN_WIDTH}px)`,
        })}
      {props.main}
      {!persistent && (
        <Drawer open={props.open} onClose={props.onClose} width={props.width}>
          {panel(MIN_SCRIM_WIDTH)}
        </Drawer>
      )}
    </>
  );
}
