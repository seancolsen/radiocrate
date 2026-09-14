import { StrictMode, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { installMockApi } from "../../../dev/harness/mockApi";
import { createStores } from "../../stores/createStores";
import { StoresProvider, useApp, useStores } from "../../stores/react";
import { STORIES } from "./stories";
import "../../../app.css";

// The visual-test harness, served at `/harness.html?story=<id>`. It mounts
// exactly one component — the story named by the URL — on a stage sized by
// that story, over a stubbed backend. No app frame, no router, no service
// worker: whatever ends up in the screenshot belongs to the component under
// test.
//
// Dev-only by construction: `vite build` takes `index.html` as its only
// input, so neither this page nor anything it reaches is in the production
// bundle.

installMockApi();

const storyId = new URLSearchParams(window.location.search).get("story") ?? "";
const story = STORIES[storyId];

/** The stage: a box of the story's size, holding the story's component.
 * Marked `data-testid="story"` — what the specs shoot, unless the component
 * portals itself out of it (a modal, a context menu), in which case they
 * shoot that. */
function Harness() {
  const stores = useStores();
  // The canned query and preset lists resolve a tick after mount, and some
  // stories are built on top of them (a preset's name, a tab's saved query),
  // so setup waits for both — then the story renders into a settled store.
  // `dataReady` comes straight from the store subscription (no separate
  // "ready" state of our own to keep in sync with it — state management:
  // "force update / external sync" is what `useApp` already is), and
  // `setupRan` is a ref rather than state because running `setup` is a
  // one-time side effect, not something that should itself trigger a
  // render. The layout effect (not a passive one) runs before the browser
  // paints, so the store write it makes — and the re-render that gives the
  // subscribed story tree — lands before this frame is ever shown.
  const queriesReady = useApp((s) => s.queries.status === "ready");
  const presetsReady = useApp((s) => s.presetsStatus === "ready");
  const dataReady =
    story?.setup === undefined || (queriesReady && presetsReady);
  const setupRan = useRef(false);

  useLayoutEffect(() => {
    if (!dataReady || setupRan.current) return;
    setupRan.current = true;
    story?.setup?.(stores);
  }, [dataReady, stores]);

  // A stage with no declared width fills the viewport in both directions —
  // what a component whose own layout responds to the viewport needs, and
  // what makes the test's `setViewportSize` the story's size.
  const width = story?.width === undefined ? "100vw" : `${story.width}px`;
  const height =
    story?.height !== undefined
      ? `${story.height}px`
      : story?.width === undefined
        ? "100vh"
        : undefined;

  return (
    <div
      data-testid="story"
      className={`bg-panel relative ${story?.frame ?? ""}`}
      style={{ width, height }}
    >
      {story ? dataReady && story.render() : <UnknownStory />}
    </div>
  );
}

/** What a mistyped `?story=` gets: the ids that do exist, so the failure
 * names itself instead of showing an empty page. */
function UnknownStory() {
  return (
    <pre className="text-ink p-4 text-xs">
      {`Unknown story "${storyId}". Known stories:\n\n` +
        Object.keys(STORIES).sort().join("\n")}
    </pre>
  );
}

const stores = createStores();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoresProvider stores={stores}>
      <Harness />
    </StoresProvider>
  </StrictMode>,
);
