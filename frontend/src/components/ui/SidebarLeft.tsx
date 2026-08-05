import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { useSwipeToClose } from "../../gestures/useSwipeToClose";

/** Viewport width at/above which the panel is persistent — a column beside the
 * main content — instead of a modal drawer over it
 * (PERSISTENT_ORGANIZER_MIN_WIDTH). */
export const PERSISTENT_MIN_WIDTH = 500;
/** The panel's width in CSS px (ORGANIZER_WIDTH). */
export const SIDEBAR_WIDTH = 200;
/** Slide/fade duration for the drawer (ORGANIZER_ANIM_TIME). */
const ANIM_MS = 100;

/** A general-purpose left sidebar with the app's two layouts, and nothing about
 * what either one holds: wide enough, `children` is a persistent column left of
 * `main`; narrower, it becomes a modal drawer over `main` behind a dimming
 * scrim, closable by tapping the scrim or swiping the drawer away.
 *
 * The drawer node stays mounted (translated off-screen when closed) so the slide
 * animation and an in-flight swipe's release handler both work; the persistent
 * column is mounted only while open, since there's nothing to animate. */
export default function SidebarLeft(props: {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the panel. */
  label?: string;
  /** The panel's contents. */
  children: JSX.Element;
  /** Everything right of (or beneath) the panel. */
  main: JSX.Element;
}): JSX.Element {
  const [viewport, setViewport] = createSignal(
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  onMount(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });
  const persistent = () => viewport() >= PERSISTENT_MIN_WIDTH;

  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const swipe = useSwipeToClose(
    () => props.onClose(),
    () => SIDEBAR_WIDTH,
  );

  const drawerVisible = () => props.open || swipe.dragging();
  const drawerTransform = () =>
    drawerVisible() ? `translateX(${swipe.offset()}px)` : "translateX(-100%)";
  // Scrim fades with the drag; full when open at rest.
  const scrimOpacity = () =>
    drawerVisible()
      ? Math.max(0, Math.min(1, 1 + swipe.offset() / SIDEBAR_WIDTH))
      : 0;

  /** The panel's own chrome — surface, right edge, fixed width — around whatever
   * it was given to hold. */
  const panel = () => (
    <aside
      aria-label={props.label}
      class="bg-panel border-edge flex h-full flex-col border-r"
      style={{ width: `${SIDEBAR_WIDTH}px` }}
    >
      {props.children}
    </aside>
  );

  return (
    <Show when={persistent()} fallback={<DrawerLayout />}>
      <Show when={props.open}>{panel()}</Show>
      {props.main}
    </Show>
  );

  function DrawerLayout() {
    return (
      <>
        {props.main}
        {/* Scrim: shown while open or mid-drag; tap to close. */}
        <div
          aria-hidden="true"
          class="absolute inset-0 bg-black"
          classList={{ "pointer-events-none": !drawerVisible() }}
          style={{
            opacity: `${scrimOpacity() * 0.4}`,
            transition:
              swipe.dragging() || reducedMotion
                ? "none"
                : `opacity ${ANIM_MS}ms ease`,
            visibility: drawerVisible() ? "visible" : "hidden",
          }}
          onClick={() => props.onClose()}
        />
        <div
          class="absolute top-0 left-0 h-full"
          style={{
            transform: drawerTransform(),
            transition:
              swipe.dragging() || reducedMotion
                ? "none"
                : `transform ${ANIM_MS}ms ease`,
          }}
          onPointerDown={(e) => swipe.onPointerDown(e)}
        >
          {panel()}
        </div>
      </>
    );
  }
}
