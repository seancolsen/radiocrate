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

  // A syntax error in the open filter's text: the input bordered in red with
  // the spot marked, the Filter toggle marked, and the error strip with the
  // line marked. Nothing to "Show": the problem is already on screen.
  test(`query-builder/filter-problem - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "query-builder/filter-problem",
      colorScheme,
    );
    const strip = stage.getByTestId("query-diagnostic");
    await expect(strip).toContainText("line 1, column 11");
    await expect(strip.getByRole("button", { name: "Show" })).toHaveCount(0);
    await expect(stage.getByRole("textbox")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    // The end of the input, where the value's missing, is marked in the
    // editor itself.
    await expect(stage.locator(".cm-qd-problem-point")).toHaveCount(1);
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/filter-problem", colorScheme),
    );
  });

  // A problem in a collapsed preset: its row outlined in red, and "Show" on
  // the strip, which expands it — at which the strip steps aside for the
  // preset's own editor.
  test(`query-builder/preset-problem - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "query-builder/preset-problem",
      colorScheme,
    );
    const strip = stage.getByTestId("query-diagnostic");
    await expect(strip).toContainText("Preset “vetted”");
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/preset-problem", colorScheme),
    );
    await strip.getByRole("button", { name: "Show" }).click();
    await expect(
      stage.getByRole("button", { name: "vetted", expanded: true }),
    ).toBeVisible();
    await expect(strip).toHaveCount(0);
  });

  // A problem with no location, every builder closed: the strip alone.
  test(`query-builder/compile-problem - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "query-builder/compile-problem",
      colorScheme,
    );
    await expect(stage.getByTestId("query-diagnostic")).toContainText(
      "not found within table",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/compile-problem", colorScheme),
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

  // A new query, never saved: Save alone, with nothing yet to undo, and the
  // filter builder open with the caret in it.
  test(`query-builder/new - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "query-builder/new", colorScheme);
    await expect(stage.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(stage.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(stage.getByPlaceholder("Filter")).toBeFocused();
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/new", colorScheme),
    );
  });

  // A new query, untouched: its base beside its label, over "Show all
  // results", where the rows would be.
  test(`query-page/new - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "query-page/new", colorScheme);
    await expect(stage.getByLabel("Base")).toHaveValue("track");
    await expect(
      stage.getByRole("button", { name: "Show all results" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("query-page/new", colorScheme),
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

  // The "Export data" dialog: the Rows choice, the folded column list and the
  // two ways out. Shot through the dialog (it portals out of the stage).
  test(`export-data/modal - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "export-data/modal", colorScheme);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Rows")).toBeFocused();
    await expect(dialog.getByLabel("Rows")).toHaveValue("all");
    await expect(dialog.getByText("Columns")).toContainText("(3/4)");
    await expect(
      dialog.getByRole("button", { name: "Check all", exact: true }),
    ).toBeHidden();
    await expect(dialog).toHaveScreenshot(
      snapshot("export-data/modal", colorScheme),
    );
  });

  // The column list unfolded: Check all / Uncheck all beside its summary, then
  // a line per column, its sample, and the displayed/raw choice for a formatted
  // one. No rows selected, so no Rows field, and the Columns summary takes
  // focus instead.
  test(`export-data/columns - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "export-data/columns", colorScheme);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Rows")).toHaveCount(0);
    const summary = dialog.getByText("Columns");
    await expect(summary).toBeFocused();
    await summary.click();
    await expect(
      dialog.getByLabel("Column 1", { exact: true }),
    ).not.toBeChecked();
    await expect(dialog.getByLabel("Column 3 data")).toHaveValue("raw");
    // The buttons beside the summary don't fold the list back up.
    await dialog
      .getByRole("button", { name: "Check all", exact: true })
      .click();
    await expect(dialog.getByLabel("Column 0", { exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(dialog).toHaveScreenshot(
      snapshot("export-data/columns", colorScheme),
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

  // A write of a change failed: red ✱ + revert + save appear, and the checkbox
  // (the change) is checked.
  test(`filter-builder/preset-save-failed - ${colorScheme}`, async ({
    page,
  }) => {
    const stage = await openStory(
      page,
      "filter-builder/preset-save-failed",
      colorScheme,
    );
    await expect(
      stage.getByRole("button", { name: "Save preset" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/preset-save-failed", colorScheme),
    );
  });

  // Presets each on a line under the custom input: closed ones with Inline and
  // Remove beside the name, an open one with Inline alone, and its usage at the
  // far right.
  test(`filter-builder/presets - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "filter-builder/presets", colorScheme);
    await expect(stage.getByText("in 1 query")).toBeVisible();
    await expect(
      stage.getByRole("button", { name: "Inline into custom" }),
    ).toHaveCount(3);
    await expect(
      stage.getByRole("button", { name: "Remove preset" }),
    ).toHaveCount(2);
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/presets", colorScheme),
    );
  });

  // Two presets open at once.
  test(`filter-builder/presets-expanded - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "filter-builder/presets-expanded",
      colorScheme,
    );
    await expect(stage.getByPlaceholder("Preset name")).toHaveCount(2);
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/presets-expanded", colorScheme),
    );
  });

  // "Add new": blank, unsaved and open, with the caret in its name.
  test(`filter-builder/new-preset - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "filter-builder/new-preset",
      colorScheme,
    );
    await expect(stage.getByPlaceholder("Preset name")).toBeFocused();
    await expect(
      stage.getByRole("button", { name: "Create preset" }),
    ).toBeDisabled();
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/new-preset", colorScheme),
    );
  });

  // A sort section holding one preset, closed.
  test(`sort-builder/preset - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "sort-builder/preset", colorScheme);
    await expect(
      stage.getByRole("button", { name: /by artist/ }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("sort-builder/preset", colorScheme),
    );
  });

  // The filter section's options menu, ending in "Add new" and "Manage presets".
  test(`section-options/filter - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "section-options/filter", colorScheme);
    await expect(
      page.getByRole("menuitem", { name: "Manage presets" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("section-options/filter", colorScheme),
    );
  });

  // Sort built-in: the Shuffle preset beside its Reshuffle button.
  test(`sort-builder/shuffle - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "sort-builder/shuffle", colorScheme);
    await expect(
      stage.getByRole("button", { name: "Reshuffle" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("sort-builder/shuffle", colorScheme),
    );
  });

  // The preset manager as it opens: every table collapsed to its heading and
  // preset count, those with none included.
  test(`preset-manager/collapsed - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "preset-manager/collapsed",
      colorScheme,
    );
    await expect(stage.getByRole("heading", { name: /^artist/ })).toBeVisible();
    await expect(
      stage.getByRole("heading", { name: "track 4 presets" }),
    ).toBeVisible();
    await expect(stage.getByText("Default")).toHaveCount(0);
    await expect(stage).toHaveScreenshot(
      snapshot("preset-manager/collapsed", colorScheme),
    );
  });

  // Two tables' presets by section, the album's empty sections ("None")
  // included, with the Default badges.
  test(`preset-manager/basic - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "preset-manager/basic", colorScheme);
    await expect(
      stage.getByRole("heading", { name: "album 1 preset" }),
    ).toBeVisible();
    await expect(
      stage.getByRole("heading", { name: "track 4 presets" }),
    ).toBeVisible();
    await expect(stage.getByText("Default")).toHaveCount(3);
    await expect(stage).toHaveScreenshot(
      snapshot("preset-manager/basic", colorScheme),
    );
  });

  // Phone width.
  test(`preset-manager/narrow - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "preset-manager/narrow", colorScheme);
    await expect(
      stage.getByRole("button", { name: "New filter preset for track" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("preset-manager/narrow", colorScheme),
    );
  });

  // "vetted" and "loved" open at once, with an edit to the first on its way to
  // the backend: nothing to do about it, so no ✱ and no save.
  test(`preset-manager/expanded - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "preset-manager/expanded", colorScheme);
    await expect(stage.getByPlaceholder("Preset name")).toHaveCount(2);
    await expect(stage.getByLabel("Unsaved changes")).toHaveCount(0);
    await expect(stage).toHaveScreenshot(
      snapshot("preset-manager/expanded", colorScheme),
    );
  });

  // Hovering an open preset's heading, right of its ⋮ — which toggles it too:
  // the accent border around the whole preset.
  test(`preset-manager/hover - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "preset-manager/expanded", colorScheme);
    const toggle = stage.getByRole("button", { name: /^vetted/ });
    const box = (await toggle.boundingBox())!;
    await page.mouse.move(box.x + 400, box.y + box.height / 2);
    await expect(stage).toHaveScreenshot(
      snapshot("preset-manager/hover", colorScheme),
    );
  });

  // New presets at the top of their sections, in the editor a saved one
  // opens: one written from scratch, one a copy.
  test(`preset-manager/draft - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "preset-manager/draft", colorScheme);
    await expect(
      stage.getByRole("button", { name: "Create preset" }),
    ).toHaveCount(2);
    await expect(stage.getByLabel("Preset name").first()).toHaveValue(/ copy$/);
    await expect(stage).toHaveScreenshot(
      snapshot("preset-manager/draft", colorScheme),
    );
  });

  // Deleting "vetted", which a saved query and an open playlist use: the
  // confirmation names both.
  test(`preset-manager/delete - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "preset-manager/delete", colorScheme);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Road Trip")).toBeVisible();
    await expect(dialog.getByText("Lemonade")).toBeVisible();
    await expect(dialog).toHaveScreenshot(
      snapshot("preset-manager/delete", colorScheme),
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
      "Artists",
    ]);
  });

  // A row's context menu: one "Edit {table}" entry per table whose primary key
  // the row carries, "Show album tracks" for an album, "Rate track" and "Add
  // to playlist…" for a track, the track's "Artists" (but not its "Album",
  // whose entries are already there), then "Select multiple". Shot through the
  // menu (it portals out of the stage).
  test(`result-row/context-menu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/context-menu", colorScheme);
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit track",
      "Edit album",
      "Show album tracks",
      "Rate track",
      "Add to playlist…",
      "Artists",
      "Select multiple",
    ]);
    await expect(menu).toHaveScreenshot(
      snapshot("result-row/context-menu", colorScheme),
    );
  });

  // The same menu on a playlist's page, on a track alone: "Remove from
  // playlist", then the track's "Artists" and "Album".
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
      "Artists",
      "Album",
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
      "Artists",
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

  // A track's "Artists" submenu, opened out: the artists credited on it, in
  // credit order. Shot through the nested panel.
  test(`result-row/artists-submenu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/artists-submenu", colorScheme);
    const menu = page.getByRole("menu").first();
    await menu.getByRole("menuitem", { name: "Artists" }).click();
    const artists = menu.getByRole("menu");
    await expect(artists.getByRole("menuitem")).toHaveText([
      "Beyoncé",
      "Jack White",
    ]);
    await expect(artists).toHaveScreenshot(
      snapshot("result-row/artists-submenu", colorScheme),
    );
  });

  // The same submenu with its credits still loading: a spinner in place of
  // the artists.
  test(`result-row/artists-submenu-loading - ${colorScheme}`, async ({
    page,
  }) => {
    await openStory(page, "result-row/artists-submenu-loading", colorScheme);
    const menu = page.getByRole("menu").first();
    await menu.getByRole("menuitem", { name: "Artists" }).click();
    const artists = menu.getByRole("menu");
    await expect(artists.getByText("Loading…")).toBeVisible();
    await expect(artists).toHaveScreenshot(
      snapshot("result-row/artists-submenu-loading", colorScheme),
    );
  });

  // One artist in it, opened out: what an artist's own row offers.
  test(`result-row/artist-submenu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/artist-submenu", colorScheme);
    const menu = page.getByRole("menu").first();
    await menu.getByRole("menuitem", { name: "Artists" }).click();
    await menu.getByRole("menuitem", { name: "Beyoncé" }).click();
    const artist = menu.getByRole("menu").getByRole("menu");
    await expect(artist.getByRole("menuitem")).toHaveText([
      "Edit artist",
      "Show artist tracks",
      "Show artist albums",
    ]);
    await expect(artist).toHaveScreenshot(
      snapshot("result-row/artist-submenu", colorScheme),
    );
  });

  // A track's "Album" submenu, opened out: what its album's own row offers.
  test(`result-row/album-submenu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/album-submenu", colorScheme);
    const menu = page.getByRole("menu").first();
    await menu.getByRole("menuitem", { name: "Album", exact: true }).click();
    const album = menu.getByRole("menu");
    await expect(album.getByRole("menuitem")).toHaveText([
      "Edit album",
      "Show album tracks",
      "Artists",
    ]);
    await expect(album).toHaveScreenshot(
      snapshot("result-row/album-submenu", colorScheme),
    );
  });

  // An artist row's own context menu.
  test(`result-row/artist-context-menu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/artist-context-menu", colorScheme);
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit artist",
      "Show artist tracks",
      "Show artist albums",
      "Select multiple",
    ]);
    await expect(menu).toHaveScreenshot(
      snapshot("result-row/artist-context-menu", colorScheme),
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

// A section toggle wears a tooltip only while the narrow toolbar has dropped
// its text label — and then the label is its accessible name too.
test("a section toggle's tooltip stands in for its hidden label", async ({
  page,
}) => {
  const tooltip = page.getByTestId("tooltip");

  let stage = await openStory(page, "query-builder/filter-open", "light");
  let filter = stage.getByRole("button", { name: "Filter", pressed: true });
  await expect(filter).not.toHaveAttribute("aria-label");
  await filter.hover();
  await page.waitForTimeout(800);
  await expect(tooltip).toHaveCount(0);

  stage = await openStory(page, "query-builder/filter-open-narrow", "light");
  filter = stage.getByRole("button", { name: "Filter", pressed: true });
  await expect(filter).toHaveAttribute("aria-keyshortcuts", "Control+Shift+F");
  await filter.hover();
  await expect(tooltip).toHaveText("FilterCtrl+Shift+F");
});
