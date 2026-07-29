import { test, expect, type Page } from "@playwright/test";
import {
  ALBUM_SORT_PRESET_ID,
  FILTER_DEF,
  FULL_DEF,
  PRESETS_FIXTURE,
  QUERIES_FIXTURE,
} from "./fixtures";
import type { AppStore } from "../../src/state/store";

/** The store the app exposes under `?expose=1`. */
interface AppWindow {
  __appStore: AppStore;
}

/** Fulfill the RPC route from fixtures (no backend). `preset.list` returns the
 * "vetted" filter preset so the builder snapshots can reference it. `/api/query`
 * is stubbed empty — the introspection call fails gracefully, so no tab ever
 * runs a real query and the seeded state stays put. */
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

/** Set up the mock + theme + viewport, navigate, wait for fonts and the toolbar,
 * and return its element locator so the snapshot captures just the toolbar
 * (component isolation). Setup is per-test (not a shared `beforeEach`) so the
 * light/dark loop can't cross-register hooks. */
async function toolbar(
  page: Page,
  colorScheme: "light" | "dark",
  query: string,
  width = 1280,
  sidebar = true,
) {
  await mockRpc(page);
  await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
  await page.setViewportSize({ width, height: 800 });
  const s = sidebar ? "sidebar=open&" : "";
  await page.goto(`/?${s}tabs=Lemonade&${query}`);
  await page.evaluate(() => document.fonts.ready);
  const el = page.getByTestId("query-toolbar");
  await expect(el).toBeVisible();
  return el;
}

for (const colorScheme of ["light", "dark"] as const) {
  // Saved (clean) query, no builder open: no Save button; the section toggles
  // sit inactive; "12 results" at the far right. The DOM analog of whole_app's
  // top line before the filter is opened.
  test(`toolbar saved - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `clean=1&count=12&def=${def(FILTER_DEF)}`,
    );
    await expect(el).toHaveScreenshot(`toolbar-saved-${colorScheme}.png`);
  });

  // Filter section active + unsaved: Save button shown, the active blue split
  // button with its ⋮, and the second builder line (custom input + "vetted"
  // preset tab). Matches whole_app.png's toolbar.
  test(`toolbar filter active - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `count=12&section=filter&def=${def(FILTER_DEF)}`,
    );
    await expect(page.getByRole("button", { name: "vetted" })).toBeVisible();
    await expect(el).toHaveScreenshot(
      `toolbar-filter-active-${colorScheme}.png`,
    );
  });

  // Sort section active: the sort split button is highlighted; the second line
  // is a single (empty) custom input.
  test(`toolbar sort active - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `count=12&section=sort&def=${def(FILTER_DEF)}`,
    );
    await expect(el).toHaveScreenshot(`toolbar-sort-active-${colorScheme}.png`);
  });

  // Display section active.
  test(`toolbar display active - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `count=12&section=display&def=${def(FILTER_DEF)}`,
    );
    await expect(el).toHaveScreenshot(
      `toolbar-display-active-${colorScheme}.png`,
    );
  });

  // Full-Querydown mode: the three section toggles collapse into the single
  // "Querydown" toggle (no ⋮ — there are no sections to configure), over the
  // whole-query editor.
  test(`toolbar full querydown - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `clean=1&count=12&full=1&def=${def(FULL_DEF)}`,
    );
    await expect(page.getByPlaceholder("Querydown")).toBeVisible();
    await expect(el).toHaveScreenshot(
      `toolbar-full-querydown-${colorScheme}.png`,
    );
  });

  // The wrench menu's Base submenu, opened: the schema's tables as an exclusive
  // choice (the query's own is checked) over the "Full Querydown" escape hatch.
  // Clipped to the menus' corner rather than shot full-page — nothing below or
  // right of it is part of what this proves.
  test(`base submenu - ${colorScheme}`, async ({ page }) => {
    await toolbar(
      page,
      colorScheme,
      `clean=1&count=12&recordFixture=1&sidebar=closed&def=${def(FILTER_DEF)}`,
      1280,
      false,
    );
    await page.getByRole("button", { name: "Query actions" }).click();
    await page.getByRole("menuitem", { name: "Base" }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "Full Querydown" }),
    ).toBeVisible();
    await expect(page).toHaveScreenshot(`base-submenu-${colorScheme}.png`, {
      clip: { x: 0, y: 0, width: 700, height: 400 },
    });
  });

  // Compact bar (< 500px): section buttons drop their labels and the separator
  // is hidden.
  test(`toolbar compact - ${colorScheme}`, async ({ page }) => {
    // Sidebar closed: at < 500px an open sidebar is a drawer that would overlay
    // the bar. Closed, the compact bar (no labels, no separator) is unobstructed.
    const el = await toolbar(
      page,
      colorScheme,
      `count=12&section=filter&def=${def(FILTER_DEF)}`,
      460,
      false,
    );
    await expect(el).toHaveScreenshot(`toolbar-compact-${colorScheme}.png`);
  });
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
  await toolbar(
    page,
    "light",
    `clean=1&count=12&recordFixture=1&expose=1&def=${def(FILTER_DEF)}`,
  );
  await page.getByRole("button", { name: "Query actions" }).click();
  await page.getByRole("menuitem", { name: "Base" }).click();
  // The query's own base is checked; the tables come from the schema.
  await expect(
    page.getByRole("menuitemradio", { name: "track" }),
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
  await toolbar(
    page,
    "light",
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
    "#track\njazz playcount:<100\nrating:>=4 !genre:duplicate file.deletion:@null",
  );

  // Editing it writes back to the working definition…
  await page.getByPlaceholder("Querydown").fill("#album $title");
  expect((await liveDefinition(page))?.full).toBe("#album $title");

  // …and picking a base table again drops back to the builder.
  await page.getByRole("button", { name: "Query actions" }).click();
  await page.getByRole("menuitem", { name: "Base" }).click();
  await page.getByRole("menuitemradio", { name: "track" }).click();
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
  await toolbar(
    page,
    "light",
    `clean=1&count=12&def=${def(FILTER_DEF)}&expose=1`,
  );
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
