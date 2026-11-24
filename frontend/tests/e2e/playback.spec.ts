import type { Locator, Page, Response } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import type { Db } from "./support/api";
import { rpcAnswered, type App } from "./support/app";
import { E2E_NOW } from "./support/paths";

// Each test plays real audio in real time (a second or two of it, past the
// seek, twice in the second test), on top of a server and a page of its own.
test.describe.configure({ timeout: 60_000 });

// Playback through the real stream: a double-click on a Tracks row has the
// browser fetch the track's file from `/api/tracks/{id}/stream` and play it,
// and a track that plays to its end is logged in `play`, which the row's play
// count and "last played" show at once, and again after a reload.
//
// Nobody waits out a whole track: the test scrubs to just before the end on
// the now-playing bar's timeline, as a user would, and lets the last second or
// so play out for real, so `ended` comes from the media element itself.

/** The shortest track in the sample library, and its length in seconds (1:07). */
const TITLE = "Speak to Me";
const LENGTH = 67;

/** The Tracks grid's columns, by position in a row of `app.grid.text()`. */
const TITLE_COL = 1;
const PLAYS_COL = 5;
const LAST_PLAYED_COL = 6;

/** The now-playing bar. */
const bar = (page: Page) => page.getByTestId("now-playing");

/** The bar's timeline. */
const seekSlider = (page: Page) =>
  bar(page).getByRole("slider", { name: "Seek" });

/** The cells of the row titled `title`, as the grid shows them. */
async function cellsOf(app: App, title: string): Promise<string[]> {
  const row = (await app.grid.text())
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"))
    .find((cells) => cells[TITLE_COL] === title);
  if (!row) throw new Error(`No row is titled "${title}"`);
  return row;
}

/** The play count a row shows, as a number ("38𝅘𝅥𝅮" → 38). */
async function playsOf(app: App, title: string): Promise<number> {
  return parseInt((await cellsOf(app, title))[PLAYS_COL] ?? "", 10);
}

/** What a row's "last played" cell reads. */
async function lastPlayedOf(app: App, title: string): Promise<string> {
  return (await cellsOf(app, title))[LAST_PLAYED_COL] ?? "";
}

/** The id of the track titled `title`. */
async function trackId(db: Db, title: string): Promise<string> {
  return String(
    await db.value(
      `select id::text from track where title = '${title.replace(/'/g, "''")}'`,
    ),
  );
}

/** The track's plays, oldest first, as `YYYY-MM-DD HH:MM:SS`. */
async function playsLogged(db: Db, id: string): Promise<string[]> {
  const rows = await db.query(
    `select strftime(timestamp, '%Y-%m-%d %H:%M:%S') as at from play ` +
      `where track = '${id}' order by timestamp`,
  );
  return rows.map((r) => String(r.at));
}

/** Resolves with the server's answer to the browser fetching track `id`'s
 * audio. Start it before the action that plays the track. */
function streamed(page: Page, id: string): Promise<Response> {
  return page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/tracks/${id}/stream`,
  );
}

/** Opens Tracks and waits for all of its rows. */
async function openTracks(app: App): Promise<void> {
  await app.openSource("Tracks");
  await expect.poll(() => app.grid.rowCount()).toBe(63);
}

/** Reloads the page and brings the Tracks tab back to its rows. */
async function reloadTracks(app: App): Promise<void> {
  await app.reload();
  if ((await app.activeTabName()) !== "Tracks") await app.openSource("Tracks");
  await expect.poll(() => app.grid.rowCount()).toBe(63);
}

/** Double-clicks the row titled `title` and waits until the bar shows it
 * playing: the play button offers Pause and has stopped waiting on data, the
 * timeline knows the track's length, and the playhead has moved off zero,
 * which only decoded audio moves. */
async function playRow(app: App, page: Page, title: string): Promise<void> {
  await (await app.grid.row(title)).dblclick();
  await expect(bar(page)).toBeVisible();
  await expect(bar(page).getByText(title, { exact: true })).toBeVisible();
  const toggle = bar(page).getByRole("button", { name: "Pause" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-busy", "false");
  await expect(seekSlider(page)).toHaveAttribute(
    "aria-valuemax",
    String(LENGTH),
  );
  await expect
    .poll(async () =>
      Number(await seekSlider(page).getAttribute("aria-valuenow")),
    )
    .toBeGreaterThanOrEqual(1);
}

/** Scrubs the playing track to `fraction` of its length by clicking the bar's
 * timeline there. */
async function seekTo(slider: Locator, fraction: number): Promise<void> {
  const box = await slider.boundingBox();
  if (!box) throw new Error("The timeline isn't on screen");
  await slider.click({
    position: { x: box.width * fraction, y: box.height / 2 },
  });
}

/** Scrubs the playing track to its last second or two and waits for it to
 * end on its own and be logged: the `dml` call inserting the play has been
 * answered, and the bar has moved on to the track after it. */
async function playOutTheEnd(page: Page, title: string): Promise<void> {
  const logged = rpcAnswered(page, "dml");
  await seekTo(seekSlider(page), 0.98);
  await expect
    .poll(async () =>
      Number(await seekSlider(page).getAttribute("aria-valuenow")),
    )
    .toBeGreaterThanOrEqual(LENGTH - 2);
  await look(page, "near-the-end");
  const answer = await logged;
  const body = answer.request().postDataJSON() as {
    params: { operations: { table: string; operation: string }[] };
  };
  expect(body.params.operations).toEqual([
    expect.objectContaining({ table: "play", operation: "insert" }),
  ]);
  expect(answer.ok()).toBe(true);
  await expect(bar(page).getByText(title, { exact: true })).toBeHidden();
}

// Once in UTC, and once with the browser and the server in New York, where
// the play must still be stored in UTC and still read "0 minutes ago".
for (const zone of ["UTC", "America/New_York"]) {
  test.describe(`in ${zone}`, () => {
    test.use({ timezoneId: zone, serverTimeZone: zone });

    test("a track played to its end is logged as a play", async ({
      app,
      page,
      db,
    }) => {
      await openTracks(app);
      const id = await trackId(db, TITLE);
      const before = await playsOf(app, TITLE);
      expect(await lastPlayedOf(app, TITLE)).toBe("1 day ago");
      const logBefore = await playsLogged(db, id);
      expect(logBefore).toHaveLength(before);

      await test.step("a double-click streams it from the server", async () => {
        const response = streamed(page, id);
        await playRow(app, page, TITLE);
        const served = await response;
        // The media element asks for a range of the file, which the server answers
        // with the original FLAC (the default "higher" quality isn't transcoded).
        expect(served.status()).toBe(206);
        expect(served.headers()["content-type"]).toBe("audio/flac");
        await look(page, "playing");
      });

      await test.step("it plays out to its end", async () => {
        await playOutTheEnd(page, TITLE);
      });

      // Stored as UTC civil time, whatever the browser's zone: 12:00, not
      // New York's 07:00 (specs/2026-11-utc-timestamps/decision.md).
      await test.step("the play is logged at the browser's now, in UTC", async () => {
        expect(await playsLogged(db, id)).toEqual([
          ...logBefore,
          "2026-01-15 12:00:00",
        ]);
      });

      await test.step("its row counts it, without a reload", async () => {
        await expect.poll(() => playsOf(app, TITLE)).toBe(before + 1);
        await expect.poll(() => lastPlayedOf(app, TITLE)).toBe("0 minutes ago");
        await (await app.grid.row(TITLE)).box();
        await look(page, "counted");
      });

      await test.step("and still does after a reload", async () => {
        await reloadTracks(app);
        expect(await playsOf(app, TITLE)).toBe(before + 1);
        expect(await lastPlayedOf(app, TITLE)).toBe("0 minutes ago");
        await (await app.grid.row(TITLE)).box();
        await look(page, "after-reload");
      });
    });
  });
}
test("playing a track again logs a second play", async ({ app, page, db }) => {
  await openTracks(app);
  const id = await trackId(db, TITLE);
  const before = await playsOf(app, TITLE);
  const logBefore = await playsLogged(db, id);

  await test.step("play it to its end once", async () => {
    await playRow(app, page, TITLE);
    await playOutTheEnd(page, TITLE);
    await expect.poll(() => playsOf(app, TITLE)).toBe(before + 1);
  });

  await test.step("five minutes later, play it to its end again", async () => {
    // `play` is keyed on (track, timestamp) to the second, so the second play
    // needs a clock that has moved.
    // The browser may play it from its media cache this time, without asking
    // the server again, so no stream request is waited for.
    await page.clock.setFixedTime(new Date(E2E_NOW.getTime() + 5 * 60_000));
    await playRow(app, page, TITLE);
    await playOutTheEnd(page, TITLE);
    await look(page, "played-twice");
  });

  await test.step("both plays are logged, and the row counts both", async () => {
    expect(await playsLogged(db, id)).toEqual([
      ...logBefore,
      "2026-01-15 12:00:00",
      "2026-01-15 12:05:00",
    ]);
    await expect.poll(() => playsOf(app, TITLE)).toBe(before + 2);
    await expect.poll(() => lastPlayedOf(app, TITLE)).toBe("0 minutes ago");
  });
});
