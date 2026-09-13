import type { JSX } from "react";
import type { Stores } from "../../stores/createStores";
import { SETTINGS } from "../../../state/settings";
import { QUERIES_FIXTURE } from "../../../dev/fixtures";
import { STUB_VERSION } from "../../../dev/harness/mockApi";

import { AboutDialog } from "../../components/AboutModal";
import { SettingDialog } from "../../components/SettingModal";
import Explorer from "../../components/Explorer";
import { UpdateBar } from "../../components/UpdateBanner";
import { Menu } from "../../components/ui/Menu";
import SettingsMenu from "../../components/SettingsMenu";
import SidebarLeft from "../../components/ui/SidebarLeft";

// The visual-test harness's catalogue: one entry per snapshot, each putting a
// single component on screen with the state or props that snapshot is about —
// and nothing else. `tests/visual/*.spec.ts` navigate to
// `/react-harness.html?story=<id>` and shoot the stage (or, for a component
// that portals out of it, the dialog or menu it raised).
//
// Ported from `dev/harness/stories.tsx`. Story ids don't change across the
// port — they're the baseline paths — and a story's `setup(store, commands)`
// becomes `setup(stores)`, since every store now lives in one bundle.
//
// A story is meant to read as the shortest description of what the snapshot
// shows. When one can't — when reaching a state takes a chain of interactions
// against a stand-in backend — that's the sign the scenario belongs in an
// end-to-end test against a real one instead.

/** One catalogue entry. */
export interface Story {
  /** Stage width in CSS px. Omit to fill the viewport (which is then the
   * test's to size — what a component whose own layout responds to the
   * viewport, like `SidebarLeft`, needs). */
  width?: number;
  /** Stage height in CSS px. Omit to let the stage hug its contents. */
  height?: number;
  /** Extra classes for the stage — its flex direction, mostly. */
  frame?: string;
  /** Puts the stores into the state the story is about, once the canned
   * query and preset lists have loaded. */
  setup?: (stores: Stores) => void;
  render: () => JSX.Element;
}

const [LEMONADE, DEEP_CUTS] = QUERIES_FIXTURE;

/** Opens the "Lemonade" fixture query in a tab and returns its id. */
function openLemonade(stores: Stores): string {
  stores.app.actions.openTab({
    id: LEMONADE.id,
    name: LEMONADE.name,
    definition: "",
  });
  return LEMONADE.id;
}

/** Filler for the stories about a component's own layout rather than about
 * anything it holds. */
function Lorem(props: { heading: string; lines: number }): JSX.Element {
  const text =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do " +
    "eiusmod tempor incididunt ut labore et dolore magna aliqua.";
  return (
    <div className="text-ink flex flex-col gap-2 p-3 text-sm">
      <h2 className="font-semibold">{props.heading}</h2>
      {Array.from({ length: props.lines }, (_, i) => (
        <p key={i} className="text-ink-weak">
          {text}
        </p>
      ))}
    </div>
  );
}

export const STORIES: Record<string, Story> = {
  // ── The app's left sidebar, as a general-purpose panel ────────────────────
  // Both stories are about `SidebarLeft`'s two layouts and nothing else, so
  // what it holds is filler. The layout it picks comes from the viewport, so
  // these stories take their size from the test rather than declaring one.
  "sidebar-left/open-persistent": {
    frame: "flex",
    render: () => (
      <SidebarLeft
        open
        onClose={() => {}}
        main={<Lorem heading="Main content" lines={3} />}
      >
        <Lorem heading="Sidebar" lines={2} />
      </SidebarLeft>
    ),
  },
  "sidebar-left/open-ephemeral": {
    frame: "flex",
    render: () => (
      <SidebarLeft
        open
        onClose={() => {}}
        main={<Lorem heading="Main content" lines={3} />}
      >
        <Lorem heading="Sidebar" lines={2} />
      </SidebarLeft>
    ),
  },

  // ── The explorer, without the panel it fills ─────────────────────────────
  "explorer/basic": {
    width: 200,
    height: 600,
    frame: "flex flex-col",
    setup: (stores) => {
      const active = openLemonade(stores);
      stores.app.actions.openTab({
        id: DEEP_CUTS.id,
        name: DEEP_CUTS.name,
        definition: "",
      });
      stores.app.actions.selectTab(active);
    },
    render: () => <Explorer />,
  },

  // ── Settings ─────────────────────────────────────────────────────────────
  "settings/menu": {
    width: 200,
    // Tall enough to clear the menu's bottom edge (its last row is "About
    // RadioCrate"), so the snapshot isn't cropping the panel.
    height: 350,
    render: () => (
      <Menu defaultOpen width="180px" trigger={() => null}>
        <SettingsMenu />
      </Menu>
    ),
  },
  // The Querydown prelude setting in its editor, holding the default value —
  // the state the dialog opens in for anyone who hasn't customized it, and the
  // one that shows both the monospace field and the disabled "Reset to default".
  "settings/prelude": {
    render: () => (
      <SettingDialog
        name={SETTINGS.querydown_prelude.name}
        description={SETTINGS.querydown_prelude.description}
        value={SETTINGS.querydown_prelude.default}
        defaultValue={SETTINGS.querydown_prelude.default}
        onSave={() => {}}
        onClose={() => {}}
      />
    ),
  },

  // ── Client update + About ────────────────────────────────────────────────
  // The client-update bar in both of its notices: the dismissible "ready" one
  // over the persistent "stale" one.
  "update/banner": {
    width: 720,
    frame: "flex flex-col gap-2",
    render: () => (
      <>
        <UpdateBar notice="ready" onReload={() => {}} onDismiss={() => {}} />
        <UpdateBar notice="stale" onReload={() => {}} onDismiss={() => {}} />
      </>
    ),
  },
  // The About dialog on a *mismatched* pair of build ids — the state it exists
  // to explain. Both ids are pinned here (the client's by prop, the server's by
  // `STUB_VERSION`) rather than read from `__BUILD_ID__`, so the baseline
  // doesn't churn with every commit.
  "about/modal": {
    render: () => (
      <AboutDialog
        clientBuildId="3c7ae10"
        version={STUB_VERSION}
        onCheck={() => {}}
        onReloadFresh={() => {}}
        onClose={() => {}}
      />
    ),
  },
};
