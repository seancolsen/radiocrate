import { test, type Page } from "@playwright/test";
import type { Entries } from "../../playwright.config";

// The component harness's side of the visual tests. Every snapshot below the
// app level goes through here: `openStory` puts one component on screen at
// `/harness.html?story=<id>` — no app frame, no backend — and the test shoots
// it. What that component is showing is decided in `src/dev/harness/stories.tsx`,
// so a spec here says only which story, in which theme, and what it waits for.
//
// Until the React port's cutover, each Playwright project names its own entry
// pages (`playwright.config.ts`): the Solid app at `/` and `/harness.html`, the
// React one at `/react.html` and `/react-harness.html`.

export const SCHEMES = ["light", "dark"] as const;
export type ColorScheme = (typeof SCHEMES)[number];

/** The entry pages of the project the current test runs under. */
function entries(): Entries {
  return test.info().project.metadata as Entries;
}

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
  await page.goto(`${entries().harness}?story=${encodeURIComponent(story)}`);
  await page.evaluate(() => document.fonts.ready);
  return page.getByTestId("story");
}

/** The current project's app page, for a root-relative app URL such as
 * `/?tabs=Lemonade`: unchanged under Solid, `/react.html?tabs=Lemonade` under
 * React. */
export function appUrl(url: string): string {
  if (!url.startsWith("/")) throw new Error(`Not a root-relative URL: ${url}`);
  return entries().app + url.slice(1);
}

/** Marks a spec file (or a `describe` block) as running under the Solid app
 * only: every test in scope is skipped for the `react` project. The React port
 * lands a stage at a time, so a surface it hasn't reached yet has nothing to
 * drive — see `specs/2026-09-react-migration/plan.md`.
 *
 * A `beforeEach` hook rather than a file-scope `test.skip(condition, …)`: the
 * condition is the *project*, which is reachable through `test.info()` inside a
 * hook and not from module scope. */
export function solidOnly(reason: string): void {
  test.beforeEach(() => {
    test.skip(test.info().project.name === "react", reason);
  });
}

/** Where a story's baseline lives: `<theme>/<story>.png`, which
 * `snapshotPathTemplate` roots under `__screenshots__/`. */
export function snapshot(story: string, colorScheme: ColorScheme): string[] {
  return [colorScheme, ...`${story}.png`.split("/")];
}
