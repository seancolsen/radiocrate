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
