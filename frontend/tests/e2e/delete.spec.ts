import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import type { Api, Db } from "./support/api";
import { rpcAnswered, type App } from "./support/app";
import { COLLECTION_DIR, E2E_NOW } from "./support/paths";
import { definitionToStored } from "../../src/query/definition";

// Deleting records from the results: a row's "Delete …" entry, the dialog
// that says what else the deletion takes, and what's left in the database
// once it's confirmed. Nothing in the database cascades, so every record that
// goes was found by the dialog, and every one that stays was left by it.

// Each journey raises the dialog several times, and each raising asks the
// database a dozen questions before the deletion itself, of up to 646 records.
// The debug server takes a while over that with four workers on the machine:
// the journeys ran to 29 s of the default 30.
test.describe.configure({ timeout: 90_000 });

/** The "Delete records" dialog. */
const dialog = (page: Page): Locator =>
  page.getByRole("dialog", { name: /^Delete / });

/** The dialog's Delete button, which is enabled once the plan has landed. */
const deleteButton = (page: Page): Locator =>
  dialog(page).getByRole("button", { name: "Delete", exact: true });

/** One of the dialog's choices, by its label ("Delete 1 file"). */
const choice = (page: Page, name: string | RegExp): Locator =>
  dialog(page).getByRole("checkbox", { name });

/** Makes one of the dialog's choices, as a click on its label does. (The
 * input itself is hidden under the box drawn for it.) */
async function choose(page: Page, name: string): Promise<void> {
  await dialog(page).getByText(name, { exact: true }).click();
  await expect(choice(page, name)).toBeChecked();
  await expect(deleteButton(page)).toBeEnabled();
}

/** Raises the dialog from the menu of the row with a cell reading `cell`,
 * through the entry named `entry`, and waits for its plan. */
async function openDelete(
  app: App,
  page: Page,
  cell: string,
  entry: string,
): Promise<void> {
  await (await app.grid.row(cell)).openMenu();
  await page.getByRole("menuitem", { name: entry }).click();
  await expect(deleteButton(page)).toBeEnabled();
}

/** Confirms the dialog and waits for the deletion to land and the page to
 * have its rows again. */
async function confirmDelete(app: App, page: Page): Promise<void> {
  const deleted = rpcAnswered(page, "dml");
  await deleteButton(page).click();
  await deleted;
  await expect(dialog(page)).toBeHidden();
  await app.settled();
}

/** Opens the saved query `name` and waits for `rows` rows. */
async function openRows(app: App, name: string, rows: number): Promise<void> {
  await app.openSource(name);
  await expect.poll(() => app.grid.rowCount()).toBe(rows);
}

const count = async (db: Db, sql: string): Promise<number> =>
  Number(await db.value(`select count(*) from ${sql}`));

/** The id of the track titled `title`. */
const trackId = async (db: Db, title: string): Promise<string> =>
  String(
    await db.value(
      `select id::text from track where title = '${title.replace(/'/g, "''")}'`,
    ),
  );

/** Where the audio file of the track titled `title` is, in the collection. */
async function audioFileOf(db: Db, title: string): Promise<string> {
  const stored = await db.value(
    `select f.path from file f join track t on t.file = f.id ` +
      `where t.title = '${title.replace(/'/g, "''")}'`,
  );
  return path.join(COLLECTION_DIR, String(stored));
}

/** Saves a query named `name` over `base`, showing `columns` after the hidden
 * key that makes its rows records. */
async function arrangeQuery(
  api: Api,
  name: string,
  base: string,
  key: string,
  columns: readonly string[],
): Promise<void> {
  const now = Math.floor(E2E_NOW.getTime() / 1000);
  await api.rpc("query.add", {
    id: crypto.randomUUID(),
    kind: "query",
    name,
    createdAt: now,
    modifiedAt: now,
    lastPlay: now,
    definition: definitionToStored({
      base,
      filter: { custom: "", presets: [] },
      sort: { custom: "" },
      display: {
        custom: [`$${key} @{hide:yes}`, ...columns.map((c) => `$${c}`)].join(
          "\n",
        ),
      },
    }),
    parent: null,
    position: -1,
    queryId: crypto.randomUUID(),
    playlistId: null,
  });
}

test("deleting a track takes what can't be kept without it, and remembers what else was chosen", async ({
  app,
  page,
  db,
}) => {
  const rita = await trackId(db, "Lovely Rita");
  const ritaFile = await audioFileOf(db, "Lovely Rita");
  const betterFile = await audioFileOf(db, "Getting Better");
  await openRows(app, "Tracks", 63);

  await test.step("the dialog lists what's tied to the track", async () => {
    await openDelete(app, page, "Lovely Rita", "Delete track…");
    await look(page, "dialog");
    await expect(dialog(page)).toMatchAriaSnapshot({ name: "track.aria.yml" });
    // What must go with it isn't a choice. Its file is, and stays by default.
    await expect(choice(page, "Delete 1 credit")).toBeChecked();
    await expect(choice(page, "Delete 1 credit")).toBeDisabled();
    await expect(choice(page, "Delete 1 file")).not.toBeChecked();
  });

  await test.step("confirming deletes the track and its dependents", async () => {
    await confirmDelete(app, page);
    await expect(page.getByText("Deleted 1 track")).toBeVisible();
    await expect.poll(() => app.grid.rowCount()).toBe(62);
    expect(await app.grid.find("Lovely Rita")).toBeNull();
    await look(page, "deleted");
    expect(await count(db, `credit where track = '${rita}'`)).toBe(0);
    expect(await count(db, `play where track = '${rita}'`)).toBe(0);
    expect(await count(db, `track_tag where track = '${rita}'`)).toBe(0);
    // Its file's record stays, with no track.
    expect(await count(db, "file")).toBe(63);
  });

  await test.step("choosing the file deletes its record, not the audio", async () => {
    await openDelete(app, page, "Getting Better", "Delete track…");
    await choose(page, "Delete 1 file");
    await look(page, "with-file");
    await confirmDelete(app, page);
    await expect.poll(() => app.grid.rowCount()).toBe(61);
    expect(await count(db, "file")).toBe(62);
    expect(fs.existsSync(ritaFile)).toBe(true);
    expect(fs.existsSync(betterFile)).toBe(true);
  });

  await test.step("the choice is still made after a reload", async () => {
    await app.reload();
    if ((await app.activeTabName()) !== "Tracks")
      await app.openSource("Tracks");
    await expect.poll(() => app.grid.rowCount()).toBe(61);
    await openDelete(app, page, "Fixing a Hole", "Delete track…");
    await expect(choice(page, "Delete 1 file")).toBeChecked();
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toBeHidden();
    expect(await app.grid.find("Fixing a Hole")).not.toBeNull();
    expect(await count(db, "track")).toBe(61);
  });
});

test("deleting every track of two albums offers both albums as one choice", async ({
  app,
  page,
  api,
  db,
}) => {
  await test.step("arrange: two tracks on one new album, one on another", async () => {
    const move = (id: string, title: string, album: string) => ({
      operation: "update",
      id,
      table: "track",
      where: { id: title },
      values: { album: { id: album } },
    });
    await api.rpc("dml", {
      operations: [
        {
          operation: "insert",
          id: "a",
          table: "album",
          values: { title: "Side A" },
        },
        {
          operation: "insert",
          id: "b",
          table: "album",
          values: { title: "Side B" },
        },
        move("t1", await trackId(db, "Lovely Rita"), "a"),
        move("t2", await trackId(db, "Getting Better"), "a"),
        move("t3", await trackId(db, "Fixing a Hole"), "b"),
      ],
    });
    expect(await count(db, "album")).toBe(8);
  });
  await openRows(app, "Tracks", 63);

  await test.step("one of an album's two tracks leaves it no orphan", async () => {
    await openDelete(app, page, "Lovely Rita", "Delete track…");
    await expect(choice(page, /album/)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
  });

  await test.step("all three tracks, selected together, leave two", async () => {
    await (await app.grid.row("Lovely Rita")).click();
    for (const title of ["Getting Better", "Fixing a Hole"]) {
      await (await app.grid.row(title)).click({ modifiers: ["Control"] });
    }
    await openDelete(app, page, "Fixing a Hole", "Delete 3 tracks…");
    await expect(dialog(page).getByRole("heading")).toHaveText(
      "Delete 3 tracks",
    );
    await expect(choice(page, /album/)).toHaveCount(1);
    await expect(choice(page, "Delete 2 albums")).not.toBeChecked();
    await look(page, "three-tracks");
  });

  await test.step("choosing them deletes the albums with the tracks", async () => {
    await choose(page, "Delete 2 albums");
    await confirmDelete(app, page);
    await expect(page.getByText("Deleted 3 tracks")).toBeVisible();
    await expect.poll(() => app.grid.rowCount()).toBe(60);
    await openRows(app, "Albums", 6);
    expect(await app.grid.find("Side A")).toBeNull();
    expect(await app.grid.find("Side B")).toBeNull();
  });
});

test("deleting an album keeps its tracks, or deletes them when that's chosen", async ({
  app,
  page,
  db,
}) => {
  await openRows(app, "Albums", 6);

  await test.step("by default the tracks stay, with no album", async () => {
    await openDelete(app, page, "Purple Rain", "Delete album…");
    await expect(choice(page, "Delete 9 tracks")).not.toBeChecked();
    await expect(dialog(page)).toContainText(
      "Otherwise they’re kept, with no album.",
    );
    await expect(dialog(page)).toContainText(
      "In all, 1 record is deleted and 9 are changed.",
    );
    await look(page, "album-default");
    await confirmDelete(app, page);
    await expect.poll(() => app.grid.rowCount()).toBe(5);
    expect(await app.grid.find("Purple Rain")).toBeNull();
    expect(await count(db, "track")).toBe(63);
    expect(await count(db, "track where album is null")).toBe(9);
  });

  await test.step("choosing the tracks brings in what's tied to them", async () => {
    await openDelete(app, page, "Thriller", "Delete album…");
    await choose(page, "Delete 9 tracks");
    await expect(choice(page, "Delete 10 credits")).toBeDisabled();
    await look(page, "album-with-tracks");
    await expect(dialog(page)).toMatchAriaSnapshot({
      name: "album-with-tracks.aria.yml",
    });
    await confirmDelete(app, page);
    await expect.poll(() => app.grid.rowCount()).toBe(4);
    expect(await count(db, "track")).toBe(54);
    // Their files' records weren't chosen, and the artist left with no
    // credits wasn't either.
    expect(await count(db, "file")).toBe(63);
    expect(await count(db, "artist")).toBe(8);
  });

  await test.step("both albums are still gone after a reload", async () => {
    await app.reload();
    if ((await app.activeTabName()) !== "Albums")
      await app.openSource("Albums");
    await expect.poll(() => app.grid.rowCount()).toBe(4);
    await openRows(app, "Tracks", 54);
  });
});

test("deleting a rating clears it from every track that had it", async ({
  app,
  page,
  api,
  db,
}) => {
  await arrangeQuery(api, "Ratings", "rating", "id", ["description"]);
  await app.reload();
  await openRows(app, "Ratings", 4);

  await test.step("its tracks are kept, with no rating", async () => {
    await openDelete(app, page, "Love", "Delete rating…");
    await expect(choice(page, "Delete 17 tracks")).not.toBeChecked();
    await expect(dialog(page)).toContainText(
      "In all, 1 record is deleted and 17 are changed.",
    );
    await look(page, "rating");
    await confirmDelete(app, page);
    await expect.poll(() => app.grid.rowCount()).toBe(3);
    expect(await count(db, "track")).toBe(63);
    expect(await count(db, "track where rating is null")).toBe(17);
  });

  await test.step("and it's no longer one to rate a track with", async () => {
    await openRows(app, "Tracks", 63);
    await (await app.grid.row("Lovely Rita")).openMenu();
    await page.getByRole("menuitem", { name: "Rate track" }).click();
    await expect(page.getByRole("menuitem", { name: /Prefer/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Love/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});

test("tables of the user's own are followed through the relationships they declare", async ({
  app,
  page,
  api,
  db,
}) => {
  await test.step("arrange: venues, and gigs that each played a track at one", async () => {
    // Made as a user makes tables of their own: from outside the app. The
    // relationships are rows like any other.
    const rita = await trackId(db, "Lovely Rita");
    const better = await trackId(db, "Getting Better");
    for (const sql of [
      "create table venue (code text primary key, name text not null)",
      "create table gig (id uuid primary key, name text not null, venue text, track uuid not null)",
      "insert into venue values ('ROXY', 'The Roxy'), ('APOLLO', 'The Apollo')",
      `insert into gig values (uuid(), 'First night', 'ROXY', '${rita}'), ` +
        `(uuid(), 'Second night', 'ROXY', '${better}')`,
    ]) {
      await db.query(sql);
    }
    const relationship = (id: string, column: string, target: string) => ({
      operation: "insert",
      id,
      schema: "metadata",
      table: "relationship",
      values: {
        schema_name: "main",
        table_name: "gig",
        column_name: column,
        target_schema_name: "main",
        target_table_name: target,
      },
    });
    await api.rpc("dml", {
      operations: [
        relationship("r1", "venue", "venue"),
        relationship("r2", "track", "track"),
      ],
    });
    await arrangeQuery(api, "Venues", "venue", "code", ["name"]);
    await app.reload();
  });

  await test.step("a gig can't be kept without its track", async () => {
    await openRows(app, "Tracks", 63);
    await openDelete(app, page, "Lovely Rita", "Delete track…");
    await expect(choice(page, "Delete 1 gig")).toBeChecked();
    await expect(choice(page, "Delete 1 gig")).toBeDisabled();
    await expect(dialog(page)).toContainText(
      "A gig can’t be kept without its track.",
    );
    // The venue still has its second night, so it isn't offered.
    await expect(choice(page, /venue/)).toHaveCount(0);
    await look(page, "track-with-gig");
    await confirmDelete(app, page);
    expect(await count(db, "gig")).toBe(1);
  });

  await test.step("a venue's gig is kept without it, by default", async () => {
    await openRows(app, "Venues", 2);
    await openDelete(app, page, "The Roxy", "Delete venue…");
    await expect(choice(page, "Delete 1 gig")).not.toBeChecked();
    await expect(dialog(page)).toContainText(
      "Otherwise it’s kept, with no venue.",
    );
    await look(page, "venue");
    await confirmDelete(app, page);
    await expect.poll(() => app.grid.rowCount()).toBe(1);
    expect(await app.grid.find("The Roxy")).toBeNull();
    expect(await count(db, "gig where venue is null")).toBe(1);
  });
});
