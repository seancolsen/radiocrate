import { expect, test, type Locator, type Page } from "@playwright/test";
import { openStory } from "./harness";

// The menu system's behavior — hover-driven submenus, the keyboard, and
// staying on screen — against the filler menus of the `menu/*` stories (a root
// of Alpha, Colors ▸, Sizes ▸, Omega, with More ▸ nested in Colors). No
// screenshots: what's under test is what opens, what closes, and what holds
// focus. The exact delays are `menuTree.test.ts`'s to pin down; here the
// pointer moves the way a hand does and the menus answer the way a user
// expects.

const VIEWPORT = { width: 1280, height: 900 };

function row(page: Page, name: string): Locator {
  return page.getByRole("menuitem", { name, exact: true });
}

async function centerOf(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/** Rests the pointer on `name`'s row until its submenu has opened. */
async function hoverOpen(page: Page, name: string, firstChild: string) {
  const { x, y } = await centerOf(row(page, name));
  await page.mouse.move(x, y);
  await expect(row(page, firstChild)).toBeVisible();
}

test.describe("submenus under the pointer", () => {
  test.beforeEach(async ({ page }) => {
    await openStory(page, "menu/nested", "light");
  });

  test("resting on a submenu's row opens it, leaving the highlight on the row", async ({
    page,
  }) => {
    await hoverOpen(page, "Colors", "Red");
    await expect(row(page, "Colors")).toBeFocused();
    await expect(row(page, "Colors")).toHaveAttribute("aria-expanded", "true");
  });

  test("sweeping across submenu rows on the way elsewhere opens none of them", async ({
    page,
  }) => {
    const alpha = await centerOf(row(page, "Alpha"));
    const omega = await centerOf(row(page, "Omega"));
    await page.mouse.move(alpha.x, alpha.y);
    await page.mouse.move(omega.x, omega.y, { steps: 4 });
    await page.waitForTimeout(500);
    await expect(page.getByRole("menu")).toHaveCount(1);
    await expect(row(page, "Omega")).toBeFocused();
  });

  test("moving to another row closes the submenu after a moment, not at once", async ({
    page,
  }) => {
    await hoverOpen(page, "Colors", "Red");
    const alpha = await centerOf(row(page, "Alpha"));
    await page.mouse.move(alpha.x, alpha.y);
    // The highlight follows the pointer straight away…
    await expect(row(page, "Alpha")).toBeFocused();
    // …while the submenu lingers for the close delay, then goes.
    await expect(row(page, "Red")).toBeVisible();
    await expect(row(page, "Red")).toBeHidden();
  });

  test("coming back within the close delay keeps the submenu open", async ({
    page,
  }) => {
    await hoverOpen(page, "Colors", "Red");
    const red = await centerOf(row(page, "Red"));
    const omega = await centerOf(row(page, "Omega"));
    await page.mouse.move(red.x, red.y);
    // Overshoot back across the parent menu, and return.
    await page.mouse.move(omega.x, omega.y);
    await page.mouse.move(red.x, red.y);
    await page.waitForTimeout(600);
    await expect(row(page, "Red")).toBeVisible();
    await expect(row(page, "Red")).toBeFocused();
  });

  test("cutting diagonally across a sibling submenu's row reaches the open submenu", async ({
    page,
  }) => {
    await hoverOpen(page, "Colors", "Red");
    const colors = (await centerOf(row(page, "Colors"))).box;
    const blue = await centerOf(row(page, "Blue"));
    // Every row that takes the highlight from here on.
    await page.evaluate(() => {
      const w = window as unknown as { focused: string[] };
      w.focused = [];
      document.addEventListener("focusin", (e) =>
        w.focused.push((e.target as HTMLElement).textContent ?? ""),
      );
    });
    // From the left of "Colors" down and across to "Blue", which puts the
    // pointer over "Sizes" for a good third of the way — slowly, so that
    // stretch outlasts the delay that would otherwise open its submenu.
    const from = { x: colors.x + 30, y: colors.y + 18 };
    await page.mouse.move(from.x, from.y);
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        from.x + ((blue.x - from.x) * i) / steps,
        from.y + ((blue.y - from.y) * i) / steps,
      );
      await page.waitForTimeout(30);
    }
    await expect(row(page, "Blue")).toBeFocused();
    await page.waitForTimeout(500);
    await expect(row(page, "Blue")).toBeVisible();
    await expect(row(page, "Small")).toBeHidden();
    // "Sizes" never so much as took the highlight on the way across.
    expect(
      await page.evaluate(
        () => (window as unknown as { focused: string[] }).focused,
      ),
    ).not.toContain("Sizes");
  });

  test("resting on a sibling submenu's row switches to it", async ({
    page,
  }) => {
    await hoverOpen(page, "Colors", "Red");
    await hoverOpen(page, "Sizes", "Small");
    await expect(row(page, "Red")).toBeHidden();
  });

  test("leaving the menus altogether leaves the submenu open", async ({
    page,
  }) => {
    await hoverOpen(page, "Colors", "Red");
    const red = await centerOf(row(page, "Red"));
    await page.mouse.move(red.x, red.y);
    await page.mouse.move(red.x, VIEWPORT.height - 5, { steps: 3 });
    await page.waitForTimeout(600);
    await expect(row(page, "Red")).toBeVisible();
  });

  test("a click opens a submenu at once, and a second click keeps it open", async ({
    page,
  }) => {
    await row(page, "Sizes").click();
    await expect(row(page, "Small")).toBeVisible();
    await row(page, "Sizes").click();
    await page.waitForTimeout(400);
    await expect(row(page, "Small")).toBeVisible();
  });

  test("choosing a submenu's row dismisses the whole stack", async ({
    page,
  }) => {
    await hoverOpen(page, "Colors", "Red");
    await hoverOpen(page, "More", "Cyan");
    await row(page, "Cyan").click();
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
});

test.describe("submenus from the keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await openStory(page, "menu/nested", "light");
    await expect(row(page, "Alpha")).toBeFocused();
  });

  test("Right opens a submenu onto its first row, and Left closes it again", async ({
    page,
  }) => {
    await page.keyboard.press("ArrowDown");
    await expect(row(page, "Colors")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(row(page, "Red")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(row(page, "Red")).toBeHidden();
    await expect(row(page, "Colors")).toBeFocused();
    // Right on a plain row does nothing.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await expect(row(page, "Omega")).toBeFocused();
  });

  test("Enter opens a submenu too", async ({ page }) => {
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(row(page, "Sizes")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row(page, "Small")).toBeFocused();
  });

  test("Up/Down wrap within the open submenu, never reaching its parent", async ({
    page,
  }) => {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    const order = ["Green", "Blue", "More", "Red", "Green"];
    for (const name of order) {
      await page.keyboard.press("ArrowDown");
      await expect(row(page, name)).toBeFocused();
    }
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(row(page, "More")).toBeFocused();
    // The focus trap stays within the submenu as well.
    await page.keyboard.press("Tab");
    await expect(row(page, "Red")).toBeFocused();
  });

  test("Escape closes only the innermost open menu", async ({ page }) => {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowRight");
    await expect(row(page, "Cyan")).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(3);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(2);
    await expect(row(page, "More")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(1);
    await expect(row(page, "Colors")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("keys take over from a hover-opened submenu", async ({ page }) => {
    await hoverOpen(page, "Colors", "Red");
    // Focus is still on "Colors" in the parent, so Down moves on in the
    // parent — and moving off its row closes the submenu.
    await page.keyboard.press("ArrowDown");
    await expect(row(page, "Sizes")).toBeFocused();
    await expect(row(page, "Red")).toBeHidden();
    // Right enters one the pointer opened, and Escape closes just that.
    await hoverOpen(page, "Colors", "Red");
    await page.keyboard.press("ArrowRight");
    await expect(row(page, "Red")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(row(page, "Red")).toBeHidden();
    await expect(page.getByRole("menu")).toHaveCount(1);
  });
});

test.describe("staying on screen", () => {
  async function expectOnScreen(locator: Locator) {
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(box.y + box.height).toBeLessThanOrEqual(VIEWPORT.height);
  }

  test("a context menu raised in the corner, and its submenus, stay inside the viewport", async ({
    page,
  }) => {
    await openStory(page, "menu/context-corner", "light");
    const menus = page.getByRole("menu");
    await expectOnScreen(menus.first());
    await row(page, "Colors").click();
    await row(page, "More").click();
    await expect(menus).toHaveCount(3);
    for (const menu of await menus.all()) await expectOnScreen(menu);
    // With no room to their right, the submenus open to the left.
    const root = (await menus.nth(0).boundingBox())!;
    const colors = (await menus.nth(1).boundingBox())!;
    const more = (await menus.nth(2).boundingBox())!;
    expect(colors.x + colors.width).toBeLessThanOrEqual(root.x + 1);
    expect(more.x + more.width).toBeLessThanOrEqual(colors.x + 1);
  });

  test("a dropdown with no room below opens above its trigger", async ({
    page,
  }) => {
    await openStory(page, "menu/dropdown-corner", "light");
    const trigger = page.getByRole("button", { name: "Open" });
    await trigger.click();
    const menu = page.getByRole("menu");
    await expectOnScreen(menu);
    const triggerBox = (await trigger.boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y);
  });
});
