import { test, expect, type Page } from "@playwright/test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import { PLAYLIST_SOURCE, SOURCES_FIXTURE } from "../../src/dev/fixtures";
import type { AppStoreFacade } from "../../src/dev/seed";

// Dragging result rows onto a playlist in the explorer, with a mouse. The drag
// runs between components — the canvas grid picks the rows up, the explorer's
// tree outlines the playlist under the pointer, and the drop writes through
// the playlist's write queue — so it's driven through the assembled app
// (`?expose=1`). What the outlined playlist looks like is the
// `explorer/tracks-drop` snapshot. Touch can't be driven here: the device
// checks in the playlists spec's Manual QA cover it.
//
// The rows are canvas pixels, so they're addressed by coordinates and the
// selection and the drag are read back through the exposed store.

interface AppWindow {
  __appStore: AppStoreFacade;
}

/** Each `dml` request the page sent, as its inserts' `track@position`. */
type Sent = string[][];

/** Answers the app's requests, with the "Road Trip" playlist in the source
 * list, and records every `dml` request. The playlist's greatest position is
 * 2, so tracks added to it start at 3. */
async function mockBackend(page: Page): Promise<Sent> {
  const sent: Sent = [];
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
      params?: {
        operations: {
          operation: string;
          values?: Record<string, unknown>;
        }[];
      };
    };
    if (body.method === "dml") {
      sent.push(
        (body.params?.operations ?? []).map(
          (op) => `${String(op.values?.track)}@${String(op.values?.position)}`,
        ),
      );
    }
    const result =
      body.method === "source.list"
        ? [...SOURCES_FIXTURE, PLAYLIST_SOURCE]
        : body.method === "preset.list"
          ? []
          : body.method === "dml"
            ? {}
            : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
  const maxPosition = tableToIPC(
    tableFromArrays({ max: Float64Array.of(2) }),
    "stream",
  );
  await page.route("**/api/query", (route) =>
    route.request().postData()?.includes("max(position)")
      ? route.fulfill({
          status: 200,
          contentType: "application/vnd.apache.arrow.stream",
          body: Buffer.from(maxPosition),
        })
      : route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
  return sent;
}

/** The seeded five-row grid, its rows holding tracks t1…t5, beside the open
 * explorer. */
const SEEDED =
  "/?sidebar=open&tabs=Lemonade&grid=lemonade&tracks=t1,t2,t3,t4,t5&expose=1";

async function openGrid(page: Page, url = SEEDED): Promise<Sent> {
  const sent = await mockBackend(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
  return sent;
}

/** A viewport point inside the nth seeded row (rows are ~36px tall). */
async function rowPoint(page: Page, index: number) {
  const box = (await page.locator("canvas").boundingBox())!;
  return { x: box.x + 200, y: box.y + index * 36 + 18 };
}

const playlistRow = (page: Page) =>
  page
    .getByRole("tree", { name: "Sources" })
    .getByRole("treeitem", { name: "Road Trip", exact: true });

/** Presses on row `from` and moves the mouse over the "Road Trip" playlist,
 * leaving the button down. */
async function dragToPlaylist(page: Page, from: number) {
  const a = await rowPoint(page, from);
  const b = (await playlistRow(page).boundingBox())!;
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
}

const selection = (page: Page) =>
  page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    return [...store.rowSelection(store.state.activeTabId!)].sort(
      (a, b) => a - b,
    );
  });

const dropTarget = (page: Page) =>
  page.evaluate(
    () => (window as unknown as AppWindow).__appStore.state.rowDrag?.over,
  );

/** Selects rows 1–3 (t2…t4). */
async function selectMiddle(page: Page) {
  const first = await rowPoint(page, 1);
  const last = await rowPoint(page, 3);
  await page.mouse.click(first.x, first.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(last.x, last.y);
  await page.keyboard.up("Shift");
  expect(await selection(page)).toEqual([1, 2, 3]);
}

test("dropping the selected rows on a playlist adds their tracks to its end", async ({
  page,
}) => {
  const sent = await openGrid(page);
  await selectMiddle(page);

  await dragToPlaylist(page, 2);
  await expect(page.getByText("3 tracks", { exact: true })).toBeVisible();
  expect(await dropTarget(page)).toBe(PLAYLIST_SOURCE.id);
  await expect(playlistRow(page)).toHaveClass(/ring-2/);

  await page.mouse.up();
  await expect.poll(() => sent).toEqual([["t2@3", "t3@4", "t4@5"]]);
  await expect(page.getByText("3 tracks", { exact: true })).toBeHidden();
  await expect(playlistRow(page)).not.toHaveClass(/ring-2/);
  // The drop wasn't a click on anything: the rows stay selected, and the
  // playlist didn't open.
  expect(await selection(page)).toEqual([1, 2, 3]);
  await expect(page.getByRole("tab", { name: /Road Trip/ })).toHaveCount(0);
});

test("a row outside the selection is dragged alone", async ({ page }) => {
  const sent = await openGrid(page);
  await selectMiddle(page);
  await dragToPlaylist(page, 4);
  expect(await selection(page)).toEqual([4]);
  await expect(page.getByText("1 track", { exact: true })).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => sent).toEqual([["t5@3"]]);
});

test("only a playlist takes the rows", async ({ page }) => {
  const sent = await openGrid(page);
  const a = await rowPoint(page, 0);
  const query = (await page
    .getByRole("tree", { name: "Sources" })
    .getByRole("treeitem", { name: "Deep Cuts", exact: true })
    .boundingBox())!;
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(query.x + 40, query.y + query.height / 2, {
    steps: 10,
  });
  await expect(page.getByText("1 track", { exact: true })).toBeVisible();
  expect(await dropTarget(page)).toBeNull();
  await page.mouse.up();

  // Let go over the rows, the drag isn't a click on the row under the
  // release either.
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const b = await rowPoint(page, 3);
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  expect(await selection(page)).toEqual([0]);
  expect(sent).toEqual([]);
});

test("Escape puts the rows down without adding them", async ({ page }) => {
  const sent = await openGrid(page);
  await dragToPlaylist(page, 1);
  expect(await dropTarget(page)).toBe(PLAYLIST_SOURCE.id);
  await page.keyboard.press("Escape");
  await expect(page.getByText("1 track", { exact: true })).toBeHidden();
  await page.mouse.up();
  // The release wasn't a click on the row under it either.
  expect(await selection(page)).toEqual([1]);
  // Give a stray write the chance to show up.
  await page.waitForTimeout(200);
  expect(sent).toEqual([]);
});

test("rows that aren't tracks don't drag", async ({ page }) => {
  const sent = await openGrid(
    page,
    "/?sidebar=open&tabs=Lemonade&grid=lemonade&expose=1",
  );
  await dragToPlaylist(page, 1);
  expect(
    await page.evaluate(
      () => (window as unknown as AppWindow).__appStore.state.rowDrag,
    ),
  ).toBeNull();
  await page.mouse.up();
  expect(sent).toEqual([]);
});
