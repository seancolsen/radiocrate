import { test, expect, type Page } from "@playwright/test";
import { SOURCES_FIXTURE } from "../../src/dev/fixtures";

// Tab management, behaviorally: renaming an unsaved query, middle-click close,
// the tab stack, the Ctrl+Tab switcher and the focus a tab keeps while it's
// away.

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
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
  await page.route("**/api/query", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
}

const handles = (page: Page) => page.locator("[data-tab-id]");
const handle = (page: Page, name: string) =>
  handles(page).filter({ hasText: name });
const active = (page: Page) =>
  page.locator("[data-tab-id]:has(.bg-accent:not(.hidden))");

test("an unsaved query can be named on its tab, in plain text", async ({
  page,
}) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade");
  await page.getByRole("button", { name: "New query" }).click();
  const fresh = handles(page).nth(1);
  await expect(fresh.getByText("new")).not.toHaveClass(/italic/);

  await fresh.dblclick();
  await page.keyboard.type("Road trip");
  await page.keyboard.press("Enter");
  await expect(fresh.getByText("Road trip")).not.toHaveClass(/italic/);
  // Still unsaved.
  await expect(fresh.getByLabel("Unsaved changes")).toBeVisible();
});

test("a middle-click closes a tab", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade,Deep%20Cuts");
  await expect(handles(page)).toHaveCount(2);
  await handle(page, "Lemonade").click({ button: "middle" });
  await expect(handles(page)).toHaveCount(1);
  await expect(handle(page, "Deep Cuts")).toBeVisible();
});

test("closing a tab activates the one used before it", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade,Deep%20Cuts");
  await page.getByRole("button", { name: "New query" }).click();
  // Stack, top first: new, Deep Cuts, Lemonade — until Lemonade is visited.
  await handle(page, "Lemonade").click();
  await handles(page).nth(2).click();
  await handles(page).nth(2).click({ button: "middle" });
  await expect(active(page)).toContainText("Lemonade");
});

test("Ctrl+Tab switches in most-recently-used order while Ctrl is held", async ({
  page,
}) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade,Deep%20Cuts");
  await handle(page, "Lemonade").click();
  await handle(page, "Deep Cuts").click();
  await handle(page, "Lemonade").click();
  const switcher = page.getByTestId("tab-switcher");

  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await expect(switcher).toBeVisible();
  await expect(switcher.getByRole("option", { selected: true })).toContainText(
    "Deep Cuts",
  );
  // Still open, and nothing switched yet.
  await expect(active(page)).toContainText("Lemonade");
  await page.keyboard.up("Control");
  await expect(switcher).toBeHidden();
  await expect(active(page)).toContainText("Deep Cuts");

  // A click on a row picks it.
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await switcher.getByRole("option", { name: "Lemonade" }).click();
  await page.keyboard.up("Control");
  await expect(active(page)).toContainText("Lemonade");
});

test("a tab keeps its focus and caret while it's away", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade");
  await page.getByRole("button", { name: "New query" }).click();
  // The new query's filter takes the caret.
  const editor = page.locator(".cm-content").first();
  await expect(editor).toBeFocused();
  await page.keyboard.type("abcdef");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");

  await handle(page, "Lemonade").click();
  await expect(editor).toBeHidden();
  await handles(page).nth(1).click();
  await expect(editor).toBeFocused();
  await page.keyboard.type("X");
  await expect(editor).toContainText("abcdXef");
});

test.describe("a query's options", () => {
  // Every menu a query raises — its wrench menu, its tab handle's, its row's in
  // the explorer — ends with the same three options.
  const OPTIONS = ["Rename", "Duplicate", "Delete"];
  const rows = (page: Page) =>
    page
      .getByRole("menu")
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.textContent ?? ""));

  test("the wrench menu sets them apart at its end", async ({ page }) => {
    await mockRpc(page);
    await page.goto("/?tabs=Lemonade");
    await page.getByRole("button", { name: "Query actions" }).click();
    const items = await rows(page);
    expect(items.slice(-3)).toEqual(OPTIONS);
    // A separator stands between them and the query's own actions.
    const separatorBefore = await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Rename" })
      .evaluate((row) => !row.previousElementSibling?.matches("button"));
    expect(separatorBefore).toBe(true);
  });

  test("a tab handle's context menu renames in the handle", async ({
    page,
  }) => {
    await mockRpc(page);
    await page.goto("/?tabs=Lemonade,Deep%20Cuts");
    await handle(page, "Deep Cuts").click({ button: "right" });
    expect(await rows(page)).toEqual(OPTIONS);
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const field = handle(page, "").getByRole("textbox");
    await expect(field).toBeFocused();
    await field.fill("Deeper Cuts");
    await field.press("Enter");
    await expect(handle(page, "Deeper Cuts")).toBeVisible();
  });

  test("a tab handle's context menu duplicates and deletes", async ({
    page,
  }) => {
    await mockRpc(page);
    await page.goto("/?tabs=Lemonade");
    await handle(page, "Lemonade").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    // An unsaved copy, opened beside it.
    await expect(handles(page)).toHaveCount(2);
    await expect(handles(page).nth(1).getByText("new")).toBeVisible();

    await handle(page, "Lemonade").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByText("Delete “Lemonade”?")).toBeVisible();
  });

  test("an Opened row's context menu renames in the row", async ({ page }) => {
    await mockRpc(page);
    // Narrow: the explorer is a drawer over the tab bar, and lists what's open.
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto("/?tabs=Lemonade,Deep%20Cuts");
    await page.getByRole("button", { name: "Open explorer" }).click();
    await expect(page.getByRole("heading", { name: "Opened" })).toBeVisible();
    await page
      .getByRole("button", { name: "Deep Cuts", exact: true })
      .click({ button: "right" });
    expect(await rows(page)).toEqual(OPTIONS);
    await page.getByRole("menuitem", { name: "Rename" }).click();
    // The field is in the row, not under the drawer in the tab handle.
    const field = page.getByRole("textbox", { name: "Name of Deep Cuts" });
    await expect(field).toBeFocused();
    await expect(handle(page, "").getByRole("textbox")).toHaveCount(0);
    await field.fill("Deeper Cuts");
    await field.press("Enter");
    await expect(
      page.getByRole("button", { name: "Deeper Cuts", exact: true }),
    ).toBeVisible();
    await expect(handle(page, "Deeper Cuts")).toBeAttached();
  });
});
