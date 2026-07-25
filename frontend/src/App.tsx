import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { useAppState } from "./state/store";
import { useSwipeToClose } from "./gestures/useSwipeToClose";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import QueryPage from "./components/QueryPage";
import NowPlaying from "./components/NowPlaying";

/** Viewport width at/above which the sidebar is a persistent left panel instead
 * of a modal drawer (PERSISTENT_ORGANIZER_MIN_WIDTH). */
const PERSISTENT_MIN_WIDTH = 500;
const SIDEBAR_WIDTH = 200;
/** ORGANIZER_ANIM_TIME. */
const ANIM_MS = 100;

/** The content area of the active tab: a query page when a tab is open,
 * otherwise a blank panel (no tab open). */
function TabContent() {
  const store = useAppState();
  return (
    <Show
      when={store.state.activeTabId}
      fallback={<div class="bg-panel min-h-0 flex-1" />}
    >
      {(tabId) => <QueryPage tabId={tabId()} />}
    </Show>
  );
}

/** The main column, right of the sidebar: tab bar, the active tab's content, and
 * the now-playing bar pinned to the bottom (which spans this column only — the
 * sidebar keeps its own full height, as in the egui layout). */
function Main() {
  return (
    <div class="flex min-w-0 flex-1 flex-col">
      <TabBar />
      <TabContent />
      <NowPlaying />
    </div>
  );
}

export default function App() {
  const store = useAppState();

  const [width, setWidth] = createSignal(
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  onMount(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });
  const persistent = () => width() >= PERSISTENT_MIN_WIDTH;

  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const swipe = useSwipeToClose(store, () => SIDEBAR_WIDTH);

  const drawerVisible = () => store.state.sidebarOpen || swipe.dragging();
  const drawerTransform = () =>
    drawerVisible() ? `translateX(${swipe.offset()}px)` : "translateX(-100%)";
  // Scrim fades with the drag; full when open at rest.
  const scrimOpacity = () =>
    drawerVisible()
      ? Math.max(0, Math.min(1, 1 + swipe.offset() / SIDEBAR_WIDTH))
      : 0;

  return (
    <div
      class="bg-panel fixed inset-0 flex"
      style={{
        "padding-top": "env(safe-area-inset-top)",
        "padding-right": "env(safe-area-inset-right)",
        "padding-bottom": "env(safe-area-inset-bottom)",
        "padding-left": "env(safe-area-inset-left)",
      }}
    >
      <Show when={persistent()} fallback={<DrawerLayout />}>
        <Show when={store.state.sidebarOpen}>
          <Sidebar />
        </Show>
        <Main />
      </Show>
    </div>
  );

  /** Narrow viewport: the sidebar overlays as a modal drawer with a scrim. The
   * drawer node stays mounted (translated off-screen when closed) so slide
   * animations and an in-flight swipe's release handler both work. */
  function DrawerLayout() {
    return (
      <>
        <Main />
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
          onClick={() => store.setSidebarOpen(false)}
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
          <Sidebar />
        </div>
      </>
    );
  }
}
