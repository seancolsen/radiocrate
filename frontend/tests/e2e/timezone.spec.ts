import type { Page } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import type { Api, Db } from "./support/api";
import type { App } from "./support/app";

// Time-relative filters with the browser and the server in different zones.
//
// Every timestamp in the database is UTC civil time: a zone-less value that
// means UTC (specs/2026-11-utc-timestamps/decision.md). The browser writes
// UTC and shows local time; the server's `now()` is UTC because the bundled
// DuckDB has no ICU and can't load one. Querydown compiles `last_play:<1h` to
// `CAST(NOW() AS TIMESTAMP) - … < INTERVAL 1 hour`, so "the last hour" is the
// last hour wherever the browser and the server are.
//
// This was the bug the decision fixed: the browser used to store its own
// civil time, so a browser in New York had to ask for `<6h` to see the last
// hour's plays. And a server whose DuckDB loaded ICU mid-session (from the
// shared extension cache) switched to its own zone partway through.
//
// The library starts empty and is scanned, so the only plays are the ones
// each test arranges, in UTC. The clock is frozen at 2026-01-15 12:00 UTC.

/** The active page's custom Filter input. */
function filterInput(page: Page) {
  return page.getByPlaceholder("Filter").filter({ visible: true });
}

/** Scans the shared collection into the empty library, then logs one play of
 * each track at the given civil times. */
async function arrangePlays(
  api: Api,
  db: Db,
  plays: Record<string, string>,
): Promise<void> {
  await api.rpc("collection.rescan");
  const titles = Object.keys(plays);
  const rows = await db.query(
    `select cast(id as text) as id, title from track where title in (${titles
      .map((t) => `'${t}'`)
      .join(", ")})`,
  );
  expect(rows).toHaveLength(titles.length);
  await api.rpc("dml", {
    operations: rows.map((row, i) => ({
      operation: "insert",
      id: `play-${i}`,
      table: "play",
      values: { track: row.id, timestamp: plays[String(row.title)] },
    })),
  });
}

/** Types `filter` into the active page's Filter input. */
async function filterBy(page: Page, filter: string): Promise<void> {
  const toolbar = page.getByTestId("query-toolbar").filter({ visible: true });
  if ((await filterInput(page).count()) === 0) {
    await toolbar.getByRole("button", { name: "Filter", exact: true }).click();
  }
  await filterInput(page).fill(filter);
}

/** The titles the active page's rows show, sorted; none before it has rows. */
async function titles(app: App): Promise<string[]> {
  const text = await app.grid.text().catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1] ?? "")
    .sort();
}

/** Played half an hour and three hours before the frozen clock, in UTC. */
const HALF_HOUR_AGO = "2026-01-15 11:30:00";
const THREE_HOURS_AGO = "2026-01-15 09:00:00";

const CASES = [
  { browser: "America/New_York", server: "UTC" },
  { browser: "UTC", server: "America/New_York" },
  { browser: "America/New_York", server: "America/New_York" },
  { browser: "Asia/Kolkata", server: "Pacific/Auckland" },
] as const;

for (const c of CASES) {
  test.describe(`a browser in ${c.browser}, a server in ${c.server}`, () => {
    test.use({
      library: "empty",
      timezoneId: c.browser,
      serverTimeZone: c.server,
    });

    test("“the last hour” is the browser's last hour", async ({
      app,
      page,
      api,
      db,
    }) => {
      await arrangePlays(api, db, {
        Dreams: HALF_HOUR_AGO,
        Money: THREE_HOURS_AGO,
      });

      await test.step("a query that needs ICU fails rather than load it", async () => {
        // Loading ICU would switch the server's casts to its own zone.
        await expect(
          db.query("select date_trunc('day', now())"),
        ).rejects.toThrow(/icu/);
      });

      await app.openSource("Tracks");

      await test.step("played in the last hour: only Dreams", async () => {
        await filterBy(page, "last_play:<1h");
        await expect.poll(() => titles(app)).toEqual(["Dreams"]);

        await look(page, "last-hour");
      });

      await test.step("played in the last six hours: both", async () => {
        await filterBy(page, "last_play:<6h");
        await expect.poll(() => titles(app)).toEqual(["Dreams", "Money"]);
      });

      await test.step("and the grid says how long ago, in the browser's terms", async () => {
        await filterBy(page, "last_play:<1h");
        await expect.poll(() => app.grid.text()).toContain("30 minutes ago");
      });
    });
  });
}

test.describe("a browser in America/New_York, a server in UTC", () => {
  test.use({
    library: "empty",
    timezoneId: "America/New_York",
    serverTimeZone: "UTC",
  });

  test("the record editor shows stored times in the browser's local time", async ({
    app,
    page,
    api,
    db,
  }) => {
    // The re-scan stamps `file.added` with the server's `now()`: 12:00 UTC.
    await arrangePlays(api, db, { Dreams: HALF_HOUR_AGO });
    expect(
      await db.value(
        "select strftime(min(added), '%Y-%m-%d %H:%M:%S') from file",
      ),
    ).toBe("2026-01-15 12:00:00");

    await app.openSource("Tracks");
    await filterBy(page, "last_play:<1h");
    await expect.poll(() => titles(app)).toEqual(["Dreams"]);
    await (await app.grid.row("Dreams")).openMenu();
    await page.getByRole("menuitem", { name: "Edit track" }).click();
    const editor = page.getByRole("complementary", { name: /^Edit / });

    // 12:00 and 11:30 UTC are 07:00 and 06:30 in New York.
    await expect(editor.getByText("2026-01-15 07:00:00")).toBeVisible();
    await expect(editor.getByText("2026-01-15 06:30:00")).toBeVisible();
    await look(page, "editor");
  });
});
