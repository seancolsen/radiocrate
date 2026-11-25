import type { Page } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import { type App, rpcAnswered } from "./support/app";

// What a new user sees: a server on a freshly migrated database with nothing
// scanned. Migration 0020 seeds a new library with its default customizations
// (saved queries of its tracks, albums and artists, presets for every table,
// field and table settings), so the app is set up for music before there is
// any. Then the first re-scan, which brings in the collection: the suite's
// shared copy of the sample files, which this database has never seen. A scan
// reads the files and writes only to the database, so the shared copy is safe.

test.use({ library: "empty" });

/** The active page's toolbar (other tabs' pages stay mounted, hidden). */
function toolbar(page: Page) {
  return page.getByTestId("query-toolbar").filter({ visible: true });
}

/** Opens a section's options menu ("Filter options", …) from its toggle,
 * opening the section first: the ⋮ shows on an open section's toggle. */
async function openOptions(page: Page, section: "Filter" | "Sort" | "Display") {
  const input = page.getByPlaceholder(section).filter({ visible: true });
  if ((await input.count()) === 0) {
    await toolbar(page)
      .getByRole("button", { name: section, exact: true })
      .click();
  }
  await toolbar(page)
    .getByRole("button", { name: `${section} options` })
    .click();
  return page.getByRole("menu");
}

/** Re-scans the collection from the Settings menu, as the user does, and waits
 * for the scan to finish: the menu stays up, its row spinning, until then. */
async function rescan(app: App, page: Page): Promise<void> {
  await app.openExplorer();
  await page.getByRole("button", { name: "Settings" }).click();
  const row = page.getByRole("menuitem", { name: "Re-scan collection" });
  const scanned = rpcAnswered(page, "collection.rescan", 30_000);
  await row.click();
  expect((await scanned).ok()).toBe(true);
  await expect(row).toBeHidden();
}

/** Re-runs the active page's query from the toolbar and waits for its rows.
 * A re-scan announces no change, so rows already on screen wait for this
 * (`specs/2026-11-live-updates/spec.md` §3.1). */
async function refresh(app: App, page: Page): Promise<void> {
  const ran = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/query",
  );
  await toolbar(page).getByRole("button", { name: "Refresh" }).click();
  await ran;
  await app.settled();
}

test("a new library opens to its default sources, presets and tables, with no tracks", async ({
  app,
  page,
}) => {
  await test.step("the explorer offers the seeded saved queries", async () => {
    await expect(app.sources).toMatchAriaSnapshot(`
      - tree "Sources":
        - treeitem "Tracks" [level=1]
        - treeitem "Albums" [level=1]
        - treeitem "Artists" [level=1]
    `);
    await look(page, "explorer");
  });

  await test.step("Tracks opens to no tracks", async () => {
    await app.openSource("Tracks");
    await expect(toolbar(page).getByText("0 tracks")).toBeVisible();
    await expect.poll(() => app.grid.rowCount()).toBe(0);
    expect(await app.grid.text()).toBe("\n");
    await look(page, "no-tracks");
  });

  await test.step("the grid says so", async () => {
    // The canvas paints "No results" itself; nothing in the DOM says it.
    await page.evaluate(() => document.fonts.ready);
    await expect(app.grid.canvas).toHaveScreenshot("no-tracks.png");
  });

  await test.step("the builder offers the track presets", async () => {
    await expect(await openOptions(page, "Filter")).toMatchAriaSnapshot(`
      - menu:
        - menuitemcheckbox "Custom filter" [checked] [disabled]
        - menuitemcheckbox "Good"
        - menuitemcheckbox "Great"
        - menuitemcheckbox "Not played"
        - menuitemcheckbox "Not played recently"
        - menuitem "Add new"
        - menuitem "Manage presets"
    `);
    await look(page, "filter-presets");
    await page.keyboard.press("Escape");

    await expect(await openOptions(page, "Sort")).toMatchAriaSnapshot(`
      - menu:
        - menuitemradio "Custom sort" [checked]
        - menuitemradio "Shuffle"
        - menuitemradio "Added recently"
        - menuitemradio "Artist, album, year"
        - menuitem "Add new"
        - menuitem "Manage presets"
    `);
    await page.keyboard.press("Escape");

    // The saved query wears its table's default display preset.
    await expect(await openOptions(page, "Display")).toMatchAriaSnapshot(`
      - menu:
        - menuitemradio "Custom display"
        - menuitemradio "Basic" [checked]
        - menuitem "Add new"
        - menuitem "Manage presets"
    `);
    await page.keyboard.press("Escape");
  });

  await test.step("Data structure lists the library's tables, empty but for the seeded ones", async () => {
    await app.openExplorer();
    await page.getByRole("button", { name: "Settings" }).click();
    // The rows' counts land after the tables do, from `table.summarize`,
    // which reads every table and can take longer than an assertion waits
    // while other workers share the machine: wait for its answer instead.
    const summarized = rpcAnswered(page, "table.summarize", 60_000);
    await page.getByRole("menuitem", { name: "Data structure" }).click();
    await summarized;
    await expect(page.getByRole("tree", { name: "Data structure" }))
      .toMatchAriaSnapshot(`
      - tree "Data structure":
        - treeitem "Tables 27 tables Refresh" [expanded] [level=1]:
          - group:
            - treeitem "track 0 rows × 9 columns Open all tracks in new tab" [level=2]
            - treeitem "artist 0 rows × 2 columns Open all artists in new tab" [level=2]
            - treeitem "album 0 rows × 3 columns Open all albums in new tab" [level=2]
            - treeitem "credit 0 rows × 4 columns Open all credits in new tab" [level=2]
            - treeitem "role 3 rows × 2 columns Open all roles in new tab" [level=2]
            - treeitem "tag 0 rows × 2 columns Open all tags in new tab" [level=2]
            - treeitem "track_tag 0 rows × 2 columns Open all track tags in new tab" [level=2]
            - treeitem "file 0 rows × 8 columns Open all files in new tab" [level=2]
            - treeitem "play 0 rows × 2 columns Open all plays in new tab" [level=2]
            - treeitem "rating 4 rows × 4 columns Open all ratings in new tab" [level=2]
            - treeitem "artist_ignored_album 0 rows × 2 columns Open all artist ignored albums in new tab" [level=2]
            - treeitem "ignored_album 0 rows × 4 columns Open all ignored albums in new tab" [level=2]
            - treeitem "app 6 tables" [level=2]
            - treeitem "meta 1 table" [level=2]
            - treeitem "metadata 6 tables" [level=2]
            - treeitem "settings 2 tables" [level=2]
        - treeitem "Querydown prelude" [level=1]
    `);
    await look(page, "data-structure");
  });
});

test("the first re-scan of a new library brings in the collection's tracks", async ({
  app,
  page,
}) => {
  await app.openSource("Tracks");
  await expect(toolbar(page).getByText("0 tracks")).toBeVisible();

  await test.step("re-scan from the Settings menu", async () => {
    await rescan(app, page);
    await look(page, "rescanned");
  });

  await test.step("Tracks shows every track, unrated and never played", async () => {
    await refresh(app, page);
    await expect(toolbar(page).getByText("63 tracks")).toBeVisible();
    await expect.poll(() => app.grid.rowCount()).toBe(63);
    // In a dependable order, through a default preset on rows that just came
    // in. Ratings and plays come only from the sample library's generator,
    // which this database has never run.
    await (
      await openOptions(page, "Sort")
    )
      .getByRole("menuitemradio", { name: "Artist, album, year" })
      .click();
    await page.keyboard.press("Escape");
    await expect
      .poll(() => app.grid.text(1))
      .toMatch(/^Fleetwood Mac\tSecond Hand News\t/);
    expect(await app.grid.text()).toMatchSnapshot(
      "tracks-after-first-scan.txt",
    );
    await look(page, "tracks");
  });

  await test.step("and their albums", async () => {
    await app.openSource("Albums");
    await expect(toolbar(page).getByText("6 albums")).toBeVisible();
    await look(page, "albums");
  });
});
