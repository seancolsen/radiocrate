import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE, PRESETS_FIXTURE } from "./fixtures";

/** Fulfill the RPC route from fixtures (no backend), like the other specs. */
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
          ? PRESETS_FIXTURE
          : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
  await page.route("**/api/query", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
}

// Regression test for the "canvas doesn't refresh when a query reloads" bug:
// Solid shallow-merges an object set at a store leaf, so replacing a tab's
// result mutated it in place without changing the reference the QueryResults
// effect tracks — the grid only repainted when a resize forced a draw. This
// asserts the canvas actually repaints on a result *replace*, with no resize.
test("query grid repaints when the result is replaced (no resize)", async ({
  page,
}) => {
  await mockRpc(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?tabs=Lemonade&grid=lemonade&expose=1");
  await page.evaluate(() => document.fonts.ready);

  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  // Let the initial canned result paint.
  await page.waitForTimeout(100);
  const before = await canvas.screenshot();

  // Replace the active tab's result with a visibly different one (an empty
  // result → the grid's "empty" rendering), WITHOUT resizing the window.
  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __appStore: {
          state: { activeTabId: string | null };
          setResults: (
            id: string,
            r: { rowCount: number; columns: [] },
          ) => void;
        };
      }
    ).__appStore;
    const id = store.state.activeTabId;
    if (id) store.setResults(id, { rowCount: 0, columns: [] });
  });
  await page.waitForTimeout(100);
  const after = await canvas.screenshot();

  // If the effect never fired (the bug), the canvas would still show the
  // lemonade grid and the two buffers would be identical.
  expect(Buffer.compare(before, after)).not.toBe(0);
});
