import { test, expect, type Page } from "@playwright/test";
import {
  FILTER_DEF,
  PRESETS_FIXTURE,
  QUERIES_FIXTURE,
  VETTED_PRESET_ID,
} from "./fixtures";

/** RPC mock returning the query + "vetted" preset fixtures (see toolbar.spec). */
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

/** Per-test setup + navigate; returns the toolbar element locator. */
async function toolbar(
  page: Page,
  colorScheme: "light" | "dark",
  query: string,
  width = 1280,
) {
  await mockRpc(page);
  await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/?sidebar=open&tabs=Lemonade&${query}`);
  await page.evaluate(() => document.fonts.ready);
  const el = page.getByTestId("query-toolbar");
  await expect(el).toBeVisible();
  return el;
}

/** A sort section holding the built-in Shuffle preset (fixed seed → stable). */
const SHUFFLE_DEF = {
  base: "track",
  filter: { custom: "", presets: [] },
  sort: { builtin: { preset: "shuffle", seed: "TESTSEED0000000000AA" } },
  display: { custom: "" },
};

for (const colorScheme of ["light", "dark"] as const) {
  // Filter builder, preset collapsed: custom input beside the "vetted" preset
  // tab (mirrors filter_builder/preset_collapsed.png).
  test(`builder filter collapsed - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `section=filter&def=${def(FILTER_DEF)}`,
    );
    await expect(page.getByRole("button", { name: "vetted" })).toBeVisible();
    await expect(el).toHaveScreenshot(
      `builder-filter-collapsed-${colorScheme}.png`,
    );
  });

  // Preset expanded, no unsaved edits: the inline editor (name + Apply-by-default
  // + definition), no star/revert/save (mirrors preset_expanded.png).
  test(`builder preset expanded - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `section=filter&expand=${VETTED_PRESET_ID}&def=${def(FILTER_DEF)}`,
    );
    await expect(page.getByPlaceholder("Preset name")).toBeVisible();
    await expect(el).toHaveScreenshot(
      `builder-preset-expanded-${colorScheme}.png`,
    );
  });

  // Preset dirty via "Apply by default" toggled on: red ✱ + revert + save appear,
  // checkbox checked (mirrors preset_unsaved_default.png).
  test(`builder preset dirty default - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `section=filter&expand=${VETTED_PRESET_ID}&editDefault=1&def=${def(FILTER_DEF)}`,
    );
    await expect(page.getByPlaceholder("Preset name")).toBeVisible();
    await expect(el).toHaveScreenshot(
      `builder-preset-dirty-default-${colorScheme}.png`,
    );
  });

  // Preset renamed (dirty): name field shows "base", star + revert + save shown
  // (mirrors preset_unsaved_rename_narrow.png, wide here).
  test(`builder preset renamed - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `section=filter&expand=${VETTED_PRESET_ID}&editName=base&def=${def(FILTER_DEF)}`,
    );
    await expect(page.getByPlaceholder("Preset name")).toHaveValue("base");
    await expect(el).toHaveScreenshot(
      `builder-preset-renamed-${colorScheme}.png`,
    );
  });

  // Narrow: the "Apply by default" checkbox wraps onto its own line below the
  // name row (mirrors preset_expanded_narrow.png).
  test(`builder preset narrow - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `section=filter&expand=${VETTED_PRESET_ID}&def=${def(FILTER_DEF)}`,
      560,
    );
    await expect(page.getByPlaceholder("Preset name")).toBeVisible();
    await expect(el).toHaveScreenshot(
      `builder-preset-narrow-${colorScheme}.png`,
    );
  });

  // Sort built-in: the Shuffle preset tab beside its Reshuffle button.
  test(`builder sort shuffle - ${colorScheme}`, async ({ page }) => {
    const el = await toolbar(
      page,
      colorScheme,
      `section=sort&def=${def(SHUFFLE_DEF)}`,
    );
    await expect(page.getByRole("button", { name: "Reshuffle" })).toBeVisible();
    await expect(el).toHaveScreenshot(
      `builder-sort-shuffle-${colorScheme}.png`,
    );
  });
}
