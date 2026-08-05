import { test, expect } from "@playwright/test";
import { SCHEMES, openStory, snapshot } from "./harness";

// The query page's parts, each on its own: the toolbar in its four states, the
// section builders without the toolbar above them, the results grid, and a
// row's context menu.

for (const colorScheme of SCHEMES) {
  // Saved (clean) query, no builder open: no Save button, the section toggles
  // inactive, "12 results" at the far right.
  test(`query-builder/collapsed - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "query-builder/collapsed", colorScheme);
    await expect(stage.getByText("12 results")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/collapsed", colorScheme),
    );
  });

  // Filter section open + unsaved: the Save button, the active blue split
  // button with its ⋮, and the builder line (custom input + "vetted" tab).
  test(`query-builder/filter-open - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "query-builder/filter-open",
      colorScheme,
    );
    await expect(stage.getByRole("button", { name: "vetted" })).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/filter-open", colorScheme),
    );
  });

  // Compact (≤ 500px): the section buttons drop their labels and the
  // run/filter separator is hidden.
  test(`query-builder/filter-open-narrow - ${colorScheme}`, async ({
    page,
  }) => {
    const stage = await openStory(
      page,
      "query-builder/filter-open-narrow",
      colorScheme,
    );
    await expect(stage.getByRole("button", { name: "vetted" })).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/filter-open-narrow", colorScheme),
    );
  });

  // Full-Querydown mode: one "Querydown" toggle (no ⋮ — there are no sections
  // to configure) over the whole-query editor.
  test(`query-builder/querydown - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "query-builder/querydown", colorScheme);
    await expect(stage.getByPlaceholder("Querydown")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/querydown", colorScheme),
    );
  });

  // The wrench menu with its Base submenu open: the schema's tables as an
  // exclusive choice over the "Full Querydown" escape hatch.
  test(`query-builder/actions-menu - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "query-builder/actions-menu",
      colorScheme,
    );
    await page.getByRole("menuitem", { name: "Base" }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "Full Querydown" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/actions-menu", colorScheme),
    );
  });

  // Preset expanded, no unsaved edits: the inline editor (name +
  // apply-by-default + definition), no star/revert/save.
  test(`filter-builder/preset-expanded - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "filter-builder/preset-expanded",
      colorScheme,
    );
    await expect(stage.getByPlaceholder("Preset name")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/preset-expanded", colorScheme),
    );
  });

  // Narrow: the "Apply by default" checkbox wraps onto its own line below the
  // name row.
  test(`filter-builder/preset-expanded-narrow - ${colorScheme}`, async ({
    page,
  }) => {
    const stage = await openStory(
      page,
      "filter-builder/preset-expanded-narrow",
      colorScheme,
    );
    await expect(stage.getByPlaceholder("Preset name")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/preset-expanded-narrow", colorScheme),
    );
  });

  // Made dirty by toggling "Apply by default" on: red ✱ + revert + save appear,
  // and the checkbox is checked.
  test(`filter-builder/modified-preset - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "filter-builder/modified-preset",
      colorScheme,
    );
    await expect(
      stage.getByRole("button", { name: "Save preset" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/modified-preset", colorScheme),
    );
  });

  // Sort built-in: the Shuffle preset tab beside its Reshuffle button.
  test(`sort-builder/shuffle - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "sort-builder/shuffle", colorScheme);
    await expect(
      stage.getByRole("button", { name: "Reshuffle" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("sort-builder/shuffle", colorScheme),
    );
  });

  // The canned Lemonade rows: the grid's columns, artist pills, per-column
  // fonts/colors/alignment, formatters and separators. The rows are canvas
  // paint, so the wait is on the engine's readiness marker, not on row text.
  test(`results/basic - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "results/basic", colorScheme);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("results/basic", colorScheme),
    );
  });

  // A row's context menu: one "Edit {table}" entry per table whose primary key
  // the row carries. Shot through the menu (it portals out of the stage).
  test(`result-row/context-menu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/context-menu", colorScheme);
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit track",
      "Edit album",
    ]);
    await expect(menu).toHaveScreenshot(
      snapshot("result-row/context-menu", colorScheme),
    );
  });
}
