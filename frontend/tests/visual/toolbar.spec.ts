import { test, expect, type Page } from "@playwright/test";
import { FILTER_DEF, PRESETS_FIXTURE, QUERIES_FIXTURE } from "./fixtures";
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
  await expect(items).toHaveText(["Rename", "Duplicate", "View SQL", "Delete"]);

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
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  expect(
    await page.evaluate(
      () => (window as unknown as AppWindow).__appStore.state.renaming,
    ),
  ).not.toBeNull();
});
