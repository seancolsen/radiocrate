import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "./fixtures";

/** Intercept the RPC route so tests never hit a backend; fulfill `query.list`
 * from the fixture. */
async function mockRpc(page: Page) {
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result = body.method === "query.list" ? QUERIES_FIXTURE : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
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
}
