import { expect, test, type Locator, type Page } from "@playwright/test";
import { SCHEMES, openStory, snapshot } from "./harness";

// The explorer's tree of saved queries (the `explorer/tree` story: "Favorites"
// open, holding Lemonade and a closed "Road trip"; then Deep Cuts and an empty
// "Archive" at the top level): its looks — folders, the filter, a rename, the
// "+" menu and the two drop indicators — and what its controls and drags do.

/** The explorer's tree rows, top to bottom, as "depth:name". */
async function treeRows(page: Page): Promise<string[]> {
  return page
    .getByRole("tree", { name: "Queries" })
    .getByRole("treeitem")
    .evaluateAll((rows) =>
      rows.map(
        (r) =>
          `${Number(r.getAttribute("aria-level")) - 1}:${r.textContent ?? ""}`,
      ),
    );
}

function treeRow(page: Page, name: string): Locator {
  return page
    .getByRole("tree", { name: "Queries" })
    .getByRole("treeitem", { name, exact: true });
}

/** Presses on `from`'s row and moves the mouse to `(x, y)` within `to`'s row —
 * `x` from its left edge in px, `y` as a fraction of its height — leaving the
 * button down. */
async function dragOver(
  page: Page,
  from: string,
  to: string,
  x: number,
  y: number,
) {
  const a = (await treeRow(page, from).boundingBox())!;
  const b = (await treeRow(page, to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + x, b.y + b.height * y, { steps: 8 });
}

for (const colorScheme of SCHEMES) {
  for (const story of [
    "explorer/tree",
    "explorer/filter",
    "explorer/folder-rename",
  ]) {
    test(`${story} - ${colorScheme}`, async ({ page }) => {
      const stage = await openStory(page, story, colorScheme);
      await expect(
        stage.getByText("Deep Cuts").or(stage.getByText("Workout Mix")).first(),
      ).toBeVisible();
      await expect(stage).toHaveScreenshot(snapshot(story, colorScheme));
    });
  }

  test(`explorer/tree-new-menu - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "explorer/tree", colorScheme);
    await page.getByRole("button", { name: "New query or folder" }).click();
    await expect(
      page.getByRole("menuitem", { name: "New folder" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("explorer/tree-new-menu", colorScheme),
    );
  });

  // Between "Road trip" and "Deep Cuts", pointer to the right: the line is
  // indented one level, into "Favorites" after "Road trip".
  test(`explorer/tree-drop-between - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "explorer/tree", colorScheme);
    await dragOver(page, "Archive", "Road trip", 150, 0.9);
    await expect(stage).toHaveScreenshot(
      snapshot("explorer/tree-drop-between", colorScheme),
    );
  });

  test(`explorer/tree-drop-into - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "explorer/tree", colorScheme);
    await dragOver(page, "Deep Cuts", "Archive", 60, 0.5);
    await expect(stage).toHaveScreenshot(
      snapshot("explorer/tree-drop-into", colorScheme),
    );
  });
}

test.describe("the query tree", () => {
  test.beforeEach(async ({ page }) => {
    await openStory(page, "explorer/tree", "light");
  });

  test("a folder's chevron opens and closes it; a click on the folder doesn't", async ({
    page,
  }) => {
    await treeRow(page, "Road trip").click();
    expect(await treeRows(page)).not.toContain("2:Workout Mix");
    await page.getByRole("button", { name: "Expand Road trip" }).click();
    expect(await treeRows(page)).toContain("2:Workout Mix");
    await page.getByRole("button", { name: "Collapse Favorites" }).click();
    expect(await treeRows(page)).toEqual([
      "0:Favorites",
      "0:Deep Cuts",
      "0:Archive",
    ]);
  });

  test("double-clicking a folder renames it in place", async ({ page }) => {
    await treeRow(page, "Archive").dblclick();
    const field = page.getByRole("textbox", { name: "Folder name" });
    await expect(field).toBeFocused();
    await field.fill("Old stuff");
    await field.press("Enter");
    await expect(treeRow(page, "Old stuff")).toBeVisible();

    // Escape abandons an edit.
    await treeRow(page, "Old stuff").dblclick();
    await field.fill("Nope");
    await field.press("Escape");
    await expect(treeRow(page, "Old stuff")).toBeVisible();
  });

  test("the + menu adds a folder at the top, ready to name", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "New query or folder" }).click();
    await page.getByRole("menuitem", { name: "New folder" }).click();
    const field = page.getByRole("textbox", { name: "Folder name" });
    await expect(field).toBeFocused();
    await field.fill("Mixes");
    await field.press("Enter");
    expect((await treeRows(page))[0]).toBe("0:Mixes");
  });

  test("the filter button shows the filter, and hiding it clears it", async ({
    page,
  }) => {
    const toggle = page.getByRole("button", { name: "Filter queries" });
    const input = page.getByRole("textbox", { name: "Filter queries" });
    await expect(input).toHaveCount(0);
    await toggle.click();
    await expect(input).toBeFocused();
    await input.fill("trip");
    // A folder's name matches too, and shows what's inside it.
    expect(await treeRows(page)).toEqual([
      "0:Favorites",
      "1:Road trip",
      "2:Workout Mix",
    ]);
    await toggle.click();
    await expect(input).toHaveCount(0);
    expect(await treeRows(page)).toContain("0:Deep Cuts");
    await toggle.click();
    await expect(input).toHaveValue("");
  });

  test("dropping between rows places an item at the line's depth", async ({
    page,
  }) => {
    // At the far left: after "Favorites", at the top level…
    await dragOver(page, "Archive", "Road trip", 2, 0.9);
    await page.mouse.up();
    expect(await treeRows(page)).toEqual([
      "0:Favorites",
      "1:Lemonade",
      "1:Road trip",
      "0:Archive",
      "0:Deep Cuts",
    ]);
    // …further right: inside "Favorites", after "Road trip".
    await dragOver(page, "Deep Cuts", "Road trip", 150, 0.9);
    await page.mouse.up();
    expect(await treeRows(page)).toEqual([
      "0:Favorites",
      "1:Lemonade",
      "1:Road trip",
      "1:Deep Cuts",
      "0:Archive",
    ]);
  });

  test("dropping onto a folder moves an item into it", async ({ page }) => {
    await dragOver(page, "Lemonade", "Archive", 60, 0.5);
    await page.mouse.up();
    await page.getByRole("button", { name: "Expand Archive" }).click();
    expect(await treeRows(page)).toEqual([
      "0:Favorites",
      "1:Road trip",
      "0:Deep Cuts",
      "0:Archive",
      "1:Lemonade",
    ]);
  });

  test("a folder can't be dropped inside itself", async ({ page }) => {
    await dragOver(page, "Favorites", "Road trip", 60, 0.5);
    await page.mouse.up();
    expect(await treeRows(page)).toEqual([
      "0:Favorites",
      "1:Lemonade",
      "1:Road trip",
      "0:Deep Cuts",
      "0:Archive",
    ]);
  });

  test("a drag doesn't open the query it picked up; a click does", async ({
    page,
  }) => {
    // An opened query shows in the "Opened" list as well as in the tree.
    const deepCuts = page.getByText("Deep Cuts", { exact: true });
    await dragOver(page, "Deep Cuts", "Deep Cuts", 60, 0.1);
    await page.mouse.up();
    await expect(deepCuts).toHaveCount(1);
    await treeRow(page, "Deep Cuts").click();
    await expect(deepCuts).toHaveCount(2);
  });

  test("a touch picks a row up with a long press", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      x?: number,
      y?: number,
    ) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: x === undefined ? [] : [{ x, y: y! }],
      });
    const from = (await treeRow(page, "Lemonade").boundingBox())!;
    const to = (await treeRow(page, "Archive").boundingBox())!;
    await touch("touchStart", from.x + 60, from.y + from.height / 2);
    await page.waitForTimeout(700);
    for (let i = 1; i <= 8; i++) {
      const y = from.y + from.height / 2 + ((to.y - from.y) * i) / 8;
      await touch("touchMove", to.x + 60, y);
    }
    await expect(treeRow(page, "Archive")).toHaveClass(/ring-accent/);
    await touch("touchEnd");
    expect(await treeRows(page)).toEqual([
      "0:Favorites",
      "1:Road trip",
      "0:Deep Cuts",
      "0:Archive",
    ]);
  });

  test("a touch that moves straight away is a scroll, not a drag", async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    const from = (await treeRow(page, "Lemonade").boundingBox())!;
    const x = from.x + 60;
    const y = from.y + from.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let i = 1; i <= 6; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + i * 12 }],
      });
    }
    await page.waitForTimeout(700);
    await expect(page.locator(".ring-accent")).toHaveCount(0);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(await treeRows(page)).toContain("1:Lemonade");
  });

  test("Escape cancels a drag", async ({ page }) => {
    await dragOver(page, "Deep Cuts", "Archive", 60, 0.5);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await treeRows(page)).toContain("0:Deep Cuts");
  });
});
