import { test, expect, look } from "./fixtures";
import type { Api, Db } from "./support/api";
import { App, rpcAnswered } from "./support/app";
import { E2E_NOW } from "./support/paths";
import {
  newPlaylistDefinition,
  playlistDefinitionToStored,
} from "../../src/query/playlist";
import {
  createPlaylistWrites,
  toDmlRequest,
} from "../../src/query/playlistEntries";
import type { Preset } from "api-client";

// A playlist's life: made from the explorer, filled from Tracks, rearranged by
// dragging its rows, and an entry taken out again — each written to the real
// database and read back after a reload.
//
// Only the first test makes its playlist through the UI. The others arrange
// theirs through the API, with the app's own builders for the writes (as
// `createPlaylist` sends them), so each acts through the UI only for its own
// point.

/** The ids of the tracks titled `titles`, in that order. */
async function trackIds(db: Db, titles: readonly string[]): Promise<string[]> {
  const list = titles.map((t) => `'${t.replace(/'/g, "''")}'`).join(", ");
  const rows = await db.query(
    `select id::text as id, title from track where title in (${list})`,
  );
  return titles.map((title) => {
    const row = rows.find((r) => r.title === title);
    if (!row) throw new Error(`No track is titled "${title}"`);
    return String(row.id);
  });
}

/** Saves a playlist named `name` at the top of the explorer, holding the tracks
 * titled `titles` in that order (positions 1…n), as the app itself would
 * create it. */
async function arrangePlaylist(
  api: Api,
  db: Db,
  name: string,
  titles: readonly string[],
): Promise<void> {
  const presets = await api.rpc<Preset[]>("preset.list");
  const top = await db.value(
    "select coalesce(min(position), 1) - 1 from app.source where source_folder is null",
  );
  const tracks = await trackIds(db, titles);
  await api.rpc(
    "dml",
    toDmlRequest(
      createPlaylistWrites(
        {
          sourceId: crypto.randomUUID(),
          playlistId: crypto.randomUUID(),
          name,
          createdAt: Math.floor(E2E_NOW.getTime() / 1000),
          folder: null,
          position: Number(top),
          definition: playlistDefinitionToStored(
            newPlaylistDefinition(presets),
          ),
        },
        tracks.map((track, i) => ({ track, position: i + 1 })),
        () => crypto.randomUUID(),
      ),
    ),
  );
}

/** The titles the active tab's rows show, in order. */
async function titles(app: App, of: readonly string[]): Promise<string[]> {
  const lines = (await app.grid.text()).trimEnd().split("\n");
  return lines.map((line) => {
    const title = line.split("\t").find((cell) => of.includes(cell));
    return title ?? `?? ${line}`;
  });
}

const ROAD_TRIP = ["Dreams", "The Chain", "Go Your Own Way", "Songbird"];

test("a playlist made from the explorer is listed there, and stays", async ({
  app,
  page,
}) => {
  await test.step("Add playlist puts a new one at the top, up for naming", async () => {
    await app.openExplorer();
    await page.getByRole("button", { name: "Source list actions" }).click();
    const created = rpcAnswered(page, "dml");
    await page.getByRole("menuitem", { name: "Add playlist" }).click();
    await created;
    const field = page.getByRole("textbox", { name: "Playlist name" });
    await expect(field).toBeFocused();
    await look(page, "naming");

    const renamed = rpcAnswered(page, "source.rename");
    await field.fill("Road Trip");
    await field.press("Enter");
    await renamed;
    await expect(app.source("Road Trip")).toBeVisible();
    await look(page, "named");
  });

  await test.step("it's still there, named, after a reload", async () => {
    await app.reload();
    await app.openExplorer();
    await expect(app.sources).toMatchAriaSnapshot(`
      - tree "Sources":
        - treeitem "Road Trip" [level=1]
        - treeitem "Tracks" [level=1]
        - treeitem "Albums" [level=1]
        - treeitem "Artists" [level=1]
    `);
    await look(page, "after-reload");
  });
});

test("tracks added from Tracks' row menu land at the playlist's end, in order", async ({
  page,
  api,
  db,
}) => {
  await arrangePlaylist(api, db, "Road Trip", ["Songbird"]);
  const app = new App(page);
  await app.load();

  await test.step("select three tracks in Tracks", async () => {
    await app.openSource("Tracks");
    await (await app.grid.row("Dreams")).click();
    await (await app.grid.row("The Chain")).click({ modifiers: ["Control"] });
    await (
      await app.grid.row("Go Your Own Way")
    ).click({
      modifiers: ["Control"],
    });
    await look(page, "selected");
  });

  await test.step("add them through the row menu's dialog", async () => {
    await (await app.grid.row("Go Your Own Way")).openMenu();
    await page.getByRole("menuitem", { name: "Add to playlist…" }).click();
    const dialog = page.getByRole("dialog", { name: "Add to playlist" });
    await expect(dialog.getByText("3 tracks", { exact: true })).toBeVisible();
    await look(page, "dialog");
    await dialog.getByRole("treeitem", { name: "Road Trip" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("toast")).toHaveText(
      "Added 3 tracks to “Road Trip”",
    );
  });

  await test.step("the playlist lists them after what it held, as Tracks shows them", async () => {
    await app.openSource("Road Trip");
    await expect.poll(() => app.grid.rowCount()).toBe(4);
    expect(await app.grid.text()).toMatchSnapshot("added.txt");
    await look(page, "playlist");
  });

  await test.step("and still does after a reload", async () => {
    await app.reload();
    await app.openSource("Road Trip");
    await expect.poll(() => app.grid.rowCount()).toBe(4);
    expect(await app.grid.text()).toMatchSnapshot("added.txt");
  });
});

test("dragging a playlist's row moves it, and the order stays", async ({
  page,
  api,
  db,
}) => {
  await arrangePlaylist(api, db, "Road Trip", ROAD_TRIP);
  const app = new App(page);
  await app.load();
  await app.openSource("Road Trip");
  await expect.poll(() => titles(app, ROAD_TRIP)).toEqual(ROAD_TRIP);

  await test.step("drag Songbird up, between Dreams and The Chain", async () => {
    const from = await (await app.grid.row("Songbird")).point();
    const to = await (await app.grid.row("The Chain")).box();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x + 40, to.y + 2, { steps: 10 });
    await expect(page.getByText("1 track", { exact: true })).toBeVisible();
    await look(page, "dragging");
    const moved = rpcAnswered(page, "dml");
    await page.mouse.up();
    await moved;
    await app.settled();
  });

  const order = ["Dreams", "Songbird", "The Chain", "Go Your Own Way"];
  await test.step("the rows follow the drop", async () => {
    await expect.poll(() => titles(app, ROAD_TRIP)).toEqual(order);
    expect(await app.grid.text()).toMatchSnapshot("reordered.txt");
    await look(page, "dropped");
  });

  await test.step("and keep the order after a reload", async () => {
    await app.reload();
    await app.openSource("Road Trip");
    await expect.poll(() => titles(app, ROAD_TRIP)).toEqual(order);
  });
});

test("an entry removed from the row menu is gone from the playlist, not the library", async ({
  page,
  api,
  db,
}) => {
  await arrangePlaylist(api, db, "Road Trip", ROAD_TRIP);
  const app = new App(page);
  await app.load();
  await app.openSource("Road Trip");
  await expect.poll(() => titles(app, ROAD_TRIP)).toEqual(ROAD_TRIP);

  const rest = ["Dreams", "Go Your Own Way", "Songbird"];
  await test.step("remove The Chain", async () => {
    await (await app.grid.row("The Chain")).openMenu();
    const removed = rpcAnswered(page, "dml");
    await page.getByRole("menuitem", { name: "Remove from playlist" }).click();
    await removed;
    await app.settled();
    await expect.poll(() => titles(app, ROAD_TRIP)).toEqual(rest);
    await look(page, "removed");
  });

  await test.step("it stays gone after a reload", async () => {
    await app.reload();
    await app.openSource("Road Trip");
    await expect.poll(() => titles(app, ROAD_TRIP)).toEqual(rest);
  });

  await test.step("and the track is still in Tracks", async () => {
    await app.openSource("Tracks");
    await expect.poll(() => app.grid.rowCount()).toBe(63);
    await expect.poll(() => app.grid.find("The Chain")).not.toBeNull();
    await look(page, "tracks");
  });
});
