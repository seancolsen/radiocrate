import type { JSX } from "react";
import type { Stores } from "../../stores/createStores";

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
// Empty until the components it would catalogue exist (stage 3 onward); this
// stage only needs the type and a live, story-less harness.

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

export const STORIES: Record<string, Story> = {};
