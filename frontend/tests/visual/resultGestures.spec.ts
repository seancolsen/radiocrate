import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { SOURCES_FIXTURE } from "../../src/dev/fixtures";
import type { AppStoreFacade } from "../../src/dev/seed";

// What a touch does to the results besides scroll them: swiping a row left to
// edit it, swiping it right to queue its track (which Alt+click does too), and
// pulling down past the top to refresh. The grid is the only part
// that knows these gestures, but what they do lands across the app (the record
// editor opening, a query re-running), so they're driven through the assembled
// app (`?expose=1`). What they look like mid-gesture is the `results/row-swipe`
// and `results/pull-refresh` snapshots in query.spec.ts.
//
// The rows are canvas pixels, so they're addressed by coordinates, and what the
// gesture did is read back through the exposed store.

interface AppWindow {
  __appStore: AppStoreFacade;
}

/** A query with a column only {@link RUNNABLE} selects, so a run of it can be
 * told from whatever else the app asks the backend at boot. */
const DEF = {
  base: "track",
  filter: { custom: "", presets: [] },
  sort: { custom: "" },
  display: { custom: "$title" },
};

/** Answers the app's requests, and counts how many times it runs {@link DEF}. */
async function mockBackend(page: Page): Promise<{ queries: number }> {
  const counts = { queries: 0 };
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result =
      body.method === "source.list"
        ? SOURCES_FIXTURE
        : body.method === "preset.list"
          ? []
          : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
  await page.route("**/api/query", (route) => {
    if (route.request().postData()?.includes(`"track"."title"`)) {
      counts.queries++;
    }
    return route.fulfill({ status: 500, body: "no backend here" });
  });
  return counts;
}

/** The seeded five-row grid, each row carrying a `track` and an `album`, unless
 * the caller wants rows that identify nothing. */
const SEEDED = "/?tabs=Lemonade&grid=lemonade&records=track,album&expose=1";
const IDENTIFYING_NOTHING = "/?tabs=Lemonade&grid=lemonade&expose=1";
/** The seeded grid with a track on every row, row N's being `tN+1`. */
const TRACKS = `${SEEDED}&tracks=t1,t2,t3,t4,t5`;
/** The seeded grid again, on a query that can be run. */
const RUNNABLE = `/?tabs=Lemonade&clean=1&recordFixture=1&grid=lemonade&expose=1&def=${encodeURIComponent(JSON.stringify(DEF))}`;

interface Grid {
  cdp: CDPSession;
  /** The canvas's top-left, in the viewport. */
  x: number;
  y: number;
  width: number;
  counts: { queries: number };
}

async function openGrid(page: Page, url = SEEDED, height = 800): Promise<Grid> {
  const counts = await mockBackend(page);
  await page.setViewportSize({ width: 1280, height });
  await page.goto(url);
  const canvas = page.locator("canvas[data-rows]");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  return { cdp, x: box.x, y: box.y, width: box.width, counts };
}

/** Opens {@link RUNNABLE}, once the run the tab starts itself with is over: what
 * a test counts from there is its own. */
async function openRunnable(page: Page): Promise<Grid> {
  const grid = await openGrid(page, RUNNABLE);
  await expect.poll(() => grid.counts.queries).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const store = (window as unknown as AppWindow).__appStore;
        return store.state.pages[store.state.activeTabId!]?.running;
      }),
    )
    .toBe(false);
  return grid;
}

/** A y inside the nth seeded row (rows are ~36px tall, from the canvas's top). */
const rowY = (index: number) => index * 36 + 18;

const touch = (
  grid: Grid,
  type: "touchStart" | "touchMove" | "touchEnd",
  x?: number,
  y?: number,
) =>
  grid.cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: x === undefined ? [] : [{ x: grid.x + x, y: grid.y + y! }],
  });

/** Moves a touch from one point of the canvas to another in steps, slowly
 * enough that the release that follows isn't a flick, and lets go. */
async function slowDrag(
  page: Page,
  grid: Grid,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await touch(grid, "touchStart", from.x, from.y);
  for (let i = 1; i <= 8; i++) {
    await touch(
      grid,
      "touchMove",
      from.x + ((to.x - from.x) * i) / 8,
      from.y + ((to.y - from.y) * i) / 8,
    );
  }
  // Long enough for the release to look back on no motion at all.
  await page.waitForTimeout(150);
  await touch(grid, "touchEnd");
}

const editor = (page: Page) =>
  page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    const target = store.state.pages[store.state.activeTabId!]?.recordEditor;
    return target
      ? { table: target.table, ids: target.records.map((r) => r.key[0].value) }
      : null;
  });

const selection = (page: Page) =>
  page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    return [...store.rowSelection(store.state.activeTabId!)].sort(
      (a, b) => a - b,
    );
  });

/** The first table the seeded rows identify, and each row's key in it. */
const FIRST_TABLE = "track";
const rowId = (index: number) => `track-${index + 1}`;

test.describe("swiping a row left", () => {
  test("a long swipe edits the row, and selects it", async ({ page }) => {
    const grid = await openGrid(page);
    await slowDrag(
      page,
      grid,
      { x: grid.width - 40, y: rowY(2) },
      { x: grid.width - 240, y: rowY(2) },
    );
    await expect.poll(() => selection(page)).toEqual([2]);
    expect(await editor(page)).toEqual({
      table: FIRST_TABLE,
      ids: [rowId(2)],
    });
  });

  test("a swipe on a row of a selection edits all of it", async ({ page }) => {
    const grid = await openGrid(page);
    await page.evaluate(() => {
      const store = (window as unknown as AppWindow).__appStore;
      const tab = store.state.activeTabId!;
      store.clickRow(tab, 1, { shift: false, ctrl: false });
      store.clickRow(tab, 3, { shift: false, ctrl: true });
    });
    await slowDrag(
      page,
      grid,
      { x: grid.width - 40, y: rowY(3) },
      { x: grid.width - 240, y: rowY(3) },
    );
    await expect.poll(() => editor(page)).not.toBeNull();
    expect(await selection(page)).toEqual([1, 3]);
    expect(await editor(page)).toEqual({
      table: FIRST_TABLE,
      ids: [rowId(1), rowId(3)],
    });
  });

  test("a swipe on a row outside the selection edits that row alone", async ({
    page,
  }) => {
    const grid = await openGrid(page);
    await page.evaluate(() => {
      const store = (window as unknown as AppWindow).__appStore;
      const tab = store.state.activeTabId!;
      store.clickRow(tab, 0, { shift: false, ctrl: false });
      store.clickRow(tab, 1, { shift: false, ctrl: true });
    });
    await slowDrag(
      page,
      grid,
      { x: grid.width - 40, y: rowY(3) },
      { x: grid.width - 240, y: rowY(3) },
    );
    await expect.poll(() => selection(page)).toEqual([3]);
    expect((await editor(page))?.ids).toEqual([rowId(3)]);
  });

  test("a short, slow swipe goes back", async ({ page }) => {
    const grid = await openGrid(page);
    await slowDrag(
      page,
      grid,
      { x: grid.width - 40, y: rowY(2) },
      { x: grid.width - 90, y: rowY(2) },
    );
    await page.waitForTimeout(100);
    expect(await editor(page)).toBeNull();
    expect(await selection(page)).toEqual([]);
  });

  test("a quick flick edits, however short", async ({ page }) => {
    const grid = await openGrid(page);
    const y = rowY(2);
    await touch(grid, "touchStart", 600, y);
    for (const x of [590, 575, 555, 530]) {
      await touch(grid, "touchMove", x, y);
    }
    await touch(grid, "touchEnd");
    await expect.poll(() => editor(page)).not.toBeNull();
  });

  test("a swipe to the right doesn't edit", async ({ page }) => {
    const grid = await openGrid(page);
    await slowDrag(page, grid, { x: 100, y: rowY(2) }, { x: 400, y: rowY(2) });
    await page.waitForTimeout(100);
    expect(await editor(page)).toBeNull();
  });

  test("rows identifying nothing don't swipe", async ({ page }) => {
    const grid = await openGrid(page, IDENTIFYING_NOTHING);
    await slowDrag(
      page,
      grid,
      { x: grid.width - 40, y: rowY(2) },
      { x: grid.width - 240, y: rowY(2) },
    );
    await page.waitForTimeout(100);
    expect(await editor(page)).toBeNull();
    expect(await selection(page)).toEqual([]);
  });
});

/** Alt+clicks the nth seeded row. */
const altClick = (page: Page, row: number) =>
  page
    .locator("canvas[data-rows]")
    .click({ position: { x: 200, y: rowY(row) }, modifiers: ["Alt"] });

const queued = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as AppWindow).__appStore.state.queuedTracks.map(
      (track) => track.id,
    ),
  );

test.describe("swiping a row right", () => {
  test("queues its track, and a second swipe takes it out", async ({
    page,
  }) => {
    const grid = await openGrid(page, TRACKS);
    const swipe = () =>
      slowDrag(page, grid, { x: 40, y: rowY(2) }, { x: 240, y: rowY(2) });
    await swipe();
    await expect.poll(() => queued(page)).toEqual(["t3"]);
    // The selection is left alone.
    expect(await selection(page)).toEqual([]);
    await swipe();
    await expect.poll(() => queued(page)).toEqual([]);
  });

  test("on a row of a selection, queues all of it", async ({ page }) => {
    const grid = await openGrid(page, TRACKS);
    await page.evaluate(() => {
      const store = (window as unknown as AppWindow).__appStore;
      const tab = store.state.activeTabId!;
      store.clickRow(tab, 1, { shift: false, ctrl: false });
      store.clickRow(tab, 3, { shift: false, ctrl: true });
    });
    await slowDrag(page, grid, { x: 40, y: rowY(3) }, { x: 240, y: rowY(3) });
    await expect.poll(() => queued(page)).toEqual(["t2", "t4"]);
  });

  test("a short, slow swipe goes back", async ({ page }) => {
    const grid = await openGrid(page, TRACKS);
    await slowDrag(page, grid, { x: 40, y: rowY(2) }, { x: 90, y: rowY(2) });
    await page.waitForTimeout(100);
    expect(await queued(page)).toEqual([]);
  });

  test("rows that aren't tracks don't swipe right", async ({ page }) => {
    const grid = await openGrid(page);
    await slowDrag(page, grid, { x: 40, y: rowY(2) }, { x: 240, y: rowY(2) });
    await page.waitForTimeout(100);
    expect(await queued(page)).toEqual([]);
  });
});

test.describe("Alt+clicking a row", () => {
  test("queues its track last, or takes it out of the queue", async ({
    page,
  }) => {
    await openGrid(page, TRACKS);
    await altClick(page, 3);
    await altClick(page, 1);
    await expect.poll(() => queued(page)).toEqual(["t4", "t2"]);
    expect(await selection(page)).toEqual([]);
    await altClick(page, 3);
    await expect.poll(() => queued(page)).toEqual(["t2"]);
  });

  test("on a row of a selection, acts on all of it", async ({ page }) => {
    await openGrid(page, TRACKS);
    await page.evaluate(() => {
      const store = (window as unknown as AppWindow).__appStore;
      const tab = store.state.activeTabId!;
      store.clickRow(tab, 0, { shift: false, ctrl: false });
      store.clickRow(tab, 2, { shift: true, ctrl: false });
    });
    await altClick(page, 1);
    await expect.poll(() => queued(page)).toEqual(["t1", "t2", "t3"]);
    expect(await selection(page)).toEqual([0, 1, 2]);
    await altClick(page, 2);
    await expect.poll(() => queued(page)).toEqual([]);
  });
});

test.describe("pulling down past the top", () => {
  test("a long pull refreshes the rows", async ({ page }) => {
    const grid = await openRunnable(page);
    await slowDrag(page, grid, { x: 400, y: 20 }, { x: 400, y: 300 });
    await expect.poll(() => grid.counts.queries).toBe(2);
  });

  test("a short pull doesn't", async ({ page }) => {
    const grid = await openRunnable(page);
    await slowDrag(page, grid, { x: 400, y: 20 }, { x: 400, y: 80 });
    await page.waitForTimeout(150);
    expect(grid.counts.queries).toBe(1);
  });

  test("a pull called off doesn't, however long", async ({ page }) => {
    const grid = await openRunnable(page);
    await touch(grid, "touchStart", 400, 20);
    for (const y of [60, 120, 180, 240, 300]) {
      await touch(grid, "touchMove", 400, y);
    }
    await grid.cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await page.waitForTimeout(150);
    expect(grid.counts.queries).toBe(1);
  });

  test("the rows come home, and answer to where they are", async ({ page }) => {
    const grid = await openGrid(page);
    const canvas = page.locator("canvas[data-rows]");
    await page.waitForTimeout(100);
    const before = await canvas.screenshot();
    await touch(grid, "touchStart", 400, 20);
    for (const y of [40, 60, 80, 100, 120]) {
      await touch(grid, "touchMove", 400, y);
    }
    await page.waitForTimeout(50);
    expect(Buffer.compare(before, await canvas.screenshot())).not.toBe(0);
    await touch(grid, "touchEnd");
    await expect
      .poll(async () => Buffer.compare(before, await canvas.screenshot()))
      .toBe(0);
    // A tap on the first row's place is on the first row again.
    await touch(grid, "touchStart", 400, rowY(0));
    await touch(grid, "touchEnd");
    await expect.poll(() => selection(page)).toEqual([0]);
  });

  test("a pull with no rows at all still refreshes", async ({ page }) => {
    const grid = await openRunnable(page);
    await page.evaluate(() => {
      const w = window as unknown as AppWindow & {
        __emptyResult: (count: number) => unknown;
      };
      const store = w.__appStore;
      store.setResults(store.state.activeTabId!, w.__emptyResult(0) as never);
    });
    await slowDrag(page, grid, { x: 400, y: 20 }, { x: 400, y: 300 });
    await expect.poll(() => grid.counts.queries).toBe(2);
  });
});

test.describe("what a touch is otherwise", () => {
  test("a vertical drag scrolls rows that overflow", async ({ page }) => {
    const grid = await openGrid(page, SEEDED, 200);
    const canvas = page.locator("canvas[data-rows]");
    const before = await canvas.screenshot();
    await touch(grid, "touchStart", 400, 90);
    for (const y of [80, 70, 60, 50, 40]) {
      await touch(grid, "touchMove", 400, y);
    }
    await page.waitForTimeout(150);
    await touch(grid, "touchEnd");
    await page.waitForTimeout(100);
    expect(Buffer.compare(before, await canvas.screenshot())).not.toBe(0);
    expect(await editor(page)).toBeNull();
    expect(grid.counts.queries).toBe(0);
  });

  test("a tap selects its row", async ({ page }) => {
    const grid = await openGrid(page);
    await touch(grid, "touchStart", 400, rowY(1));
    await touch(grid, "touchEnd");
    await expect.poll(() => selection(page)).toEqual([1]);
    expect(await editor(page)).toBeNull();
  });

  test("a touch held and let go raises the row's menu", async ({ page }) => {
    const grid = await openGrid(page);
    await touch(grid, "touchStart", 400, rowY(1));
    await page.waitForTimeout(600);
    await touch(grid, "touchEnd");
    await expect(page.getByRole("menu")).toBeVisible();
  });
});
