import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "./fixtures";

/** Intercept the RPC route so tests never hit a backend; fulfill `query.list`
 * and `preset.list` from fixtures (empty presets are fine — the results
 * snapshot injects canned text and never compiles). */
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
  // The results snapshot seeds canned text via `?results=` and never runs a real
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

  // The query page: the refresh-only toolbar over the plain-text results pane.
  // Results are seeded via `?results=` (canned text — fields space-joined, rows
  // newline-joined) so the render is exercised without a backend or compile.
  test(`query results - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    const results = [
      "Beyoncé 2016 Lemonade 1 Pray You Catch Me 196 3.5",
      "Beyoncé 2016 Lemonade 2 Hold Up 221 4",
      "Beyoncé,Jack White 2016 Lemonade 3 Don't Hurt Yourself 234 4",
      "Beyoncé 2016 Lemonade 4 Sorry 233 4",
      "Beyoncé,The Weeknd 2016 Lemonade 5 6 Inch 260 4.5",
    ].join("\n");
    await page.goto(
      `/?sidebar=open&tabs=Lemonade&results=${encodeURIComponent(results)}`,
    );
    await page.evaluate(() => document.fonts.ready);
    // Wait for the seeded results to render before snapshotting.
    await expect(page.getByText("Pray You Catch Me")).toBeVisible();
    await expect(page).toHaveScreenshot(`query-results-${colorScheme}.png`, {
      fullPage: true,
    });
  });
}
