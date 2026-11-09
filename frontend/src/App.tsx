import {
  Activity,
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/shallow";
import { selectTab } from "./stores/app";
import { useApp, useAppActions } from "./stores/react";
import SidebarLeft from "./components/ui/SidebarLeft";
import { usePersistentSidebar } from "./components/ui/usePersistentSidebar";
import Explorer from "./components/Explorer";
import TabBar from "./components/TabBar";
import NoTabsPage from "./components/NoTabsPage";
import QueryPage from "./components/QueryPage";
import ShortcutsPage from "./components/ShortcutsPage";
import PresetManager from "./components/PresetManager";
import PreludePage from "./components/PreludePage";
import NowPlaying from "./components/NowPlaying";
import CommandPalette from "./components/CommandPalette";
import TabSwitcher from "./components/TabSwitcher";
import RpcErrorBanner from "./components/RpcErrorBanner";
import UpdateBanner from "./components/UpdateBanner";
import ToastHost from "./components/Toast";
import AboutModal from "./components/AboutModal";
import AddToPlaylistModal from "./components/AddToPlaylistModal";
import DeleteConfirmModal from "./components/DeleteConfirmModal";
import ExportDataModal from "./components/ExportDataModal";

/** One tab's page: the one its kind calls for. The one place tab kinds fan out
 * into pages — every other tab surface (the bar, the explorer's "Opened" list,
 * the tab commands) stays kind-agnostic.
 *
 * Subscribes to the tab's kind alone, not to the tab: a page keeps its own
 * state across every edit to the query it holds, and this is what decides
 * which page exists at all. */
function TabPage(props: { tabId: string }): JSX.Element | null {
  const kind = useApp((s) => selectTab(s, props.tabId)?.kind);
  // A playlist's page is the query page: the differences are in what it runs
  // and which of the page's controls apply, decided further down.
  if (kind === "query" || kind === "playlist") {
    return <QueryPage tabId={props.tabId} />;
  }
  if (kind === "shortcuts") return <ShortcutsPage />;
  if (kind === "presets") return <PresetManager />;
  if (kind === "prelude") return <PreludePage />;
  return null;
}

/** What can hold focus on a page, in document order. */
const FOCUSABLE =
  'input, textarea, select, button, a[href], [contenteditable="true"], [tabindex]';

/** Where focus was in a page: the element, its place among the page's
 * focusable elements, and its caret or selection. */
interface SavedFocus {
  el: HTMLElement;
  /** Its place among the page's focusable elements — how an element that has
   * since been rebuilt (a CodeMirror view is, each time its page is shown) is
   * found again. */
  index: number;
  /** A text field's selection range: start, end, direction. */
  range?: [
    number | null,
    number | null,
    "forward" | "backward" | "none" | null,
  ];
  /** The selection inside a contenteditable. */
  domRange?: Range;
}

/** Notes where focus is on `el`, within `root`: which element, and its text
 * selection. `previous` is what was known of it before, whose place stands
 * when `el` has already left the page. */
function saveFocus(
  root: HTMLElement,
  el: EventTarget | null,
  previous: SavedFocus | null,
): SavedFocus | null {
  if (!(el instanceof HTMLElement) || el === document.body) return null;
  const index = root.contains(el)
    ? [...root.querySelectorAll(FOCUSABLE)].indexOf(el)
    : (previous?.index ?? -1);
  const saved: SavedFocus = { el, index };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    saved.range = [el.selectionStart, el.selectionEnd, el.selectionDirection];
  } else if (el.isContentEditable) {
    const selection = window.getSelection();
    if (selection?.rangeCount && el.contains(selection.anchorNode)) {
      saved.domRange = selection.getRangeAt(0).cloneRange();
    }
  }
  return saved;
}

/** Puts focus and the selection back as {@link saveFocus} found them, on the
 * same element or — when it has been rebuilt since — the one in its place. */
function restoreFocus(root: HTMLElement, saved: SavedFocus): void {
  let { el } = saved;
  if (!el.isConnected || !root.contains(el)) {
    const candidate =
      root.querySelectorAll<HTMLElement>(FOCUSABLE)[saved.index];
    if (candidate?.tagName !== el.tagName) return;
    el = candidate;
  }
  el.focus({ preventScroll: true });
  const { range, domRange } = saved;
  if (
    range &&
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
  ) {
    try {
      if (range[0] !== null && range[1] !== null) {
        el.setSelectionRange(range[0], range[1], range[2] ?? undefined);
      }
    } catch {
      // An input type with no text selection to restore.
    }
  } else if (domRange && el.contains(domRange.commonAncestorContainer)) {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(domRange);
  }
}

/** Gives a tab's page back the focus it had when the user left it. A hidden
 * page keeps its DOM but loses focus (a `display: none` element can't hold it),
 * so without this a half-typed query would come back with its caret gone.
 *
 * The page's focus and selection are noted as they change; the layout effect
 * runs again each time `<Activity>` shows the page, and puts them back unless
 * something else already holds focus. The wrapper has no box of its own
 * (`contents`), so the page lays out as if it weren't there. */
function KeepFocus(props: { children: ReactNode }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const saved = useRef<SavedFocus | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const last = saved.current;
    if (
      last &&
      (document.activeElement === null ||
        document.activeElement === document.body)
    ) {
      restoreFocus(root, last);
    }
    const onFocusIn = (e: FocusEvent) => {
      saved.current = saveFocus(root, e.target, saved.current);
    };
    // The caret moves while focus sits still, so it's read as focus leaves.
    const onFocusOut = (e: FocusEvent) => {
      if (saved.current?.el === e.target) {
        saved.current = saveFocus(root, e.target, saved.current);
      }
    };
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    return () => {
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      // Hidden with focus still inside it.
      if (root.contains(document.activeElement)) {
        saved.current = saveFocus(root, document.activeElement, saved.current);
      }
    };
  }, []);
  return (
    <div ref={rootRef} className="contents">
      {props.children}
    </div>
  );
}

/** The content area: every open tab's page, with all but the active one hidden.
 *
 * Each tab gets its own page instance for its whole life, and switching tabs
 * only changes which one is visible — so a tab switch can't disturb anything a
 * page holds, whether in a store, in component state or in the DOM (a scroll
 * position, a half-typed value). `<Activity mode="hidden">` keeps a hidden
 * page's state and DOM while running its effects' cleanups, so a hidden page
 * holds no listeners, subscriptions or keyboard registrations, and
 * re-installs them all when it's shown again. A page that has never been shown
 * renders at idle priority and runs no effects (its auto-run included) until
 * it is.
 *
 * The rule this upholds: **nothing about a tab may depend on its page
 * unmounting.** A page unmounts only when its tab closes; per-tab state that
 * must go with the tab is dropped by the stores (`closeTab`, and the forms
 * store's `retain`), not by a component's cleanup. */
function TabContent(): JSX.Element {
  const tabIds = useApp(useShallow((s) => s.tabs.map((t) => t.id)));
  const activeTabId = useApp((s) => s.activeTabId);
  return (
    <>
      {tabIds.map((id) => (
        <Activity key={id} mode={id === activeTabId ? "visible" : "hidden"}>
          <KeepFocus>
            <TabPage tabId={id} />
          </KeepFocus>
        </Activity>
      ))}
      {!tabIds.includes(activeTabId ?? "") && <NoTabsPage />}
    </>
  );
}

/** The main column, right of the explorer: tab bar, the active tab's content
 * (with any confirmation toast floating over its foot), the failed-RPC and
 * client-update bars when there's one to show, and the now-playing bar pinned
 * to the bottom (which spans this column only — the explorer keeps its own
 * full height). */
function Main(): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <TabBar />
      <TabContent />
      <ToastHost />
      <RpcErrorBanner />
      <UpdateBanner />
      <NowPlaying />
    </div>
  );
}

export default function App(): JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const explorerWidth = useApp((s) => s.explorerWidth);
  const noTabs = useApp((s) => s.tabs.length === 0);
  const persistent = usePersistentSidebar();
  const { setSidebarOpen, setExplorerWidth, commitExplorerWidth } =
    useAppActions();

  // With no tabs the explorer is pinned, so a drawer that was open is finished
  // with: left open, it would come back over whichever tab opens next.
  useEffect(() => {
    if (noTabs && !persistent) setSidebarOpen(false);
  }, [noTabs, persistent, setSidebarOpen]);

  return (
    <div
      className="bg-panel fixed inset-0 flex"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingRight: "env(safe-area-inset-right)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
      }}
    >
      <SidebarLeft
        open={sidebarOpen}
        pinned={noTabs}
        onClose={() => setSidebarOpen(false)}
        width={explorerWidth}
        onResize={setExplorerWidth}
        onResizeEnd={commitExplorerWidth}
        label="Explorer"
        main={<Main />}
      >
        <Explorer />
      </SidebarLeft>

      {/* App-wide overlays, above every panel and both layouts. */}
      <CommandPalette />
      <TabSwitcher />
      <AboutModal />
      {/* Raised from a query page's actions menu or from the explorer, whose
          query need not be open. */}
      <DeleteConfirmModal />
      {/* Raised from a result row's menu, on any page of tracks. */}
      <AddToPlaylistModal />
      <ExportDataModal />
    </div>
  );
}
