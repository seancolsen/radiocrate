import { test, expect, type Page } from "@playwright/test";
import {
  ALBUM_SORT_PRESET_ID,
  FILTER_DEF,
  PRESETS_FIXTURE,
  QUERIES_FIXTURE,
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
      body.method === "query.list"
        ? QUERIES_FIXTURE
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
  await expect(page.getByRole("button", { name: "Filter" })).toHaveCount(0);
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
  await expect(page.getByRole("button", { name: "Filter" })).toBeVisible();
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
      body.method === "query.list"
        ? QUERIES_FIXTURE
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
