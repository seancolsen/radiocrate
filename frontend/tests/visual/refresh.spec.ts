import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE, PRESETS_FIXTURE } from "../../src/dev/fixtures";
import type { AppStoreFacade } from "../../src/dev/seed";
import type { lemonadeGridResult } from "../../src/dev/gridFixture";

// What survives a result landing under the user, behaviorally: the place they
// had scrolled to and the rows they had selected. Two things move rows —
// switching tabs (one `CanvasGrid` serves them all, so the place in the rows is
// handed over through the store) and re-running the query (a *refresh*, when it
// compiles to the same SQL, lands its rows under the selection and the scroll
// rather than replacing them). Neither is visible to a locator: the rows are
// canvas pixels, so "still in the same place" is asserted by screenshotting the
// canvas and comparing buffers.
//
// The viewport is deliberately short — the seeded grid is five rows, which only
// overflows a small pane, and nothing can be preserved that couldn't scroll in
// the first place (each test checks that its scroll moved the pixels before it
// checks that they came back).

interface AppWindow {
  __appStore: AppStoreFacade;
  __seededResult: typeof lemonadeGridResult;
}

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

/** Opens the seeded grid in a pane too short for its five rows. */
async function openShortGrid(page: Page, url: string) {
  await mockRpc(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1024, height: 200 });
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
  await page.waitForTimeout(100);
}

/** Wheels the results down, and returns the canvas before and after — the
 * caller asserts they differ, which is what proves there was room to scroll.
 *
 * The pointer is taken back off the grid before the second shot: a hovered row
 * is painted lighter than its neighbours, and leaving the pointer on one would
 * put a highlight in the buffer that every later comparison would have to
 * reproduce exactly.  */
async function scrollResults(page: Page) {
  const canvas = page.locator("canvas");
  const top = await canvas.screenshot();
  await canvas.hover({ position: { x: 200, y: 20 } });
  await page.mouse.wheel(0, 120);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(150); // let the fling-free wheel scroll settle
  return { canvas, top, scrolled: await canvas.screenshot() };
}

const tabHandle = (page: Page, name: string) =>
  page.locator("[data-tab-id]").filter({ hasText: name });

const selection = (page: Page) =>
  page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    return [...store.rowSelection(store.state.activeTabId!)];
  });

test("the results come back to where they were when the tab does", async ({
  page,
}) => {
  await openShortGrid(
    page,
    "/?tabs=Lemonade,Deep%20Cuts&grid=lemonade&expose=1",
  );
  const { canvas, top, scrolled } = await scrollResults(page);
  expect(Buffer.compare(top, scrolled)).not.toBe(0);

  // A tab handle is a plain div (its close button is the only role in it), so
  // it's addressed by the id attribute the bar stamps on it, and clicked near
  // its left edge to stay off that button.
  await tabHandle(page, "Deep Cuts").click({ position: { x: 24, y: 12 } });
  await page.waitForTimeout(100);
  await tabHandle(page, "Lemonade").click({ position: { x: 24, y: 12 } });
  await page.waitForTimeout(150);

  // The grid was shown another tab's (empty) rows in between, so this is the
  // offset coming back out of the store, not one that was never disturbed.
  expect(Buffer.compare(await canvas.screenshot(), scrolled)).toBe(0);
});

test("a refresh lands its rows under the scroll position and the selection", async ({
  page,
}) => {
  await openShortGrid(page, "/?tabs=Lemonade&grid=lemonade&expose=1");
  const { canvas, top, scrolled } = await scrollResults(page);
  expect(Buffer.compare(top, scrolled)).not.toBe(0);

  await page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    store.clickRow(store.state.activeTabId!, 1, { shift: false, ctrl: false });
  });
  await page.waitForTimeout(100);
  const withSelection = await canvas.screenshot();

  // The same rows again, as a refresh — what a re-run that compiles to the
  // same SQL hands the page.
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    const { result, lineage } = w.__seededResult();
    w.__appStore.setResults(
      w.__appStore.state.activeTabId!,
      result,
      lineage,
      true,
    );
  });
  await page.waitForTimeout(150);

  expect(await selection(page)).toEqual([1]);
  expect(Buffer.compare(await canvas.screenshot(), withSelection)).toBe(0);
});

test("a new result set puts the results back at the top, without the selection", async ({
  page,
}) => {
  await openShortGrid(page, "/?tabs=Lemonade&grid=lemonade&expose=1");
  const { canvas, top, scrolled } = await scrollResults(page);
  expect(Buffer.compare(top, scrolled)).not.toBe(0);

  await page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    store.clickRow(store.state.activeTabId!, 1, { shift: false, ctrl: false });
  });
  await page.waitForTimeout(100);

  // The same rows, but *not* flagged as a refresh: this is what a query the
  // user has just changed comes back as, and row 3 of the old answer is no
  // place to be standing in the new one.
  await page.evaluate(() => {
    const w = window as unknown as AppWindow;
    const { result, lineage } = w.__seededResult();
    w.__appStore.setResults(w.__appStore.state.activeTabId!, result, lineage);
  });
  await page.waitForTimeout(150);

  expect(await selection(page)).toEqual([]);
  expect(Buffer.compare(await canvas.screenshot(), top)).toBe(0);
});
