import { Activity, type JSX } from "react";
import { useShallow } from "zustand/shallow";
import { selectTab } from "./stores/app";
import { useApp, useAppActions } from "./stores/react";
import SidebarLeft from "./components/ui/SidebarLeft";
import Explorer from "./components/Explorer";
import TabBar from "./components/TabBar";
import QueryPage from "./components/QueryPage";
import ShortcutsPage from "./components/ShortcutsPage";
import NowPlaying from "./components/NowPlaying";
import CommandPalette from "./components/CommandPalette";
import RpcErrorBanner from "./components/RpcErrorBanner";
import UpdateBanner from "./components/UpdateBanner";
import AboutModal from "./components/AboutModal";
import DeleteConfirmModal from "./components/DeleteConfirmModal";
import SettingModal from "./components/SettingModal";

/** One tab's page: the one its kind calls for. The one place tab kinds fan out
 * into pages — every other tab surface (the bar, the explorer's "Opened" list,
 * the tab commands) stays kind-agnostic.
 *
 * Subscribes to the tab's kind alone, not to the tab: a page keeps its own
 * state across every edit to the query it holds, and this is what decides
 * which page exists at all. */
function TabPage(props: { tabId: string }): JSX.Element | null {
  const kind = useApp((s) => selectTab(s, props.tabId)?.kind);
  if (kind === "query") return <QueryPage tabId={props.tabId} />;
  if (kind === "shortcuts") return <ShortcutsPage />;
  return null;
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
          <TabPage tabId={id} />
        </Activity>
      ))}
      {!tabIds.includes(activeTabId ?? "") && (
        <div className="bg-panel min-h-0 flex-1" />
      )}
    </>
  );
}

/** The main column, right of the explorer: tab bar, the active tab's content,
 * the failed-RPC and client-update bars when there's one to show, and the
 * now-playing bar pinned to the bottom (which spans this column only — the
 * explorer keeps its own full height). */
function Main(): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <TabBar />
      <TabContent />
      <RpcErrorBanner />
      <UpdateBanner />
      <NowPlaying />
    </div>
  );
}

export default function App(): JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const { setSidebarOpen } = useAppActions();

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
        onClose={() => setSidebarOpen(false)}
        main={<Main />}
      >
        <Explorer />
      </SidebarLeft>

      {/* App-wide overlays, above every panel and both layouts. */}
      <CommandPalette />
      <AboutModal />
      <SettingModal />
      {/* Raised from a query page's actions menu or from the explorer, whose
          query need not be open. */}
      <DeleteConfirmModal />
    </div>
  );
}
