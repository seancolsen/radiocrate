import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "../../src/dev/fixtures";
import { SCHEMES, snapshot } from "./harness";

// The two snapshots that are about the app as a whole rather than about any one
// component: the frame with nothing open, and a settings page filling a tab.
// Everything else lives in the component harness (see `harness.ts`).

/** Intercept the RPC route so these tests never hit a backend. */
async function mockRpc(page: Page) {
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result = body.method === "query.list" ? QUERIES_FIXTURE : [];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
  // A viewed tab fires the introspection SQL at `/api/query`. Stub it out
  // (empty body) so nothing hangs or errors visibly.
  await page.route("**/api/query", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
}

for (const colorScheme of SCHEMES) {
  // The app frame with no tabs open and the explorer closed.
  test(`app/everything-closed - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(
      snapshot("app/everything-closed", colorScheme),
      { fullPage: true },
    );
  });

  // The keyboard-shortcuts editor filling the only open tab: the whole command
  // table with its bindings, and the tab handle with its keyboard icon. Shot at
  // the app level rather than in the harness — the point is that a settings
  // page is a tab like any other.
  test(`settings/keyboard-shortcuts/list - ${colorScheme}`, async ({
    page,
  }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?shortcuts=1");
    await expect(
      page.getByRole("heading", { name: "Keyboard Shortcuts" }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(
      snapshot("settings/keyboard-shortcuts/list", colorScheme),
      { fullPage: true },
    );
  });
}
