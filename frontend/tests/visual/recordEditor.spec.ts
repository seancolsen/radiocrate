import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "./fixtures";
import type { AppStore } from "../../src/state/store";

// The record-editor entry path: right-click a result row → a DOM context menu
// offering one "Edit {table}" per table whose primary key the row carries → the
// record editor opens as a sidebar inside the query page.
//
// The rows are canvas pixels, so the menu and the sidebar are the only parts a
// locator can see; the row underneath is addressed by coordinates (rows start at
// the canvas's top edge, ~40px tall).

/** The store the app exposes under `?expose=1`. */
interface AppWindow {
  __appStore: AppStore;
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

/** The seeded grid, with rows carrying both a `track` and an `album` key. */
const SEEDED = "/?tabs=Lemonade&grid=lemonade&records=track,album&expose=1";

async function openGrid(page: Page, url = SEEDED) {
  await mockRpc(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
}

/** Right-clicks a row of the results canvas (row 0 unless told otherwise). */
async function rightClickRow(page: Page, y = 20) {
  await page
    .locator("canvas")
    .click({ button: "right", position: { x: 200, y } });
}

/** The record-editor sidebar (the explorer is an `<aside>` too — match on the
 * accessible name). */
const editorPanel = (page: Page) =>
  page.getByRole("complementary", { name: /^Edit / });

const selection = (page: Page) =>
  page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    return [...store.rowSelection(store.state.activeTabId!)];
  });

test("a row's context menu offers one entry per table it identifies", async ({
  page,
}) => {
  await openGrid(page);
  await rightClickRow(page);

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Edit track",
    "Edit album",
  ]);
  // Right-clicking a row also selects it, so the menu's target is visible.
  expect(await selection(page)).toEqual([0]);
});

test("rows with no primary key offer no menu", async ({ page }) => {
  // Same grid, without the `records=` lineage stand-in.
  await openGrid(page, "/?tabs=Lemonade&grid=lemonade&expose=1");
  await rightClickRow(page);
  await expect(page.getByRole("menu")).toBeHidden();
});

test("choosing an entry opens the record editor on that record", async ({
  page,
}) => {
  await openGrid(page);
  await rightClickRow(page, 60); // row 1
  await page.getByRole("menuitem", { name: "Edit album" }).click();

  const editor = editorPanel(page);
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("heading")).toHaveText("Edit album");
  // The seeded key value for row 1 (`?records=` numbers rows from 1).
  await expect(editor).toContainText("album-2");
  // Choosing an entry dismisses the menu.
  await expect(page.getByRole("menu")).toBeHidden();
});

test("the editor sidebar narrows the results, not the tab bar", async ({
  page,
}) => {
  await openGrid(page);
  const canvasWidth = async () =>
    (await page.locator("canvas").boundingBox())!.width;
  const tabBarWidth = async () =>
    (await page.getByTestId("tab-bar").boundingBox())!.width;

  const before = await canvasWidth();
  const tabsBefore = await tabBarWidth();
  await rightClickRow(page);
  await page.getByRole("menuitem", { name: "Edit track" }).click();
  await expect(editorPanel(page)).toBeVisible();

  const width = await page.evaluate(() =>
    (window as unknown as AppWindow).__appStore.recordSidebarWidth(),
  );
  expect(await canvasWidth()).toBeCloseTo(before - width, 0);
  // The tab bar spans the app frame, outside the query page, and keeps its width.
  expect(await tabBarWidth()).toBe(tabsBefore);
});

test("the menu blocks the rows beneath it", async ({ page }) => {
  await openGrid(page);
  // A 400×30 strip of canvas covering a row well below the menu's anchor.
  const strip = () =>
    page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const dpr = window.devicePixelRatio || 1;
      const ctx = canvas.getContext("2d")!;
      const d = ctx.getImageData(0, 88 * dpr, 400 * dpr, 30 * dpr).data;
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum = (sum * 31 + d[i]) >>> 0;
      return sum;
    });

  await rightClickRow(page); // selects row 0, opens the menu
  expect(await selection(page)).toEqual([0]);
  const blocked = await strip();

  // Hovering a row while the menu is up leaves it unpainted — no hover state.
  await page.mouse.move(300, 100);
  await page.waitForTimeout(50);
  expect(await strip()).toBe(blocked);

  // Clicking that row only dismisses the menu: the blocking layer swallows the
  // click, so the row underneath is never selected.
  await page.mouse.click(300, 100);
  await expect(page.getByRole("menu")).toBeHidden();
  expect(await selection(page)).toEqual([0]);

  // With the menu gone the same hover *does* repaint — so the check above was
  // watching something real. (Wheel scrolling is gated by the same freeze.)
  await page.mouse.move(0, 300);
  await page.mouse.move(300, 100);
  await expect.poll(strip).not.toBe(blocked);
});

test("Escape closes the menu; the close button closes the editor", async ({
  page,
}) => {
  await openGrid(page);
  await rightClickRow(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await rightClickRow(page);
  await page.getByRole("menuitem", { name: "Edit track" }).click();
  const editor = editorPanel(page);
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Close record editor" }).click();
  await expect(editor).toBeHidden();
});

test("the sidebar is resizable, and its width persists", async ({ page }) => {
  await openGrid(page);
  await rightClickRow(page);
  await page.getByRole("menuitem", { name: "Edit track" }).click();
  const editor = editorPanel(page);
  await expect(editor).toBeVisible();
  const before = (await editor.boundingBox())!;

  // Drag the divider 120px to the left — the sidebar grows by that much.
  const divider = page.getByRole("separator", { name: "Resize record editor" });
  const grip = (await divider.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 120, grip.y + 200, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await editor.boundingBox())!.width)
    .toBeCloseTo(before.width + 120, 0);

  // The released width is what a reload restores (it lives in localStorage).
  const stored = await page.evaluate(() =>
    localStorage.getItem("recordSidebarWidth"),
  );
  expect(Number(stored)).toBeCloseTo(before.width + 120, 0);
  await page.reload();
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as AppWindow).__appStore.recordSidebarWidth(),
    ),
  ).toBeCloseTo(before.width + 120, 0);
});

// Screenshots: the menu over the rows, and the editor sidebar open beside them.
for (const colorScheme of ["light", "dark"] as const) {
  test(`row context menu - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SEEDED);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await rightClickRow(page);
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page).toHaveScreenshot(`record-menu-${colorScheme}.png`, {
      fullPage: true,
    });
  });

  test(`record editor sidebar - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SEEDED);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await rightClickRow(page);
    await page.getByRole("menuitem", { name: "Edit track" }).click();
    await expect(editorPanel(page)).toBeVisible();
    await expect(page).toHaveScreenshot(`record-editor-${colorScheme}.png`, {
      fullPage: true,
    });
  });
}
