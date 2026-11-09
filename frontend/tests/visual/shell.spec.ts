import { test, expect, type Locator, type Page } from "@playwright/test";
import { SCHEMES, openStory, snapshot } from "./harness";

function tabHandle(page: Page, name: string): Locator {
  return page.locator("[data-tab-id]").filter({ hasText: name });
}

/** The tab bar's handles, left to right, by name. */
async function tabOrder(page: Page): Promise<string[]> {
  return page.locator("[data-tab-id]").allTextContents();
}

/** Presses on `from`'s handle and moves the mouse to `x` (a fraction of its
 * width) across `to`'s, leaving the button down. */
async function dragTab(page: Page, from: string, to: string, x: number) {
  const a = (await tabHandle(page, from).boundingBox())!;
  const b = (await tabHandle(page, to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * x, b.y + b.height / 2, { steps: 8 });
}

// The app's furniture, each piece on its own: the left sidebar in both of its
// layouts, the explorer that fills it, the tab bar, the settings menu with the
// prelude page and rebind dialog it raises,
// the client-update and failed-RPC bars and the About dialog, the now-playing bar
// and its menu,
// and the command palette.

for (const colorScheme of SCHEMES) {
  // Wide enough for a persistent column beside the content.
  test(`sidebar-left/open-persistent - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "sidebar-left/open-persistent",
      colorScheme,
      { width: 1280, height: 800 },
    );
    await expect(stage).toHaveScreenshot(
      snapshot("sidebar-left/open-persistent", colorScheme),
    );
  });

  // Narrower than PERSISTENT_MIN_WIDTH: a modal drawer over the content, behind
  // a dimming scrim.
  test(`sidebar-left/open-ephemeral - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "sidebar-left/open-ephemeral",
      colorScheme,
      { width: 390, height: 844 },
    );
    await expect(stage).toHaveScreenshot(
      snapshot("sidebar-left/open-ephemeral", colorScheme),
    );
  });

  // The explorer's own contents: the "Opened" list (first tab active), the
  // saved-query list under its filter, and the Settings footer.
  test(`explorer/basic - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "explorer/basic", colorScheme, {
      width: 390,
      height: 844,
    });
    await expect(stage.getByText("Workout Mix")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("explorer/basic", colorScheme),
    );
  });

  // A saved query's handle beside a new query's, which has no name yet and
  // reads "new" in gray.
  test(`tab-bar/new-query - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "tab-bar/new-query", colorScheme);
    await expect(stage.getByText("new", { exact: true })).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("tab-bar/new-query", colorScheme),
    );
  });

  // A playlist tab beside a query's: its handle carries the playlist icon.
  test(`tab-bar/playlist - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "tab-bar/playlist", colorScheme);
    await expect(stage.getByText("Road Trip", { exact: true })).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("tab-bar/playlist", colorScheme),
    );
  });

  // The explorer toggle hovered: its label and its shortcut, as keycaps.
  test(`tab-bar/tooltip - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "tab-bar/tooltip", colorScheme);
    await stage.getByRole("button", { name: /explorer$/ }).hover();
    await expect(page.getByTestId("tooltip")).toContainText("Ctrl+B");
    await expect(stage).toHaveScreenshot(
      snapshot("tab-bar/tooltip", colorScheme),
    );
  });

  test(`no-tabs-page/narrow - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "no-tabs-page/narrow", colorScheme);
    await expect(stage).toHaveScreenshot(
      snapshot("no-tabs-page/narrow", colorScheme),
    );
  });

  // The new query dragged over Road Trip's left half: its handle stays where
  // it is, dimmed, and the drop line stands between Lemonade and Road Trip.
  test(`tab-bar/drop-line - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "tab-bar/reorder", colorScheme);
    await dragTab(page, "new", "Road Trip", 0.25);
    await expect(stage).toHaveScreenshot(
      snapshot("tab-bar/drop-line", colorScheme),
    );
  });

  test(`settings/menu - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "settings/menu", colorScheme);
    await expect(
      page.getByRole("menuitem", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("settings/menu", colorScheme),
    );
  });

  test(`menu/columns - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "menu/columns", colorScheme);
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    await expect(stage).toHaveScreenshot(snapshot("menu/columns", colorScheme));
  });

  test(`settings/menu-rescanning - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "settings/menu-rescanning",
      colorScheme,
    );
    await expect(
      page.getByRole("menuitem", { name: "Re-scan collection" }),
    ).toBeDisabled();
    await expect(stage).toHaveScreenshot(
      snapshot("settings/menu-rescanning", colorScheme),
    );
  });

  // The Querydown prelude's page at the default value: Reset to default and
  // Save both disabled.
  test(`settings/prelude - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "settings/prelude", colorScheme);
    await expect(stage.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(stage).toHaveScreenshot(
      snapshot("settings/prelude", colorScheme),
    );
  });

  // The prelude edited and not yet saved: the ✱ on Save.
  test(`settings/prelude-unsaved - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "settings/prelude-unsaved",
      colorScheme,
    );
    await expect(stage.getByRole("button", { name: "Save" })).toBeEnabled();
    await expect(stage.getByTestId("prelude-unsaved")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("settings/prelude-unsaved", colorScheme),
    );
  });

  // The "?" hovered: the help in our own tooltip, not the browser's.
  test(`settings/prelude-help - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "settings/prelude-help", colorScheme);
    await stage.getByRole("button", { name: "Help" }).hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "prepend all queries",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("settings/prelude-help", colorScheme),
    );
  });

  // The prelude holding a prelude that doesn't parse: the problem under the
  // toolbar, and Save disabled.
  test(`settings/prelude-problem - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "settings/prelude-problem",
      colorScheme,
    );
    await expect(stage.getByRole("alert")).toContainText("Unclosed");
    await expect(stage.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(stage).toHaveScreenshot(
      snapshot("settings/prelude-problem", colorScheme),
    );
  });

  // The rebind dialog, holding a chord another command already owns — so the
  // "currently bound to" warning shows too. Shot through the dialog: it renders
  // itself through a portal, outside the stage.
  test(`settings/keyboard-shortcuts/modal-assign - ${colorScheme}`, async ({
    page,
  }) => {
    await openStory(
      page,
      "settings/keyboard-shortcuts/modal-assign",
      colorScheme,
    );
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Currently bound to/)).toBeVisible();
    await expect(dialog).toHaveScreenshot(
      snapshot("settings/keyboard-shortcuts/modal-assign", colorScheme),
    );
  });

  // The client-update bar in both of its notices: the dismissible "ready" one
  // over the persistent "stale" one.
  test(`update/banner - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "update/banner", colorScheme);
    await expect(
      page.getByRole("button", { name: "Reload", exact: true }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("update/banner", colorScheme),
    );
  });

  // The failed-RPC bar: a first failure over a repeated one.
  test(`error/banner - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "error/banner", colorScheme);
    await expect(stage.getByRole("alert")).toHaveCount(2);
    await expect(stage).toHaveScreenshot(snapshot("error/banner", colorScheme));
  });

  // The failed-RPC bar on a phone with an enormous message: bounded, with
  // Dismiss still on screen.
  test(`error/banner-long - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "error/banner-long", colorScheme);
    const bar = stage.getByRole("alert");
    await expect(bar.getByRole("button", { name: "Dismiss" })).toBeInViewport();
    expect((await bar.boundingBox())?.height).toBeLessThan(120);
    await expect(stage).toHaveScreenshot(
      snapshot("error/banner-long", colorScheme),
    );
  });

  // The About dialog on a mismatched pair of build ids, so the "didn't come
  // from the server that's running" verdict shows. Shot through the dialog: it
  // portals out of the stage.
  test(`about/modal - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "about/modal", colorScheme);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/didn’t come from the server/)).toBeVisible();
    await expect(dialog).toHaveScreenshot(snapshot("about/modal", colorScheme));
  });

  // The now-playing bar: the round play/pause button, title + artists with Next
  // and the overflow trigger at the right, and the seek timeline with elapsed and
  // remaining time beneath them.
  test(`now-playing/playing - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "now-playing/playing", colorScheme);
    await expect(page.getByTestId("now-playing")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("now-playing/playing", colorScheme),
    );
  });

  // A track waiting on its first bytes: the spinner ring around the play
  // button, and the downloaded stretch of the timeline.
  test(`now-playing/loading - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "now-playing/loading", colorScheme);
    await expect(page.getByTestId("now-playing")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("now-playing/loading", colorScheme),
    );
  });

  // A track that couldn't be played: the reason in the timeline's place, and
  // Retry on the play button.
  test(`now-playing/error - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "now-playing/error", colorScheme);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("now-playing/error", colorScheme),
    );
  });

  // Its overflow menu on its own — Next / Close / Locate, the last disabled
  // because the seeded track isn't located in any result set.
  test(`now-playing/menu - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "now-playing/menu", colorScheme);
    await expect(page.getByRole("menuitem", { name: "Locate" })).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("now-playing/menu", colorScheme),
    );
  });

  // The same menu with a track queued, which adds "Clear queue".
  test(`now-playing/menu-queued - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "now-playing/menu-queued", colorScheme);
    await expect(
      page.getByRole("menuitem", { name: "Clear queue" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("now-playing/menu-queued", colorScheme),
    );
  });

  // The palette filtered by a typed query, which also drops the non-matching
  // commands. Shot through the dialog (it portals out of the stage).
  test(`command-palette/filtered - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "command-palette/filtered", colorScheme);
    await expect(
      page.getByRole("option", { name: "Tabs: Save active tab" }),
    ).toBeVisible();
    await expect(page.getByTestId("command-palette")).toHaveScreenshot(
      snapshot("command-palette/filtered", colorScheme),
    );
  });
}

test.describe("an icon-only button's tooltip", () => {
  const tooltip = (page: Page) => page.getByTestId("tooltip");

  test("says the button's name and its shortcut, to the eye and to ARIA", async ({
    page,
  }) => {
    const stage = await openStory(page, "tab-bar/tooltip", "light");
    const toggle = stage.getByRole("button", { name: /explorer$/ });
    await expect(toggle).toHaveAttribute("aria-keyshortcuts", "Control+B");
    await toggle.hover();
    await expect(tooltip(page)).toHaveText(
      `${await toggle.getAttribute("aria-label")}Ctrl+B`,
    );
    // Its text is the button's name already, so it's hidden from ARIA.
    await expect(tooltip(page)).toHaveAttribute("aria-hidden", "true");
  });

  test("hides when the button is pressed, and stays hidden", async ({
    page,
  }) => {
    const stage = await openStory(page, "tab-bar/tooltip", "light");
    const newQuery = stage.getByRole("button", { name: "New query" });
    await newQuery.hover();
    await expect(tooltip(page)).toHaveText("New queryCtrl+N");
    await page.mouse.down();
    await expect(tooltip(page)).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(800);
    await expect(tooltip(page)).toHaveCount(0);
  });

  test.describe("under a finger", () => {
    test.use({ hasTouch: true });

    test("shows on touch-and-hold, lingers past the release", async ({
      page,
    }) => {
      const stage = await openStory(page, "tab-bar/tooltip", "light");
      const newQuery = stage.getByRole("button", { name: "New query" });
      const box = (await newQuery.boundingBox())!;
      const touchPoints = [
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      ];
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints,
      });
      await expect(tooltip(page)).toHaveText("New queryCtrl+N");
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.waitForTimeout(300);
      await expect(tooltip(page)).toHaveCount(1);
      await expect(tooltip(page)).toHaveCount(0);
    });

    test("a quick tap shows none", async ({ page }) => {
      const stage = await openStory(page, "tab-bar/tooltip", "light");
      await stage.getByRole("button", { name: "New query" }).tap();
      await page.waitForTimeout(800);
      await expect(tooltip(page)).toHaveCount(0);
    });
  });

  test("shows at once on keyboard focus, and Escape hides it", async ({
    page,
  }) => {
    const stage = await openStory(page, "tab-bar/tooltip", "light");
    await stage.getByRole("button", { name: /explorer$/ }).focus();
    await page.keyboard.press("Tab");
    await expect(tooltip(page)).toContainText("Close Lemonade");
    await page.keyboard.press("Escape");
    await expect(tooltip(page)).toHaveCount(0);
  });
});

test.describe("dragging a tab", () => {
  const dropLine = (page: Page) =>
    page.getByTestId("tab-bar").locator("[aria-hidden=true].bg-accent");

  test.beforeEach(async ({ page }) => {
    await openStory(page, "tab-bar/reorder", "light");
  });

  test("moves it only when it's let go, without selecting it", async ({
    page,
  }) => {
    await dragTab(page, "new", "Lemonade", 0.25);
    await expect(dropLine(page)).toBeVisible();
    expect(await tabOrder(page)).toEqual(["Lemonade", "Road Trip", "new"]);
    await page.mouse.up();
    await expect(dropLine(page)).toHaveCount(0);
    expect(await tabOrder(page)).toEqual(["new", "Lemonade", "Road Trip"]);

    await dragTab(page, "new", "Road Trip", 0.75);
    await page.mouse.up();
    expect(await tabOrder(page)).toEqual(["Lemonade", "Road Trip", "new"]);

    await dragTab(page, "Lemonade", "Road Trip", 0.6);
    await page.mouse.up();
    expect(await tabOrder(page)).toEqual(["Road Trip", "Lemonade", "new"]);
    // The new query was active all along; no drag selected another tab.
    await expect(tabHandle(page, "new").locator(".bg-accent")).toBeVisible();
    await expect(
      tabHandle(page, "Lemonade").locator(".bg-accent"),
    ).toBeHidden();
  });

  test("beside the tab itself shows no line, and drops nothing", async ({
    page,
  }) => {
    await dragTab(page, "Road Trip", "Road Trip", 0.9);
    await expect(dropLine(page)).toHaveCount(0);
    await page.mouse.up();
    expect(await tabOrder(page)).toEqual(["Lemonade", "Road Trip", "new"]);
  });

  test("Escape cancels it", async ({ page }) => {
    await dragTab(page, "Lemonade", "new", 0.75);
    await expect(dropLine(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dropLine(page)).toHaveCount(0);
    await page.mouse.up();
    expect(await tabOrder(page)).toEqual(["Lemonade", "Road Trip", "new"]);
  });
});
