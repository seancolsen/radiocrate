import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "../../src/dev/fixtures";
import type { AppStore } from "../../src/state/store";

// The command palette and the keyboard-shortcuts system, behaviorally: a chord
// firing its command, the palette running one, arrow-key row selection, and the
// shortcuts editor rebinding. What any of it looks like is covered
// component-by-component through the harness (`shell.spec.ts`, `app.spec.ts`).

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
          : // `keybinding.list` included: no persisted overrides, so every
            // command shows its built-in default.
            body.method === "keybinding.list"
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

const palette = (page: Page) => page.getByTestId("command-palette");
const option = (page: Page, name: string | RegExp) =>
  page.getByRole("option", { name });

test("the open shortcut toggles the palette", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade");
  await expect(palette(page)).toBeHidden();

  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  // The search field takes focus, so typing filters rather than reaching the app.
  await page.keyboard.type("explorer");
  await expect(option(page, "Explorer: Toggle explorer sidebar")).toBeVisible();
  await expect(option(page, "Tabs: Save active tab")).toBeHidden();

  // The same chord closes it again, as does Escape.
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeHidden();
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
});

test("running a command from the palette", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade");
  const sidebar = page.getByRole("complementary").first();
  await expect(sidebar).toBeHidden();

  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("toggle explorer");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(sidebar).toBeVisible();

  // Having just run, it's the first row the next time the palette opens (MRU).
  await page.keyboard.press("Control+Shift+P");
  await expect(
    option(page, "Explorer: Toggle explorer sidebar"),
  ).toHaveAttribute("aria-selected", "true");
});

test("a bound chord fires its command", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade");
  const sidebar = page.getByRole("complementary").first();
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("Control+b");
  await expect(sidebar).toBeVisible();
  await page.keyboard.press("Control+b");
  await expect(sidebar).toBeHidden();
});

test("arrow keys move the result-row selection", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade&grid=lemonade&expose=1");
  await expect(page.locator("canvas[data-rows]")).toBeVisible();

  const selection = async () =>
    await page.evaluate(() => {
      const store = (window as unknown as AppWindow).__appStore;
      const id = store.state.activeTabId!;
      return [...store.rowSelection(id)].sort((a, b) => a - b);
    });

  // With nothing selected, Down takes the first row; Shift+Down extends.
  await page.keyboard.press("ArrowDown");
  expect(await selection()).toEqual([0]);
  await page.keyboard.press("ArrowDown");
  expect(await selection()).toEqual([1]);
  await page.keyboard.press("Shift+ArrowDown");
  expect(await selection()).toEqual([1, 2]);
  await page.keyboard.press("Shift+ArrowUp");
  expect(await selection()).toEqual([1]);
  await page.keyboard.press("ArrowUp");
  expect(await selection()).toEqual([0]);
  // Clamped at the top rather than wrapping.
  await page.keyboard.press("ArrowUp");
  expect(await selection()).toEqual([0]);
});

test("the focus commands open a builder section and take the caret", async ({
  page,
}) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade&grid=lemonade");
  const filter = page.getByPlaceholder("Filter").first();
  await expect(filter).toBeHidden();

  await page.keyboard.press("Control+Shift+F");
  await expect(filter).toBeVisible();
  await expect(filter).toBeFocused();

  // Switching sections works from inside the focused textarea, because the
  // chord carries the mod key.
  await page.keyboard.press("Control+Shift+S");
  const sort = page.getByPlaceholder("Sort").first();
  await expect(sort).toBeVisible();
  await expect(sort).toBeFocused();
  await expect(filter).toBeHidden();
});

test("the tab commands cycle, move and close tabs", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade,Deep%20Cuts,Workout%20Mix&expose=1");
  const state = async () =>
    await page.evaluate(() => {
      const store = (window as unknown as AppWindow).__appStore;
      return {
        names: store.state.tabs.map((t) => t.name),
        active: store.state.tabs.find((t) => t.id === store.state.activeTabId)
          ?.name,
      };
    });
  await expect.poll(async () => (await state()).names.length).toBe(3);

  await page.keyboard.press("Control+Alt+ArrowRight");
  expect((await state()).active).toBe("Deep Cuts");
  // Previous from the first tab wraps to the last.
  await page.keyboard.press("Control+Alt+ArrowLeft");
  await page.keyboard.press("Control+Alt+ArrowLeft");
  expect((await state()).active).toBe("Workout Mix");

  await page.keyboard.press("Control+Alt+Shift+ArrowLeft");
  expect((await state()).names).toEqual([
    "Lemonade",
    "Workout Mix",
    "Deep Cuts",
  ]);
  expect((await state()).active).toBe("Workout Mix");

  await page.keyboard.press("Control+Alt+w");
  expect((await state()).names).toEqual(["Lemonade", "Deep Cuts"]);
});

test("a text field keeps its own plain keys", async ({ page }) => {
  await mockRpc(page);
  // Open the filter builder, whose textarea is a plain-key consumer.
  await page.goto("/?tabs=Lemonade&grid=lemonade&section=filter&expose=1");
  const input = page.getByPlaceholder("Filter").first();
  await input.click();
  await page.keyboard.press("ArrowDown");

  const selection = await page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    return [...store.rowSelection(store.state.activeTabId!)];
  });
  // The arrow moved the caret, not the selection.
  expect(selection).toEqual([]);

  // A chord carrying the mod key still fires while typing.
  const sidebar = page.getByRole("complementary").first();
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("Control+b");
  await expect(sidebar).toBeVisible();
});

test("a shortcut row's context menu removes and resets its binding", async ({
  page,
}) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade&shortcuts=1");
  const row = page.getByRole("button", {
    name: /Explorer: Toggle explorer sidebar/,
  });
  await expect(row).toContainText("Ctrl+B");

  const sidebar = page.getByRole("complementary").first();

  // Remove: the binding goes away, and "Reset to default" takes its place in the
  // menu. The chord no longer fires — the editor's tab leaves the global pass
  // running, so that's checked without leaving the page.
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Reset to default" }),
  ).toBeHidden();
  await page.getByRole("menuitem", { name: "Remove keybinding" }).click();
  await expect(row).toContainText("—");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toBeHidden();

  // Reset it back to its built-in default, and it fires again.
  await row.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Remove keybinding" }),
  ).toBeHidden();
  await page.getByRole("menuitem", { name: "Reset to default" }).click();
  await expect(row).toContainText("Ctrl+B");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toBeVisible();
});

test("the Settings menu opens the shortcuts editor as a singleton tab", async ({
  page,
}) => {
  await mockRpc(page);
  await page.goto("/?sidebar=open&tabs=Lemonade&expose=1");
  const editor = page.getByTestId("shortcuts-page");
  const queryPage = page.getByTestId("query-toolbar");
  await expect(editor).toBeHidden();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
  await expect(editor).toBeVisible();
  // A tab of its own: the query page is no longer showing, and the editor has a
  // handle in the bar and a row in the explorer's "Opened" list.
  await expect(queryPage).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Close Keyboard Shortcuts" }),
  ).toHaveCount(2);

  const tabs = async () =>
    await page.evaluate(() => {
      const store = (window as unknown as AppWindow).__appStore;
      return store.state.tabs.map((t) => t.kind);
    });
  expect(await tabs()).toEqual(["query", "shortcuts"]);

  // Asking again focuses the one that's open rather than opening a second.
  await page.locator("[data-tab-id]").filter({ hasText: "Lemonade" }).click();
  await expect(queryPage).toBeVisible();
  await expect(editor).toBeHidden();
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("configure keyboard");
  await page.keyboard.press("Enter");
  await expect(editor).toBeVisible();
  expect(await tabs()).toEqual(["query", "shortcuts"]);

  // And it closes like any other tab, leaving the query page showing.
  await page
    .getByRole("button", { name: "Close Keyboard Shortcuts" })
    .first()
    .click();
  await expect(editor).toBeHidden();
  await expect(queryPage).toBeVisible();
  expect(await tabs()).toEqual(["query"]);
});

test("query commands stand down on the shortcuts tab, tab commands don't", async ({
  page,
}) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade&grid=lemonade&shortcuts=1&expose=1");
  const editor = page.getByTestId("shortcuts-page");
  await expect(editor).toBeVisible();

  // "Query: Focus filter builder" is gated on a *query* tab, so its chord does
  // nothing here — no builder opens on the query tab hiding behind this one.
  await page.keyboard.press("Control+Shift+F");
  await expect(page.getByPlaceholder("Filter").first()).toBeHidden();

  // Tab commands are gated on any tab, so this one closes the editor.
  await page.keyboard.press("Control+Alt+w");
  await expect(editor).toBeHidden();
  const kinds = await page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    return store.state.tabs.map((t) => t.kind);
  });
  expect(kinds).toEqual(["query"]);
});

test("the shortcuts editor's handle takes no rename", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?tabs=Lemonade&shortcuts=1");
  const handle = page.locator("[data-tab-id]").filter({ hasText: "Keyboard" });
  await handle.dblclick();
  // A query handle would have swapped its name for a text field; this one can't
  // be renamed, so the name stays put.
  await expect(handle).toContainText("Keyboard Shortcuts");
  await expect(handle.locator("input")).toHaveCount(0);
});

test("the shortcuts editor rebinds a command", async ({ page }) => {
  await mockRpc(page);
  const sets: { commandId: string; chord: string | null }[] = [];
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      params: { commandId: string; chord: string | null };
      id: number;
    };
    if (body.method === "keybinding.set") sets.push(body.params);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        jsonrpc: "2.0",
        result: body.method === "query.list" ? QUERIES_FIXTURE : null,
        id: body.id,
      }),
    });
  });
  await page.goto("/?tabs=Lemonade&shortcuts=1");

  // The row shows the built-in default, then the capture dialog takes a chord.
  const row = page.getByRole("button", {
    name: /Explorer: Toggle explorer sidebar/,
  });
  await expect(row).toContainText("Ctrl+B");
  await row.click();
  await expect(
    page.getByRole("heading", { name: "Set keyboard shortcut" }),
  ).toBeVisible();
  await page.keyboard.press("Control+Alt+J");
  await page.getByRole("button", { name: "Assign", exact: true }).click();

  await expect(row).toContainText("Ctrl+Alt+J");
  expect(sets).toContainEqual({
    commandId: "explorer.toggle",
    chord: "mod+alt+J",
  });

  // And the new chord works, while the old one no longer does.
  const sidebar = page.getByRole("complementary").first();
  await page.keyboard.press("Control+b");
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("Control+Alt+J");
  await expect(sidebar).toBeVisible();
});
