import type { JSX } from "react";
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
import SettingModal from "./components/SettingModal";

/** The content area of the active tab: the page its kind calls for, or a blank
 * panel when no tab is open. The one place tab kinds fan out into pages — every
 * other tab surface (the bar, the explorer's "Opened" list, the tab commands)
 * stays kind-agnostic.
 *
 * Subscribes to the active tab's id and kind alone, not to the tab: a page
 * keeps its own state across every edit to the query it holds, and this is what
 * decides which page exists at all. */
function TabContent(): JSX.Element | null {
  const activeTabId = useApp((s) => s.activeTabId);
  const kind = useApp((s) =>
    s.activeTabId === null ? undefined : selectTab(s, s.activeTabId)?.kind,
  );
  if (activeTabId === null || kind === undefined) {
    return <div className="bg-panel min-h-0 flex-1" />;
  }
  if (kind === "query") return <QueryPage tabId={activeTabId} />;
  if (kind === "shortcuts") return <ShortcutsPage />;
  return null;
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
    </div>
  );
}
