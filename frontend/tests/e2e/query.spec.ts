import type { Page } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import { App, rpcAnswered } from "./support/app";

// Building, saving and reopening queries, against the real server: what the
// query builder writes goes through Querydown, the SQL it compiles to and
// DuckDB on the sample library, and comes back as the grid's rows.

/** A filter that keeps the library's ten most played tracks (80 plays and
 * up), and a sort that puts the most played first, ties broken by title. */
const MOST_PLAYED = "play_count:>=80";
const BY_PLAYS = "\\\\play_count \\d \\\\title";

/** The active page's toolbar (other tabs' pages stay mounted, hidden). */
function toolbar(page: Page) {
  return page.getByTestId("query-toolbar").filter({ visible: true });
}

/** The active page's custom Querydown input for a section, by its
 * placeholder ("Filter", "Sort"). */
function input(page: Page, hint: "Filter" | "Sort") {
  return page.getByPlaceholder(hint).filter({ visible: true });
}

/** Opens a section's builder from its toggle, unless it's already open. */
async function openSection(page: Page, name: "Filter" | "Sort") {
  const toggle = toolbar(page).getByRole("button", { name, exact: true });
  if ((await input(page, name).count()) === 0) await toggle.click();
  await expect(input(page, name)).toBeVisible();
}

test("a filter and a sort built in the toolbar pick and order the rows", async ({
  app,
  page,
}) => {
  await app.openSource("Tracks");
  await expect(toolbar(page).getByText("63 tracks")).toBeVisible();

  await test.step("filter to the most played tracks", async () => {
    await openSection(page, "Filter");
    await input(page, "Filter").fill(MOST_PLAYED);
    await expect(toolbar(page).getByText("10 tracks")).toBeVisible();
    await expect.poll(() => app.grid.rowCount()).toBe(10);
    await look(page, "filtered");
  });

  await test.step("sort them by plays, most first", async () => {
    await openSection(page, "Sort");
    await input(page, "Sort").fill(BY_PLAYS);
    // The filtered rows came in the library's order; once the sort has run,
    // the most played track of all leads.
    await expect
      .poll(() => app.grid.text(1))
      .toMatch(/^Michael Jackson\tBillie Jean\t/);
    await look(page, "sorted");
  });

  await test.step("the grid shows exactly those rows, in that order", async () => {
    await expect(toolbar(page).getByText("10 tracks")).toBeVisible();
    expect(await app.grid.text()).toMatchSnapshot("most-played.txt");
  });
});

test("a time-relative preset matches by the server's pinned clock", async ({
  app,
  page,
  api,
  db,
}) => {
  // Every track in the sample library was played in the six days before the
  // pinned instant (2026-01-15 12:00), so "Not played recently" (no play in
  // the last month) matches none of them. Take the last six weeks of plays
  // away from two tracks, and those two are the ones it matches. On the real
  // clock, months later, it would match every track.
  await test.step("arrange: two tracks last played before December", async () => {
    const plays = await db.query(`
      select cast(p.track as text) as track,
             strftime(p.timestamp, '%Y-%m-%d %H:%M:%S') as timestamp
      from play p join track t on t.id = p.track
      where t.title in ('Computer Blue', 'Speak to Me')
        and p.timestamp >= timestamp '2025-12-01 00:00:00'`);
    expect(plays.length).toBeGreaterThan(0);
    await api.rpc("dml", {
      operations: plays.map((play, i) => ({
        operation: "delete",
        id: `play-${i}`,
        table: "play",
        where: { track: play.track, timestamp: play.timestamp },
      })),
    });
  });

  await app.openSource("Tracks");
  await expect(toolbar(page).getByText("63 tracks")).toBeVisible();

  await test.step("apply “Not played recently” from the Filter options", async () => {
    // The ⋮ shows on an open section's toggle.
    await openSection(page, "Filter");
    await toolbar(page).getByRole("button", { name: "Filter options" }).click();
    await page
      .getByRole("menuitemcheckbox", { name: "Not played recently" })
      .click();
    await page.keyboard.press("Escape");
    await expect(toolbar(page).getByText("2 tracks")).toBeVisible();
    await expect.poll(() => app.grid.rowCount()).toBe(2);
    await look(page, "not-played-recently");
  });

  await test.step("it matches exactly the two tracks", async () => {
    expect(await app.grid.text()).toMatchSnapshot("not-played-recently.txt");
  });
});

test("a saved query autosaves its edits and reopens with them after a reload", async ({
  app,
  page,
}) => {
  // The autosave alone waits out 5 s of quiet after the last edit's run.
  test.setTimeout(60_000);

  await test.step("start a new query and name it", async () => {
    await page.getByRole("button", { name: "New query", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Close new query" }),
    ).toBeVisible();
    await toolbar(page).getByRole("button", { name: "Query actions" }).click();
    await page.getByRole("menuitem", { name: /^Rename/ }).click();
    await page.keyboard.type("Most played");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Close Most played" }),
    ).toBeVisible();
  });

  await test.step("filter it to the most played tracks", async () => {
    await openSection(page, "Filter");
    await input(page, "Filter").fill(MOST_PLAYED);
    await expect(toolbar(page).getByText("10 tracks")).toBeVisible();
    await look(page, "new-query");
  });

  await test.step("save it: the first save of a new query is explicit", async () => {
    const added = rpcAnswered(page, "query.add");
    await toolbar(page).getByRole("button", { name: "Save" }).click();
    expect((await added).ok()).toBe(true);
    await expect(
      toolbar(page).getByRole("button", { name: "Save" }),
    ).toHaveCount(0);
    await app.openExplorer();
    await expect(app.source("Most played")).toBeVisible();
    await look(page, "saved");
  });

  await test.step("sort it, and it saves itself once the app goes quiet", async () => {
    // No Save click and nothing that flushes the queue: the write goes out
    // only after the app has been idle for its 5 s.
    const updated = rpcAnswered(page, "source.update_definition", 20_000);
    await openSection(page, "Sort");
    await input(page, "Sort").fill(BY_PLAYS);
    await expect
      .poll(() => app.grid.text(1))
      .toMatch(/^Michael Jackson\tBillie Jean\t/);
    // A saved query never offers Save for its edits, nor marks them unsaved.
    await expect(
      toolbar(page).getByRole("button", { name: "Save" }),
    ).toHaveCount(0);
    const response = await updated;
    expect(response.ok()).toBe(true);
    const { params } = response.request().postDataJSON() as {
      params: { definition: string };
    };
    expect(JSON.parse(params.definition)).toMatchObject({
      filter: { custom: MOST_PLAYED },
      sort: { custom: BY_PLAYS },
    });
    await look(page, "autosaved");
  });

  await test.step("close it and reload: it's in the explorer", async () => {
    // Closed, so that the reload restores no tab from the browser's storage:
    // what reopens comes from the server.
    await page.getByRole("button", { name: "Close Most played" }).click();
    await app.reload();
    await app.openExplorer();
    await expect(app.source("Most played")).toBeVisible();
    await look(page, "reloaded");
  });

  await test.step("it reopens with the sort it autosaved, and its rows", async () => {
    await app.openSource("Most played");
    await expect(toolbar(page).getByText("10 tracks")).toBeVisible();
    await openSection(page, "Sort");
    await expect(input(page, "Sort")).toHaveText(BY_PLAYS);
    await expect
      .poll(() => app.grid.text(1))
      .toMatch(/^Michael Jackson\tBillie Jean\t/);
    expect(await app.grid.text()).toMatchSnapshot("most-played.txt");
    await look(page, "reopened");
  });
});

// BUG: a new query opened before `preset.list` has answered never gets its
// table's default presets. `openNewQuery` (`stores/app/actions.ts`) builds the
// definition from `definitionForBase("track", get().presets)` once, at
// creation, and nothing fills the defaults in when the presets arrive. The
// app is "ready" (its sources listed, New query enabled) before the presets
// are, so a quick click gets a query with an empty display: every raw column,
// ids and all, and saved that way. Here the preset list is held back until
// the tab is open, to make the race certain.
test("a new query opened before the presets load still gets its table's defaults", async ({
  page,
}) => {
  test.fail();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as { method?: string };
    if (body.method === "preset.list") await held;
    await route.fallback();
  });
  // Not `app.load()`, which waits for the presets this test holds back.
  const app = new App(page);
  await page.goto("/?expose=1");
  await page.waitForFunction(
    () => window.__appStore?.state.sources.status === "ready",
  );

  await page.getByRole("button", { name: "New query", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close new query" }),
  ).toBeVisible();
  release();
  await page.waitForFunction(
    () => window.__appStore.state.presetsStatus === "ready",
  );

  await input(page, "Filter").fill(MOST_PLAYED);
  await expect(toolbar(page).getByText("10 tracks")).toBeVisible();
  await look(page, "new-query");
  // The display preset "Basic" in force: artists first, then the title.
  await expect
    .poll(() => app.grid.text(1))
    .toMatch(/^The Beatles\tLucy in the Sky With Diamonds\t/);
});
