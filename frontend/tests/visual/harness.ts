import { type Page } from "@playwright/test";

// The component harness's side of the visual tests. Every snapshot below the
// app level goes through here: `openStory` puts one component on screen at
// `/harness.html?story=<id>` — no app frame, no backend — and the test shoots
// it. What that component is showing is decided in `src/dev/harness/stories.tsx`,
// so a spec here says only which story, in which theme, and what it waits for.

export const SCHEMES = ["light", "dark"] as const;
export type ColorScheme = (typeof SCHEMES)[number];

/** The viewport a story gets unless it says otherwise. Only a component whose
 * own layout responds to the viewport (`SidebarLeft`) needs to override it —
 * every other story sizes its own stage. */
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

/** Opens `story` in the harness and returns its stage element. Components that
 * portal out of the stage (a modal, a context menu) are shot through their own
 * locator instead. */
export async function openStory(
  page: Page,
  story: string,
  colorScheme: ColorScheme,
  viewport = DEFAULT_VIEWPORT,
) {
  await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
  await page.setViewportSize(viewport);
  await page.goto(`/harness.html?story=${encodeURIComponent(story)}`);
  await page.evaluate(() => document.fonts.ready);
  return page.getByTestId("story");
}

/** Where a story's baseline lives: `<theme>/<story>.png`, which
 * `snapshotPathTemplate` roots under `__screenshots__/`. */
export function snapshot(story: string, colorScheme: ColorScheme): string[] {
  return [colorScheme, ...`${story}.png`.split("/")];
}
