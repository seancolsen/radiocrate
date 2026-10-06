import { test, expect } from "@playwright/test";
import { SCHEMES, openStory, snapshot } from "./harness";

// The query page's parts, each on its own: the toolbar in its five states, the
// section builders without the toolbar above them, the results grid, and a
// row's context menu.

for (const colorScheme of SCHEMES) {
  // Saved query with nothing to undo, redo or save, no builder open: the
  // section toggles inactive, "12 results" and Refresh at the far right.
  test(`query-builder/collapsed - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "query-builder/collapsed", colorScheme);
    await expect(stage.getByText("12 results")).toBeVisible();
    await expect(stage.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(stage.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/collapsed", colorScheme),
    );
  });

  // Filter section open on a query that can step both ways and whose last save
  // failed: Undo, Redo and Save behind their separator, the active blue split
  // button with its ⋮, and the builder line (custom input + "vetted" tab).
  test(`query-builder/filter-open - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "query-builder/filter-open",
      colorScheme,
    );
    await expect(stage.getByRole("button", { name: "vetted" })).toBeVisible();
    for (const name of ["Undo", "Redo", "Save"]) {
      await expect(stage.getByRole("button", { name })).toBeVisible();
    }
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/filter-open", colorScheme),
    );
  });

  // Compact (≤ 500px): the section buttons drop their labels.
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

  // A new query, never saved: Save alone, with nothing yet to undo.
  test(`query-builder/new - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "query-builder/new", colorScheme);
    await expect(stage.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(stage.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/new", colorScheme),
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
  // A playlist's toolbar, Sort open on "Playlist order": no Save, and the
  // built-in preset's tab (with no Reshuffle) in the builder line.
  test(`query-builder/playlist - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "query-builder/playlist", colorScheme);
    await expect(stage.getByText("Playlist order")).toBeVisible();
    await expect(
      stage.getByRole("button", { name: "Playlist actions" }),
    ).toBeVisible();
    await expect(stage.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/playlist", colorScheme),
    );
  });

  // A playlist's sort options: "Playlist order" first, and checked.
  test(`sort-options/playlist - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "sort-options/playlist", colorScheme);
    await expect(
      page.getByRole("menuitemradio", { name: "Playlist order" }),
    ).toBeChecked();
    await expect(stage).toHaveScreenshot(
      snapshot("sort-options/playlist", colorScheme),
    );
  });

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

  // A playlist's filter, applying a condition: its two buttons at the foot.
  test(`filter-builder/playlist - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "filter-builder/playlist", colorScheme);
    for (const name of ["Remove these tracks", "Keep only these tracks"]) {
      await expect(stage.getByRole("button", { name })).toBeEnabled();
    }
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/playlist", colorScheme),
    );
  });

  // A playlist's custom sort: the commit button under it.
  test(`sort-builder/playlist - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "sort-builder/playlist", colorScheme);
    await expect(
      stage.getByRole("button", {
        name: "Commit this track order to playlist",
      }),
    ).toBeEnabled();
    await expect(stage).toHaveScreenshot(
      snapshot("sort-builder/playlist", colorScheme),
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

  // The now-playing track's row: a blue rectangle drawn around it, over the
  // cells, plus the faint wash across the row inside it.
  test(`results/playing-row - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "results/playing-row", colorScheme);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("results/playing-row", colorScheme),
    );
  });

  // The same row on a scrolling grid: the ring runs the full width and the
  // scrollbar thumb sits over it, so no cell content is clipped.
  test(`results/playing-row-scrollbar - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "results/playing-row-scrollbar",
      colorScheme,
    );
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("results/playing-row-scrollbar", colorScheme),
    );
  });

  // A playlist's row in hand: the accent drop line between the first two
  // rows, where it would land, over the rows' own separators.
  test(`results/playlist-drop - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "results/playlist-drop", colorScheme);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("results/playlist-drop", colorScheme),
    );
  });

  // Multi-select mode: the floating toolbar over the rows, counting the two
  // selected ones. Its actions menu is the row menu's body over the whole
  // selection, minus the "Select multiple" entry that put the mode on.
  test(`results/multi-select - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "results/multi-select", colorScheme);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(stage.getByText("2 records")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("results/multi-select", colorScheme),
    );

    await stage.getByRole("button", { name: "Selection actions" }).click();
    await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
      "Edit track",
      "Edit album",
      "Show album tracks",
      "Rate track",
    ]);
  });

  // A row's context menu: one "Edit {table}" entry per table whose primary key
  // the row carries, "Show album tracks" for an album, "Rate track" and "Add
  // to playlist…" for a track, then "Select multiple". Shot through the menu (it portals out of the
  // stage).
  test(`result-row/context-menu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/context-menu", colorScheme);
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit track",
      "Edit album",
      "Show album tracks",
      "Rate track",
      "Add to playlist…",
      "Select multiple",
    ]);
    await expect(menu).toHaveScreenshot(
      snapshot("result-row/context-menu", colorScheme),
    );
  });

  // The same menu on a playlist's page: "Remove from playlist" before
  // "Select multiple".
  test(`result-row/playlist-context-menu - ${colorScheme}`, async ({
    page,
  }) => {
    await openStory(page, "result-row/playlist-context-menu", colorScheme);
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit track",
      "Rate track",
      "Add to playlist…",
      "Remove from playlist",
      "Select multiple",
    ]);
    await expect(menu).toHaveScreenshot(
      snapshot("result-row/playlist-context-menu", colorScheme),
    );
  });

  // The "Rate track" submenu opened out: one entry per rating, lowest value
  // first, each reading value, symbol and description. Shot through the nested
  // panel — it sits beside the menu that holds it, outside its box.
  test(`result-row/rate-submenu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/rate-submenu", colorScheme);
    const menu = page.getByRole("menu").first();
    await menu.getByRole("menuitem", { name: "Rate track" }).click();
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit track",
      "Edit album",
      "Show album tracks",
      "Rate track",
      "1: 🗑️ (Skip)",
      "2: ✔️ (Like)",
      "3: ⭐ (Prefer)",
      "4: ❤️ (Love)",
      "Add to playlist…",
      "Select multiple",
    ]);
    await expect(menu.getByRole("menu")).toHaveScreenshot(
      snapshot("result-row/rate-submenu", colorScheme),
    );
  });

  // The same submenu with the rating query still in flight: the note that
  // stands in for rows that aren't there yet.
  test(`result-row/rate-submenu-loading - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/rate-submenu-loading", colorScheme);
    const menu = page.getByRole("menu").first();
    await menu.getByRole("menuitem", { name: "Rate track" }).click();
    await expect(menu.getByText("Loading…")).toBeVisible();
    await expect(menu.getByRole("menu")).toHaveScreenshot(
      snapshot("result-row/rate-submenu-loading", colorScheme),
    );
  });

  // The "Add to playlist…" dialog: only playlists, in their folders, with the
  // explorer's open folders open. Shot through the dialog (it portals out of
  // the stage).
  test(`add-to-playlist/modal - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "add-to-playlist/modal", colorScheme);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("treeitem")).toHaveText([
      "Favorites",
      "Road trip",
      "Coast drive",
      "Desert night",
      "Sunday morning",
      "Parties",
      "Late night",
    ]);
    await expect(dialog).toHaveScreenshot(
      snapshot("add-to-playlist/modal", colorScheme),
    );
  });
}
