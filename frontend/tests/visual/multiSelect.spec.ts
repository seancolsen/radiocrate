import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "../../src/dev/fixtures";
import type { AppStoreFacade } from "../../src/dev/seed";

// Multi-select mode, behaviorally: the way a touch device builds a multi-row
// selection, which on a desktop is Ctrl+click. The flow is a chain between
// components — the row context menu turns the mode on, the floating toolbar
// reports and ends it, and the canvas grid changes what a plain click means —
// so it's driven through the assembled app (`?expose=1`) rather than the
// component harness. What the toolbar *looks like* is the `results/multi-select`
// snapshot in query.spec.ts.
//
// The rows are canvas pixels, so they're addressed by coordinates and the
// selection is read back through the exposed store.

/** The store the app exposes under `?expose=1`. */
interface AppWindow {
  __appStore: AppStoreFacade;
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
          ? []
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

/** The seeded five-row grid, its rows carrying `track` and `album` keys. */
const SEEDED = "/?tabs=Lemonade&grid=lemonade&records=track,album&expose=1";

async function openGrid(page: Page) {
  await mockRpc(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(SEEDED);
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
}

/** A y inside the nth seeded row (rows are ~36px tall, from the canvas's top). */
const rowY = (index: number) => index * 36 + 18;

const clickRow = (page: Page, index: number) =>
  page.locator("canvas").click({ position: { x: 200, y: rowY(index) } });

const selection = (page: Page) =>
  page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    return [...store.rowSelection(store.state.activeTabId!)].sort(
      (a, b) => a - b,
    );
  });

const toolbar = (page: Page) => page.getByTestId("multi-select-toolbar");

/** Turns the mode on the way a user does: the row's context menu. */
async function enterMultiSelect(page: Page, row = 0) {
  await page
    .locator("canvas")
    .click({ button: "right", position: { x: 200, y: rowY(row) } });
  await page.getByRole("menuitem", { name: "Select multiple" }).click();
  await expect(toolbar(page)).toBeVisible();
}

test("the row menu turns the mode on, and a plain click then toggles rows", async ({
  page,
}) => {
  await openGrid(page);
  await enterMultiSelect(page, 0);
  // The right-click that raised the menu selected its row.
  await expect(toolbar(page)).toContainText("1 record");

  await clickRow(page, 2);
  expect(await selection(page)).toEqual([0, 2]);
  await expect(toolbar(page)).toContainText("2 records");

  await clickRow(page, 4);
  expect(await selection(page)).toEqual([0, 2, 4]);

  // Clicking a selected row takes it back out, rather than collapsing the
  // selection onto it.
  await clickRow(page, 2);
  expect(await selection(page)).toEqual([0, 4]);
  await expect(toolbar(page)).toContainText("2 records");
});

test("closing the toolbar keeps the selection but restores plain clicks", async ({
  page,
}) => {
  await openGrid(page);
  await enterMultiSelect(page, 1);
  await clickRow(page, 3);
  expect(await selection(page)).toEqual([1, 3]);

  await page.getByRole("button", { name: "Exit multi-select" }).click();
  await expect(toolbar(page)).toBeHidden();
  expect(await selection(page)).toEqual([1, 3]);

  // Out of the mode, a plain click selects one row again…
  await clickRow(page, 0);
  expect(await selection(page)).toEqual([0]);
  // …and Ctrl+click still builds a multi-row selection without it.
  await page.locator("canvas").click({
    position: { x: 200, y: rowY(2) },
    modifiers: ["ControlOrMeta"],
  });
  expect(await selection(page)).toEqual([0, 2]);
});

test("the toolbar's actions menu acts on the whole selection", async ({
  page,
}) => {
  await openGrid(page);
  await enterMultiSelect(page, 0);
  await clickRow(page, 1);

  await page.getByRole("button", { name: "Selection actions" }).click();
  const menu = page.getByRole("menu");
  // The row menu's entries, minus the "Select multiple" that's already on.
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Edit track",
    "Edit album",
    "Show album tracks",
    "Rate track",
  ]);

  await menu.getByRole("menuitem", { name: "Edit track" }).click();
  const editor = page.getByRole("complementary", { name: /^Edit / });
  await expect(editor).toBeVisible();
  // Both selected rows' records, edited as one (the bulk case).
  await expect(editor.getByRole("heading")).toHaveText("Edit 2 track records");
});

test("the floating toolbar can be scrolled out of the rows' way", async ({
  page,
}) => {
  await openGrid(page);
  await enterMultiSelect(page, 0);

  const canvas = page.locator("canvas");
  /** A hash of the canvas's top strip — the band the toolbar floats over. */
  const topStrip = () =>
    page.evaluate(() => {
      const el = document.querySelector("canvas")!;
      const dpr = window.devicePixelRatio || 1;
      const d = el
        .getContext("2d")!
        .getImageData(0, 0, 600 * dpr, 40 * dpr).data;
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum = (sum * 31 + d[i]) >>> 0;
      return sum;
    });

  const atTop = await topStrip();
  // Wheeling *up* at the top of the result set now moves the rows down, into
  // the clear below the toolbar, instead of doing nothing.
  await canvas.hover({ position: { x: 200, y: 300 } });
  await page.mouse.wheel(0, -200);
  await expect.poll(topStrip).not.toBe(atTop);

  // The overscroll is bounded: wheeling further changes nothing more.
  const overscrolled = await topStrip();
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(50);
  expect(await topStrip()).toBe(overscrolled);

  // Leaving the mode gives the space back: the rows return to the top.
  await page.getByRole("button", { name: "Exit multi-select" }).click();
  await expect.poll(topStrip).toBe(atTop);
});
