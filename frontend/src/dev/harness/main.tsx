import { createEffect, createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { AppStateProvider, useAppState } from "../../state/store";
import { CommandProvider, useCommands } from "../../state/commands";
import { installMockApi } from "./mockApi";
import { STORIES } from "./stories";
import "../../app.css";

// The visual-test harness's entry point, served at `/harness.html?story=<id>`.
// It mounts exactly one component — the story named by the URL — on a stage
// sized by that story, over a stubbed backend. No app frame, no router, no
// service worker: whatever ends up in the screenshot belongs to the component
// under test.
//
// Dev-only by construction: `vite build` takes `index.html` as its single
// input, so neither this page nor anything it reaches is in the production
// bundle.

installMockApi();

const storyId = new URLSearchParams(window.location.search).get("story") ?? "";
const story = STORIES[storyId];

/** The stage: a box of the story's size, holding the story's component. Marked
 * `data-testid="story"` — what the specs shoot, unless the component portals
 * itself out of it (a modal, a context menu), in which case they shoot that. */
function Harness() {
  const store = useAppState();
  const commands = useCommands();
  const [ready, setReady] = createSignal(story?.setup === undefined);

  // The canned query and preset lists resolve a tick after mount, and some
  // stories are built on top of them (a preset's name, a tab's saved query), so
  // setup waits for both — then the story renders, once, into a settled store.
  createEffect(() => {
    if (ready() || store.queries() === undefined || !store.presetsReady())
      return;
    story?.setup?.(store, commands);
    setReady(true);
  });

  // A stage with no declared width fills the viewport in both directions — what
  // a component whose own layout responds to the viewport needs, and what makes
  // the test's `setViewportSize` the story's size.
  const width = () =>
    story?.width === undefined ? "100vw" : `${story.width}px`;
  const height = () =>
    story?.height !== undefined
      ? `${story.height}px`
      : story?.width === undefined
        ? "100vh"
        : undefined;

  return (
    <div
      data-testid="story"
      class={`bg-panel relative ${story?.frame ?? ""}`}
      style={{ width: width(), height: height() }}
    >
      <Show when={story} fallback={<UnknownStory />}>
        {(s) => <Show when={ready()}>{s().render()}</Show>}
      </Show>
    </div>
  );
}

/** What a mistyped `?story=` gets: the ids that do exist, so the failure names
 * itself instead of showing an empty page. */
function UnknownStory() {
  return (
    <pre class="text-ink p-4 text-xs">
      {`Unknown story "${storyId}". Known stories:\n\n` +
        Object.keys(STORIES).sort().join("\n")}
    </pre>
  );
}

render(
  () => (
    <AppStateProvider>
      <CommandProvider>
        <Harness />
      </CommandProvider>
    </AppStateProvider>
  ),
  document.getElementById("root")!,
);
