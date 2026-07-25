import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "./fixtures";

/** Intercept the RPC route so tests never hit a backend; fulfill `query.list`
 * and `preset.list` from fixtures (empty presets are fine — the grid snapshot
 * injects a canned structured result and never compiles). */
async function mockRpc(page: Page) {
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result =
      body.method === "query.list"
        ? QUERIES_FIXTURE
        : body.method === "preset.list"
          ? []
          : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
  // The grid snapshot seeds a canned result via `?grid=` and never runs a real
  // query, but a viewed tab still fires the introspection SQL at `/api/query`.
  // Stub it out (empty body) so nothing hangs or errors visibly.
  await page.route("**/api/query", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
}

for (const colorScheme of ["light", "dark"] as const) {
  // The app frame with no tabs open and the sidebar closed.
  test(`frame empty - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`frame-empty-${colorScheme}.png`, {
      fullPage: true,
    });
  });

  // The app frame: sidebar open, two tabs open (the first active). Tab content
  // is blank (out of scope) — this is the DOM analog of whole_app.png's frame.
  test(`frame populated - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?sidebar=open&tabs=Lemonade,Deep%20Cuts");
    await page.evaluate(() => document.fonts.ready);
    // Wait for the seeded tabs to appear before snapshotting.
    await expect(
      page.getByRole("button", { name: "Close Deep Cuts" }).first(),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(`frame-populated-${colorScheme}.png`, {
      fullPage: true,
    });
  });

  // Narrow viewport (< PERSISTENT_ORGANIZER_MIN_WIDTH): the sidebar is a modal
  // drawer overlaying the content with a dimming scrim (§7).
  test(`frame drawer - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?sidebar=open&tabs=Lemonade,Deep%20Cuts");
    await page.evaluate(() => document.fonts.ready);
    await expect(
      page.getByRole("button", { name: "Close Deep Cuts" }).first(),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(`frame-drawer-${colorScheme}.png`, {
      fullPage: true,
    });
  });

  // The query page: the refresh-only toolbar over the columnar results grid. A
  // small canned structured result is seeded via `?grid=lemonade` (the five
  // Lemonade rows) so the grid's columns, artist pills, per-column fonts/colors/
  // alignment, formatters, and separators are captured without a backend. The
  // grid is painted to a <canvas>, so the rows aren't queryable DOM — wait on the
  // engine's readiness marker (`data-rows`) instead of the row text.
  test(`query grid - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?sidebar=open&tabs=Lemonade&grid=lemonade");
    await page.evaluate(() => document.fonts.ready);
    // Wait for the canvas grid to have painted the seeded rows before snapshotting.
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(page).toHaveScreenshot(`query-grid-${colorScheme}.png`, {
      fullPage: true,
    });
  });

  // The now-playing bar under the results grid: title + artists on the left,
  // play/pause and the overflow menu on the right, progress timeline across the
  // bottom. Seeded (`?playing=`) so no audio element or stream request is
  // involved and the progress is frozen at a fixed fraction.
  test(`now playing - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(
      "/?sidebar=open&tabs=Lemonade&grid=lemonade" +
        "&playing=Uncatena|Sylvan%20Esso,Nick%20Sanborn",
    );
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByTestId("now-playing")).toBeVisible();
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(page).toHaveScreenshot(`now-playing-${colorScheme}.png`, {
      fullPage: true,
    });
  });

  // The same bar with its overflow menu open — it must open *upward* (the bar is
  // the bottom edge of the app) and carry Next / Close / Locate.
  test(`now playing menu - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(
      "/?sidebar=open&tabs=Lemonade&grid=lemonade&playing=Uncatena|Sylvan%20Esso",
    );
    await page.evaluate(() => document.fonts.ready);
    await page
      .getByTestId("now-playing")
      .getByRole("button", { name: "Playback actions" })
      .click();
    await expect(page.getByRole("menuitem", { name: "Locate" })).toBeVisible();
    await expect(page).toHaveScreenshot(`now-playing-menu-${colorScheme}.png`, {
      fullPage: true,
    });
  });
}
