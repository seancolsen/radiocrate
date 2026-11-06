import { test, expect, type Locator, type Page } from "@playwright/test";
import { SOURCES_FIXTURE } from "../../src/dev/fixtures";
import { SCHEMES, openStory, snapshot } from "./harness";

// How the two sidebars behave in the assembled app, and under a real touch
// (CDP's touch events go through the browser's gesture recognition, so a pan
// scrolls and cancels the pointer as it would on a phone): the explorer's drawer
// swiping closed, both panels resizing, and what the explorer's layout decides.
// What they look like is `shell.spec.ts`'s.

test.use({ hasTouch: true });

const PHONE = { width: 390, height: 844 };

async function mockRpc(page: Page) {
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result =
      body.method === "source.list"
        ? SOURCES_FIXTURE
        : body.method === "preset.list" || body.method === "keybinding.list"
          ? []
          : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
    });
  });
}

async function openApp(
  page: Page,
  viewport = PHONE,
  query = "sidebar=open&tabs=Lemonade&grid=lemonade&expose=1",
) {
  await mockRpc(page);
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
}

const explorer = (page: Page) =>
  page.getByRole("complementary", { name: "Explorer" });

/** The explorer's left edge on screen, in px: 0 when it's open. */
async function explorerLeft(page: Page): Promise<number> {
  return (await explorer(page).boundingBox())!.x;
}

/** A finger on the page. Each move is one touch event, sent as it's asked for,
 * so a swipe's speed is decided by how long a test waits between them. */
async function finger(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (
    type: "touchStart" | "touchMove" | "touchEnd",
    x?: number,
    y?: number,
  ) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: x === undefined ? [] : [{ x, y: y! }],
    });
  return {
    down: (x: number, y: number) => send("touchStart", x, y),
    move: (x: number, y: number) => send("touchMove", x, y),
    up: () => send("touchEnd"),
    /** Moves in `steps` even strides, `pause` ms apart. */
    async glide(
      from: { x: number; y: number },
      to: { x: number; y: number },
      steps: number,
      pause = 0,
    ) {
      for (let i = 1; i <= steps; i++) {
        await send(
          "touchMove",
          from.x + ((to.x - from.x) * i) / steps,
          from.y + ((to.y - from.y) * i) / steps,
        );
        if (pause > 0) await page.waitForTimeout(pause);
      }
    },
  };
}

/** A slow swipe: moves `dx` from (x, y), then rests long enough for its speed
 * to have died away, leaving the finger down. */
async function dragAndRest(page: Page, x: number, y: number, dx: number) {
  const f = await finger(page);
  await f.down(x, y);
  await f.glide({ x, y }, { x: x + dx, y }, 10, 20);
  await page.waitForTimeout(150);
  return f;
}

test.describe("swiping the explorer's drawer", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await expect(explorer(page)).toBeVisible();
  });

  test("follows the finger, px for px, once it has moved a little", async ({
    page,
  }) => {
    const f = await finger(page);
    await f.down(150, 300);
    // Too little to say what this touch is: nothing moves.
    await f.move(147, 300);
    expect(await explorerLeft(page)).toBe(0);
    // Enough: it's a swipe, measured from here, so the drawer doesn't jump.
    await f.move(140, 300);
    expect(await explorerLeft(page)).toBe(0);
    await f.move(100, 300);
    await expect.poll(() => explorerLeft(page)).toBeCloseTo(-40, 0);
    await f.move(120, 300);
    await expect.poll(() => explorerLeft(page)).toBeCloseTo(-20, 0);
    // A finger run past open moves it again the moment it turns back.
    await f.move(180, 300);
    await expect.poll(() => explorerLeft(page)).toBeCloseTo(0, 0);
    await f.move(170, 300);
    await expect.poll(() => explorerLeft(page)).toBeCloseTo(-10, 0);
    await f.up();
  });

  test("closes when dragged far enough, even from near its edge", async ({
    page,
  }) => {
    const f = await dragAndRest(page, 190, 300, -120);
    await f.up();
    await expect(explorer(page)).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("sidebarOpen"))).toBe(
      "false",
    );
  });

  test("springs back when it isn't", async ({ page }) => {
    const f = await dragAndRest(page, 180, 300, -50);
    expect(await explorerLeft(page)).toBeLessThan(0);
    await f.up();
    await expect.poll(() => explorerLeft(page)).toBe(0);
    await expect(explorer(page)).toBeVisible();
  });

  test("closes on a flick, however short", async ({ page }) => {
    const f = await finger(page);
    await f.down(150, 300);
    await f.glide({ x: 150, y: 300 }, { x: 110, y: 300 }, 4);
    await f.up();
    await expect(explorer(page)).toBeHidden();
  });

  test("works from anywhere: the scrim as well as the panel", async ({
    page,
  }) => {
    const f = await dragAndRest(page, 350, 300, -150);
    expect(await explorerLeft(page)).toBeLessThan(0);
    await f.up();
    await expect(explorer(page)).toBeHidden();
  });

  test("a short swipe on the scrim isn't a tap on it", async ({ page }) => {
    const f = await dragAndRest(page, 350, 300, -40);
    await f.up();
    await expect.poll(() => explorerLeft(page)).toBe(0);
    await page.waitForTimeout(100);
    await expect(explorer(page)).toBeVisible();
  });

  test("a tap on the scrim closes it", async ({ page }) => {
    await page.touchscreen.tap(350, 300);
    await expect(explorer(page)).toBeHidden();
  });

  test("a swipe on a menu raised from the panel isn't one", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Source list actions" }).click();
    const item = page.getByRole("menuitem", { name: "Refresh" });
    const box = (await item.boundingBox())!;
    const f = await finger(page);
    const y = box.y + box.height / 2;
    await f.down(box.x + box.width - 4, y);
    await f.glide(
      { x: box.x + box.width - 4, y },
      { x: box.x + box.width - 80, y },
      6,
    );
    expect(await explorerLeft(page)).toBe(0);
    await f.up();
  });
});

test("a vertical swipe scrolls the drawer, and stays a scroll", async ({
  page,
}) => {
  // Short enough for the list to overflow.
  await openApp(page, { width: 390, height: 200 });
  const scroller = explorer(page).locator(".overflow-y-auto");
  await expect(explorer(page)).toBeVisible();
  const range = await scroller.evaluate(
    (el) => el.scrollHeight - el.clientHeight,
  );
  expect(range).toBeGreaterThan(20);

  const f = await finger(page);
  await f.down(100, 120);
  await f.glide({ x: 100, y: 120 }, { x: 100, y: 60 }, 8, 16);
  // It's a scroll now: going sideways from here doesn't pull the drawer along.
  await f.glide({ x: 100, y: 60 }, { x: 10, y: 60 }, 8, 16);
  expect(await explorerLeft(page)).toBe(0);
  await f.up();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.waitForTimeout(100);
  await expect(explorer(page)).toBeVisible();
});

test("a touch that picks a tree row up isn't a swipe", async ({ page }) => {
  await openApp(page);
  const row = page.getByRole("treeitem", { name: "Deep Cuts" });
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const f = await finger(page);
  await f.down(120, y);
  await page.waitForTimeout(700);
  await f.glide({ x: 120, y }, { x: 40, y }, 6, 16);
  expect(await explorerLeft(page)).toBe(0);
  await f.up();
  await expect(explorer(page)).toBeVisible();
});

test.describe("the explorer's layout", () => {
  test("a drawer lists the open tabs, and clicking a source closes it", async ({
    page,
  }) => {
    await openApp(page);
    await expect(page.getByRole("heading", { name: "Opened" })).toBeVisible();
    await page.getByRole("treeitem", { name: "Deep Cuts" }).click();
    await expect(explorer(page)).toBeHidden();
    await expect(
      page.locator("[data-tab-id]").filter({ hasText: "Deep Cuts" }),
    ).toBeVisible();
    // Reachable no more: nothing in a closed drawer takes the keyboard.
    await expect(
      page.getByRole("treeitem", { name: "Deep Cuts" }),
    ).toBeHidden();
  });

  test("a persistent column leaves both to the tab bar", async ({ page }) => {
    await openApp(page, { width: 1280, height: 800 });
    await expect(explorer(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Opened" })).toHaveCount(0);
    await page.getByRole("treeitem", { name: "Deep Cuts" }).click();
    await expect(
      page.locator("[data-tab-id]").filter({ hasText: "Deep Cuts" }),
    ).toBeVisible();
    await expect(explorer(page)).toBeVisible();
  });

  test("the footer opens the command palette", async ({ page }) => {
    await openApp(page, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "Command palette" }).click();
    await expect(page.getByRole("combobox")).toBeFocused();
    await expect(explorer(page)).toBeVisible();
  });

  test("in a drawer, it also gets the drawer out of the way", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Command palette" }).click();
    await expect(page.getByRole("combobox")).toBeFocused();
    await expect(explorer(page)).toBeHidden();
  });

  test("crossing between the layouts keeps the page mounted", async ({
    page,
  }) => {
    await openApp(page);
    await page.locator("canvas").evaluate((el) => {
      (el as HTMLElement & { marked?: boolean }).marked = true;
    });
    await page.setViewportSize({ width: 800, height: 400 });
    await expect(page.getByRole("heading", { name: "Opened" })).toHaveCount(0);
    expect(
      await page
        .locator("canvas")
        .evaluate((el) => (el as HTMLElement & { marked?: boolean }).marked),
    ).toBe(true);
  });
});

test.describe("resizing by mouse and keyboard", () => {
  test.use({ hasTouch: false });

  async function dragHandleBy(page: Page, handle: Locator, dx: number) {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 300;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
  }

  test("the explorer: by mouse, remembered across a reload", async ({
    page,
  }) => {
    await openApp(page, { width: 1280, height: 800 });
    const handle = page.getByRole("separator", { name: "Resize explorer" });
    await dragHandleBy(page, handle, 90);
    await expect
      .poll(async () => (await explorer(page).boundingBox())!.width)
      .toBeCloseTo(290, 0);
    expect(
      Number(await page.evaluate(() => localStorage.getItem("explorerWidth"))),
    ).toBeCloseTo(290, 0);
    await page.reload();
    await expect
      .poll(async () => (await explorer(page).boundingBox())!.width)
      .toBeCloseTo(290, 0);
  });

  test("the explorer: never squeezes the main column away", async ({
    page,
  }) => {
    await openApp(page, { width: 700, height: 800 });
    const handle = page.getByRole("separator", { name: "Resize explorer" });
    await dragHandleBy(page, handle, 600);
    await expect
      .poll(async () => (await explorer(page).boundingBox())!.width)
      .toBeCloseTo(460, 0);
  });

  test("the explorer: by keyboard", async ({ page }) => {
    await openApp(page, { width: 1280, height: 800 });
    const handle = page.getByRole("separator", { name: "Resize explorer" });
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => (await explorer(page).boundingBox())!.width)
      .toBeCloseTo(216, 0);
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(async () => (await explorer(page).boundingBox())!.width)
      .toBeCloseTo(200, 0);
  });
});

test.describe("resizing by touch", () => {
  /** Where a finger takes hold of the grip. */
  async function grip(page: Page, name: string) {
    const box = (await page.getByRole("separator", { name }).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  test("the drawer: follows a touch all the way, without closing", async ({
    page,
  }) => {
    await openApp(page);
    const { x, y } = await grip(page, "Resize explorer");
    const f = await finger(page);
    await f.down(x, y);
    // Sideways and out, then back in past where it began.
    await f.glide({ x, y }, { x: x + 100, y }, 10, 16);
    await expect
      .poll(async () => (await explorer(page).boundingBox())!.width)
      .toBeCloseTo(300, 0);
    await f.glide({ x: x + 100, y }, { x: x - 30, y }, 10);
    await f.up();
    await expect
      .poll(async () => (await explorer(page).boundingBox())!.width)
      .toBeCloseTo(170, 0);
    expect(await explorerLeft(page)).toBe(0);
    await expect(explorer(page)).toBeVisible();
  });

  test("the drawer: leaves a sliver of scrim to tap", async ({ page }) => {
    await openApp(page);
    const { x, y } = await grip(page, "Resize explorer");
    const f = await finger(page);
    await f.down(x, y);
    await f.glide({ x, y }, { x: x + 300, y }, 10);
    await f.up();
    await expect
      .poll(async () => (await explorer(page).boundingBox())!.width)
      .toBeCloseTo(342, 0);
  });

  test("the record editor: follows a touch all the way on a phone", async ({
    page,
  }) => {
    await openApp(
      page,
      PHONE,
      "tabs=Lemonade&grid=lemonade&records=track&recordFixture=1&expose=1",
    );
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await page.mouse.click(120, 100, { button: "right" });
    await page.getByRole("menuitem", { name: "Edit track" }).click();
    const editor = page.getByRole("complementary", { name: "Edit track" });
    await expect(editor).toBeVisible();

    const before = (await editor.boundingBox())!.width;
    const { x, y } = await grip(page, "Resize record editor");
    const f = await finger(page);
    await f.down(x, y);
    await f.glide({ x, y }, { x: x + 60, y }, 12, 16);
    await f.up();
    await expect
      .poll(async () => (await editor.boundingBox())!.width)
      .toBeCloseTo(before - 60, 0);
    expect(
      Number(
        await page.evaluate(() => localStorage.getItem("recordSidebarWidth")),
      ),
    ).toBeCloseTo(before - 60, 0);
  });
});

// Under a finger, the panel's edge is a grip rather than a strip, and shows.
for (const colorScheme of SCHEMES) {
  test(`sidebar-left/drawer-touch - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "sidebar-left/open-ephemeral",
      colorScheme,
      PHONE,
    );
    await expect(stage).toHaveScreenshot(
      snapshot("sidebar-left/drawer-touch", colorScheme),
    );
  });
}

test.describe("the scrollbar", () => {
  test.use({ hasTouch: false });

  test.beforeEach(async ({ page }) => {
    await openStory(page, "scroll-area/overflowing", "light");
  });

  const scrollTop = (page: Page) =>
    page.getByTestId("scroll-area-scroller").evaluate((el) => el.scrollTop);
  const thumb = (page: Page) => page.getByTestId("scroll-thumb");

  test("takes no room, and shows only while there's scrolling", async ({
    page,
  }) => {
    // No native bar eating into the content's width.
    const scroller = page.getByTestId("scroll-area-scroller");
    expect(
      await scroller.evaluate(
        (el: HTMLElement) => el.offsetWidth - el.clientWidth,
      ),
    ).toBe(0);
    await expect(thumb(page)).toHaveCSS("opacity", "0");

    await scroller.evaluate((el) => el.scrollBy(0, 100));
    await expect(thumb(page)).toHaveCSS("opacity", "1");
    await expect(thumb(page)).toHaveCSS("opacity", "0", { timeout: 3000 });
  });

  test("shows under a moving mouse, and can be dragged", async ({ page }) => {
    const box = (await page.getByTestId("story").boundingBox())!;
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.mouse.move(box.x + 60, box.y + 60);
    await expect(thumb(page)).toHaveCSS("opacity", "1");

    const t = (await thumb(page).boundingBox())!;
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await page.mouse.down();
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2 + 100, {
      steps: 4,
    });
    // Held on to for as long as it's being dragged.
    await page.waitForTimeout(1300);
    await expect(thumb(page)).toHaveCSS("opacity", "1");
    await page.mouse.up();
    expect(await scrollTop(page)).toBeGreaterThan(100);
  });

  test("isn't there at all with nothing to scroll", async ({ page }) => {
    await openStory(page, "explorer/tree", "light");
    await expect(thumb(page)).toBeHidden();
  });
});
