import { test, expect } from "@playwright/test";
import { SCHEMES, openStory, snapshot } from "./harness";

// The query page's parts, each on its own: the toolbar in its five states, the
// section builders without the toolbar above them, the results grid, and a
// row's context menu.

for (const colorScheme of SCHEMES) {
  // Saved query with nothing to undo, redo or save, no builder open: the
  // section toggles inactive, "12 tracks" and Refresh at the far right.
  test(`query-builder/collapsed - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "query-builder/collapsed", colorScheme);
    await expect(stage.getByText("12 tracks")).toBeVisible();
    await expect(stage.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(stage.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/collapsed", colorScheme),
    );
  });

  // Rows overtaken by a change made on another device: a dot on Refresh,
  // which says why in its tooltip.
  test(`query-builder/changed-elsewhere - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "query-builder/changed-elsewhere",
      colorScheme,
    );
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/changed-elsewhere", colorScheme),
    );
    await stage.getByRole("button", { name: "Refresh" }).hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Changed on another device",
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
      "does not exist",
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

  // A new query, untouched: "Show all results", where the rows would be.
  test(`query-page/new - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "query-page/new", colorScheme);
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

  test(`query-builder/base-schemas - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "query-builder/base-schemas",
      colorScheme,
    );
    await page.getByRole("menuitem", { name: "Base" }).click();
    // Another schema's tables are in a submenu of its own.
    await page.getByRole("menuitem", { name: "lastfm" }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "scrobble" }),
    ).toBeChecked();
    await expect(stage).toHaveScreenshot(
      snapshot("query-builder/base-schemas", colorScheme),
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

  // Narrow: the checkbox and Inline button wrap together under the name.
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

  // Presets each on a line under the custom input: closed ones with Remove
  // beside the name, an open one with Inline in its editor, and its usage and
  // Remove at the far right.
  test(`filter-builder/presets - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "filter-builder/presets", colorScheme);
    await expect(stage.getByText("in 1 query")).toBeVisible();
    await expect(
      stage.getByRole("button", { name: "Inline into custom" }),
    ).toHaveCount(1);
    await expect(
      stage.getByRole("button", { name: "Remove preset" }),
    ).toHaveCount(3);
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/presets", colorScheme),
    );
  });

  // A basic-text filter and an open basic-text preset: each with the `abc`
  // toggle on its left, and words left unhighlighted.
  test(`filter-builder/basic-text - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "filter-builder/basic-text",
      colorScheme,
    );
    await expect(
      stage.getByRole("button", { name: "Filter strategy" }),
    ).toHaveCount(2);
    await expect(stage.getByPlaceholder("Preset name")).toHaveValue(
      "live recordings",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/basic-text", colorScheme),
    );
  });

  // The strategy toggle's tooltip says what's in force and what a click
  // offers; its menu has both strategies, the one in force checked.
  test(`filter-builder/strategy - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "filter-builder/strategy", colorScheme);
    await expect(stage.getByPlaceholder("Querydown filter")).toBeVisible();
    const toggle = stage.getByRole("button", { name: "Filter strategy" });
    await toggle.hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Filtering with Querydown conditions. Click to change to basic text.",
    );
    await toggle.click();
    await expect(
      page.getByRole("menuitemradio", { name: "Querydown" }),
    ).toBeChecked();
    await expect(stage).toHaveScreenshot(
      snapshot("filter-builder/strategy", colorScheme),
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
  // scrollbar thumb sits over it, so no cell content is clipped. The thumb
  // shows while the mouse is over the rows — here, over the thumb itself,
  // where no row is hovered.
  test(`results/playing-row-scrollbar - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "results/playing-row-scrollbar",
      colorScheme,
    );
    const canvas = page.locator("canvas[data-rows]");
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width - 6, box.y + 10);
    await expect(canvas).toHaveAttribute("data-thumb", "shown");
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

  // A swipe left under way on a row of a two-row selection: both rows come away
  // together, over the accent band naming what letting go will do.
  test(`results/row-swipe - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "results/row-swipe", colorScheme);
    const canvas = page.locator("canvas[data-rows]");
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const y = box.y + 54;
    const touch = (type: "touchStart" | "touchMove", x: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: [{ x: box.x + x, y }],
      });
    await touch("touchStart", 700);
    for (const x of [680, 640, 600]) await touch("touchMove", x);
    await expect(stage).toHaveScreenshot(
      snapshot("results/row-swipe", colorScheme),
    );
  });

  // A swipe right under way on a row of a two-row selection: both rows come
  // away together, over the band at the left naming the queue.
  test(`results/row-swipe-right - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "results/row-swipe-right", colorScheme);
    const canvas = page.locator("canvas[data-rows]");
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const y = box.y + 54;
    const touch = (type: "touchStart" | "touchMove", x: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: [{ x: box.x + x, y }],
      });
    await touch("touchStart", 100);
    for (const x of [120, 160, 200]) await touch("touchMove", x);
    await expect(stage).toHaveScreenshot(
      snapshot("results/row-swipe-right", colorScheme),
    );
  });

  // Queued tracks' rows: the playing row's ring, dashed, and a badge on each
  // numbering its place in the queue — tucked inside the ring on the first
  // row, which has nothing above it to straddle.
  test(`results/queued-rows - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "results/queued-rows", colorScheme);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("results/queued-rows", colorScheme),
    );
  });

  // A lone queued track: the dashed ring, with no badge.
  test(`results/queued-row - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "results/queued-row", colorScheme);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("results/queued-row", colorScheme),
    );
  });

  // Rows pulled down past the top, far enough that letting go would refresh
  // them: the spinner's arc at its fullest, in the gap above the first row.
  test(`results/pull-refresh - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "results/pull-refresh", colorScheme);
    const canvas = page.locator("canvas[data-rows]");
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + 400;
    const touch = (type: "touchStart" | "touchMove", y: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: [{ x, y: box.y + y }],
      });
    await touch("touchStart", 20);
    for (const y of [40, 80, 120, 160, 200]) await touch("touchMove", y);
    await expect(stage).toHaveScreenshot(
      snapshot("results/pull-refresh", colorScheme),
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
      "Delete 2 tracks…",
      "Delete 2 albums…",
      "Artists",
    ]);
  });

  // Range mode: the toggle on, three rows selected from the origin (row 1,
  // marked by the bar down its left edge) to row 3.
  test(`results/multi-select-range - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "results/multi-select-range",
      colorScheme,
    );
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await expect(stage.getByText("3 records")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("results/multi-select-range", colorScheme),
    );
  });

  // A row's context menu: one "Edit {table}" entry per table whose primary key
  // the row carries, "Show album tracks" for an album, "Rate track", "Queue
  // track" and "Add to playlist…" for a track, a "Delete {table}…" entry per
  // table, the track's "Artists" (but not its "Album", whose entries are
  // already there), then "Select multiple".
  // Shot through the menu (it portals out of the stage).
  test(`result-row/context-menu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/context-menu", colorScheme);
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit track",
      "Edit album",
      "Show album tracks",
      "Rate track",
      "Queue track",
      "Add to playlist…",
      "Delete track…",
      "Delete album…",
      "Artists",
      "Select multiple",
    ]);
    await expect(menu).toHaveScreenshot(
      snapshot("result-row/context-menu", colorScheme),
    );
  });

  // The same menu on a playlist's page, on a track alone: "Remove from
  // playlist" (with its command's Delete shortcut), then the track's
  // "Artists" and "Album".
  test(`result-row/playlist-context-menu - ${colorScheme}`, async ({
    page,
  }) => {
    await openStory(page, "result-row/playlist-context-menu", colorScheme);
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit track",
      "Rate track",
      "Queue track",
      "Add to playlist…",
      "Remove from playlistDelete",
      "Delete track…",
      "Artists",
      "Album",
      "Select multiple",
    ]);
    await expect(menu).toHaveScreenshot(
      snapshot("result-row/playlist-context-menu", colorScheme),
    );
  });

  // The same menu while other tracks are queued, the row's own among them:
  // queue it ahead of them or behind them, or take it out of the queue.
  test(`result-row/queue-context-menu - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "result-row/queue-context-menu", colorScheme);
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit track",
      "Edit album",
      "Show album tracks",
      "Rate track",
      "Queue track next",
      "Queue after 2 queued tracks",
      "Remove from queue",
      "Add to playlist…",
      "Delete track…",
      "Delete album…",
      "Artists",
      "Select multiple",
    ]);
    await expect(menu).toHaveScreenshot(
      snapshot("result-row/queue-context-menu", colorScheme),
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
      "-1: 🗑️ (Skip)",
      "0: ✔️ (Like)",
      "1: ⭐ (Prefer)",
      "2: ❤️ (Love)",
      "Queue track",
      "Add to playlist…",
      "Delete track…",
      "Delete album…",
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
      "Delete artist…",
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

  // The "Delete records" dialog on an album whose tracks are to go with it:
  // one choice made, the records that follow from it with no choice (checked,
  // dimmed), and the orphans left as they are.
  test(`record-delete/album - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "record-delete/album", colorScheme);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText("Delete album");
    await expect(
      dialog.getByRole("checkbox", { name: "Delete 9 tracks" }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: "Delete 10 credits" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("checkbox", { name: "Delete 9 file records" }),
    ).not.toBeChecked();
    await expect(dialog).toHaveScreenshot(
      snapshot("record-delete/album", colorScheme),
    );
  });

  // The dialog on an album whose files are to go with it, leaving its folder
  // with cover art and rip files: the rest of the folder can go too, nested
  // under the audio's checkbox, with what's in it listed.
  test(`record-delete/album-with-folder - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "record-delete/album-with-folder", colorScheme);
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("checkbox", { name: "Delete the rest of the folder" }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("list", { name: "Folders" }).getByRole("listitem"),
    ).toHaveText([
      "Beyoncé - Lemonade/cover.jpg, Lemonade.cue, Lemonade.log and 2 more",
    ]);
    await expect(dialog).toHaveScreenshot(
      snapshot("record-delete/album-with-folder", colorScheme),
    );
  });

  // The dialog on a track whose file is to go with it, which offers to delete
  // the audio file from disk too: a checkbox of its own, under the lines.
  test(`record-delete/track-with-file - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "record-delete/track-with-file", colorScheme);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText("Delete track");
    await expect(
      dialog.getByRole("checkbox", { name: "Delete the audio file from disk" }),
    ).toBeChecked();
    await expect(dialog).toHaveScreenshot(
      snapshot("record-delete/track-with-file", colorScheme),
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

// The results' scrollbar comes and goes as the sidebars' does (see "the
// scrollbar" in sidebars.spec.ts): there while the rows scroll or the mouse is
// over them, and gone a second after both stop. What's drawn is canvas pixels,
// so the grid says where its thumb is at in `data-thumb`.
test.describe("the results' scrollbar", () => {
  test.use({ hasTouch: false });

  test("shows at once on a scroll, and stays while the mouse is over the rows", async ({
    page,
  }) => {
    await openStory(page, "results/playing-row-scrollbar", "light");
    const canvas = page.locator("canvas[data-rows]");
    await expect(canvas).toHaveAttribute("data-thumb", "hidden");

    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 400, box.y + 20);
    await page.mouse.wheel(0, 40);
    // At full strength from the first frame, with no fade in.
    await expect(canvas).toHaveAttribute("data-thumb", "shown", {
      timeout: 100,
    });
    await page.waitForTimeout(1500);
    await expect(canvas).toHaveAttribute("data-thumb", "shown");

    await page.mouse.move(box.x + 400, box.y + box.height + 100);
    await page.waitForTimeout(500);
    await expect(canvas).toHaveAttribute("data-thumb", "shown");
    await expect(canvas).toHaveAttribute("data-thumb", "hidden", {
      timeout: 3000,
    });
  });

  test("fades in under the mouse", async ({ page }) => {
    await openStory(page, "results/playing-row-scrollbar", "light");
    const canvas = page.locator("canvas[data-rows]");
    await expect(canvas).toHaveAttribute("data-thumb", "hidden");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 400, box.y + 20);
    await expect(canvas).toHaveAttribute("data-thumb", "shown");
  });
});

// The Menu key raises the row menu for the selection, once a click has put
// the keyboard on the rows.
test("the Menu key raises a clicked row's menu", async ({ page }) => {
  await openStory(page, "results/playing-row", "light");
  const canvas = page.locator("canvas[data-rows]");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 400, box.y + 18);
  await expect(canvas).toBeFocused();
  await page.keyboard.press("ContextMenu");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // Hung from the row's bottom-left corner, not wherever the browser put it.
  const at = (await menu.boundingBox())!;
  expect(Math.round(at.x - box.x)).toBeLessThan(40);
  expect(Math.round(at.y - box.y)).toBeGreaterThanOrEqual(30);
  expect(Math.round(at.y - box.y)).toBeLessThan(50);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
});
