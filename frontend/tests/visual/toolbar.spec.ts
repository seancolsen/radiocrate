import { test, expect, type Page } from "@playwright/test";
import {
  ALBUM_SORT_PRESET_ID,
  FILTER_DEF,
  PRESETS_FIXTURE,
  SOURCES_FIXTURE,
} from "../../src/dev/fixtures";
import type { AppStoreFacade } from "../../src/dev/seed";

/** The store the app exposes under `?expose=1`. */
interface AppWindow {
  __appStore: AppStoreFacade;
}

// The query toolbar's behaviors — the ones that only exist with the whole page
// assembled behind them. Its pixels are covered component-by-component in
// `query.spec.ts`, through the harness.

/** Fulfill the RPC route from fixtures (no backend). `preset.list` returns the
 * "vetted" filter preset the seeded definition references. `/api/query` is
 * stubbed empty — the introspection call fails gracefully, so no tab ever runs
 * a real query and the seeded state stays put. */
async function mockRpc(page: Page) {
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result =
      body.method === "source.list"
        ? SOURCES_FIXTURE
        : body.method === "preset.list"
          ? PRESETS_FIXTURE
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

const def = (d: unknown) => encodeURIComponent(JSON.stringify(d));

/** Set up the mock, navigate to a seeded query page, and wait for its toolbar. */
async function openQueryPage(page: Page, query: string) {
  await mockRpc(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/?sidebar=open&tabs=Lemonade&${query}`);
  await expect(page.getByTestId("query-toolbar")).toBeVisible();
}

/** The active tab's working definition, read straight out of the exposed store
 * (`?expose=1`) — what the base-switching assertions are actually about. */
async function liveDefinition(page: Page) {
  return await page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    const id = store.state.activeTabId ?? "";
    return store.queryTab(id)?.live;
  });
}

test("switching the base keeps the filter and reseeds the rest from the new table's defaults", async ({
  page,
}) => {
  await openQueryPage(
    page,
    `clean=1&count=12&recordFixture=1&expose=1&def=${def(FILTER_DEF)}`,
  );
  await page.getByRole("button", { name: "Query actions" }).click();
  await page.getByRole("menuitem", { name: "Base" }).click();
  // The query's own base is checked; the tables come from the schema.
  // `exact` so this picks `track`, not the `track_tag` beside it.
  await expect(
    page.getByRole("menuitemradio", { name: "track", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "album" }).click();

  // The filter the user typed survives verbatim; the "vetted" preset (scoped to
  // `track`) does not, and sorting comes back as `album`'s apply-by-default
  // preset.
  expect(await liveDefinition(page)).toEqual({
    base: "album",
    filter: { custom: "jazz playcount:<100", presets: [] },
    sort: { preset: ALBUM_SORT_PRESET_ID },
    display: { custom: "" },
  });
  // Choosing a base dismisses the whole menu stack.
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("Full Querydown flattens the query into one editable field", async ({
  page,
}) => {
  await openQueryPage(
    page,
    `clean=1&count=12&recordFixture=1&expose=1&def=${def(FILTER_DEF)}`,
  );
  await page.getByRole("button", { name: "Query actions" }).click();
  await page.getByRole("menuitem", { name: "Base" }).click();
  await page.getByRole("menuitemradio", { name: "Full Querydown" }).click();

  // The section toggles are gone, replaced by one Querydown toggle over the
  // whole-query editor, which holds the flattened query.
  await expect(
    page.getByRole("button", { name: "Filter", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Querydown" })).toBeVisible();
  await expect(page.getByPlaceholder("Querydown")).toHaveValue(
    "#track\njazz playcount:<100\nrating.value:>=4 !++#tag{name:duplicate} file.deletion:@null",
  );

  // Editing it writes back to the working definition…
  await page.getByPlaceholder("Querydown").fill("#album $title");
  expect((await liveDefinition(page))?.full).toBe("#album $title");

  // …and picking a base table again drops back to the builder.
  await page.getByRole("button", { name: "Query actions" }).click();
  await page.getByRole("menuitem", { name: "Base" }).click();
  await page.getByRole("menuitemradio", { name: "track", exact: true }).click();
  expect(await liveDefinition(page)).toEqual({
    base: "track",
    filter: { custom: "jazz playcount:<100", presets: [] },
    sort: { custom: "" },
    display: { custom: "" },
  });
  await expect(
    page.getByRole("button", { name: "Filter", exact: true }),
  ).toBeVisible();
});

test("the query-actions menu traps focus and Up/Down/Enter drive it", async ({
  page,
}) => {
  await openQueryPage(page, `clean=1&count=12&def=${def(FILTER_DEF)}&expose=1`);
  await page.getByRole("button", { name: "Query actions" }).click();
  const menu = page.getByRole("menu");
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveText([
    "Base",
    "Rename",
    "Duplicate",
    "View SQL",
    "Export results data",
    "Delete",
  ]);

  // Opening moves real focus to the first row, not the trigger that opened it.
  await expect(items.first()).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();

  // Up from the top wraps to the bottom.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();

  // The focus trap: Tab cycles within the menu instead of leaving it.
  await page.keyboard.press("Tab");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(items.last()).toBeFocused();

  // Enter picks the highlighted row — "Rename" starts the tab rename and the
  // menu dismisses, just as clicking the row would.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  expect(
    await page.evaluate(
      () => (window as unknown as AppWindow).__appStore.state.renaming,
    ),
  ).not.toBeNull();
});

test("the Refresh icon spins while the run it starts is in flight", async ({
  page,
}) => {
  // The same fixtures as `mockRpc`, but with the SQL endpoint held open, so the
  // tab's run stays in flight for as long as the assertions need it to.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result =
      body.method === "source.list"
        ? SOURCES_FIXTURE
        : body.method === "preset.list"
          ? PRESETS_FIXTURE
          : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
  await page.route("**/api/query", async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: "text/plain", body: "" });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  // A definition the record fixture's schema can actually compile — the
  // seeded `FILTER_DEF` leans on a preset that names columns it doesn't have,
  // and a compile that throws never reaches the request being held.
  const RUNNABLE = {
    base: "track",
    filter: { custom: "", presets: [] },
    sort: { custom: "" },
    display: { custom: "" },
  };
  await page.goto(
    `/?tabs=Lemonade&clean=1&recordFixture=1&expose=1&def=${def(RUNNABLE)}`,
  );
  const toolbar = page.getByTestId("query-toolbar");
  await expect(toolbar).toBeVisible();

  // The tab runs its query as soon as it's viewed, and that run is the one
  // being held here.
  const icon = toolbar
    .getByRole("button", { name: "Refresh", exact: true })
    .locator("svg");
  await expect(icon).toHaveClass(/animate-spin/);

  release();
  await expect(icon).not.toHaveClass(/animate-spin/);
});

test("Undo and Redo step the query through what it has run, each shown only while it applies", async ({
  page,
}) => {
  await openQueryPage(
    page,
    `clean=1&count=12&recordFixture=1&expose=1&section=filter&def=${def(FILTER_DEF)}`,
  );
  const toolbar = page.getByTestId("query-toolbar");
  const undo = toolbar.getByRole("button", { name: "Undo", exact: true });
  const redo = toolbar.getByRole("button", { name: "Redo", exact: true });
  const filter = async () => (await liveDefinition(page))?.filter.custom;
  await expect(undo).toHaveCount(0);
  await expect(redo).toHaveCount(0);

  // An edit can be undone at once, before its debounced run has even fired.
  await page.getByPlaceholder("Filter").fill("blues");
  await expect(undo).toBeVisible();

  await undo.click();
  expect(await filter()).toBe("jazz playcount:<100");
  await expect(undo).toHaveCount(0);
  await expect(redo).toBeVisible();

  await redo.click();
  expect(await filter()).toBe("blues");
  await expect(redo).toHaveCount(0);
  await expect(undo).toBeVisible();

  // A saved query saves itself: there's never a Save button for its edits.
  await expect(toolbar.getByRole("button", { name: "Save" })).toHaveCount(0);
});

test("a saved query's edit is saved once the app goes quiet; a failed save brings back Save and the ✱", async ({
  page,
}) => {
  await mockRpc(page);
  // Registered after `mockRpc`, so it's consulted first: the first save is
  // turned down, every later one accepted.
  const saves: string[] = [];
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      params: { definition: string };
      id: number;
    };
    if (body.method !== "source.update_definition") return route.fallback();
    saves.push(body.params.definition);
    const reply =
      saves.length === 1
        ? { error: { code: -32000, message: "database is locked" } }
        : { result: null };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", ...reply, id: body.id }),
    });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `/?tabs=Lemonade&clean=1&count=12&recordFixture=1&section=filter&def=${def(FILTER_DEF)}`,
  );
  const toolbar = page.getByTestId("query-toolbar");
  const save = toolbar.getByRole("button", { name: "Save" });
  const star = page.getByLabel("Unsaved changes");

  await page.getByPlaceholder("Filter").fill("blues");
  // Nothing to show while the save waits for quiet…
  await expect(save).toHaveCount(0);
  await expect(star).toHaveCount(0);
  // …and once it has been tried and failed, the backend's answer, the Save
  // button and the ✱.
  await expect(page.getByText("database is locked")).toBeVisible({
    timeout: 10_000,
  });
  expect(saves).toHaveLength(1);
  await expect(save).toBeVisible();
  await expect(star.first()).toBeVisible();

  // Save sends it again, now.
  await save.click();
  await expect(save).toHaveCount(0);
  await expect(star).toHaveCount(0);
  expect(saves).toHaveLength(2);
  expect(JSON.parse(saves[1]).filter.custom).toBe("blues");
});

test("a new query has no name and a Save button until it's saved", async ({
  page,
}) => {
  await openQueryPage(page, `clean=1&count=12&def=${def(FILTER_DEF)}`);
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: "New query" }).click();
  const tabBar = page.locator("[data-tab-id]");
  await expect(tabBar.last()).toHaveText(/^new$/);

  const save = page
    .getByTestId("query-toolbar")
    .filter({ visible: true })
    .getByRole("button", { name: "Save" });
  await save.click();
  await expect(save).toHaveCount(0);
  await expect(tabBar.last()).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("Export results data copies the selected rows, tab-separated", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openQueryPage(page, "grid=lemonade&expose=1");
  await page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    const id = store.state.activeTabId ?? "";
    store.clickRow(id, 4, { shift: false, ctrl: false });
    store.clickRow(id, 2, { shift: false, ctrl: true });
  });

  await page.getByRole("button", { name: "Query actions" }).click();
  await page.getByRole("menuitem", { name: "Export results data" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Export data");
  await dialog.getByLabel("Rows").selectOption("selected");
  await dialog.getByRole("button", { name: "Copy to clipboard" }).click();
  await expect(dialog).toBeHidden();

  const lines = (
    await page.evaluate(() => navigator.clipboard.readText())
  ).split("\n");
  // Rows 2 and 4, in the order shown; a list cell's values in one field.
  expect(lines).toHaveLength(2);
  expect(lines[0].split("\t")).toContain("Beyoncé, Jack White");
  expect(lines[1].split("\t")).toContain("Beyoncé, The Weeknd");
});
