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
  // `QueryResult` is a class (private fields), so the seed seam hands the page
  // a real-instance builder (`__emptyResult`) rather than a bare object literal
  // — see `dev/seed.ts`.
  await page.evaluate(() => {
    const w = window as unknown as {
      __appStore: {
        state: { activeTabId: string | null };
        setResults: (id: string, r: unknown) => void;
      };
      __emptyResult: (rowCount: number) => unknown;
    };
    const id = w.__appStore.state.activeTabId;
    if (id) w.__appStore.setResults(id, w.__emptyResult(0));
  });
  await page.waitForTimeout(100);
  const after = await canvas.screenshot();

  // If the effect never fired (the bug), the canvas would still show the
  // lemonade grid and the two buffers would be identical.
  expect(Buffer.compare(before, after)).not.toBe(0);
});

// The other half of that story: a row re-read after a DML write (a play logged,
// a record saved) rewrites *one row's* cells inside the result the grid already
// holds — deliberately not a new result, so the grid keeps its scroll position
// and the page keeps its selection. Nothing about the result's identity changes,
// which means the effect above can't be what repaints it. This asserts the row
// does repaint, and that the selection it was written under survives.
test("query grid repaints a single rewritten row, keeping the selection", async ({
  page,
}) => {
  await mockRpc(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?tabs=Lemonade&grid=lemonade&expose=1");
  await page.evaluate(() => document.fonts.ready);

  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(100);

  type SeededStore = {
    state: { activeTabId: string | null };
    clickRow: (
      id: string,
      index: number,
      mods: { shift: boolean; ctrl: boolean },
    ) => void;
    rowSelection: (id: string) => ReadonlySet<number>;
    setResultRow: (id: string, index: number, values: unknown[]) => void;
  };
  // Select the row that's about to change, so the repaint has to preserve it.
  await page.evaluate(() => {
    const store = (window as unknown as { __appStore: SeededStore }).__appStore;
    const id = store.state.activeTabId;
    if (id) store.clickRow(id, 1, { shift: false, ctrl: false });
  });
  await page.waitForTimeout(100);
  const before = await canvas.screenshot();

  // Rewrite row 1's cells: one raw value per column, in the fixture's Arrow
  // column order (id, artists, year, album, track number, title, duration,
  // rating) — hidden columns included, matching a real re-read's projection.
  // Display text (the `#` prefix, the `M:SS` duration, the ` ☆` suffix) is
  // derived from these at paint time, not supplied here.
  await page.evaluate(() => {
    const store = (window as unknown as { __appStore: SeededStore }).__appStore;
    const id = store.state.activeTabId;
    if (id)
      store.setResultRow(id, 1, [
        "t2",
        ["Beyoncé", "Ezra Koenig"],
        2016,
        "Lemonade",
        2,
        "Hold Up (refreshed)",
        221, // 3:41
        5, // "5 ☆"
      ]);
  });
  await page.waitForTimeout(100);
  const after = await canvas.screenshot();

  // Without the repaint request the canvas would still show the old row.
  expect(Buffer.compare(before, after)).not.toBe(0);

  // …and the write must not have read as a new result set.
  const selection = await page.evaluate(() => {
    const store = (window as unknown as { __appStore: SeededStore }).__appStore;
    const id = store.state.activeTabId;
    return id ? [...store.rowSelection(id)] : [];
  });
  expect(selection).toEqual([1]);
});
