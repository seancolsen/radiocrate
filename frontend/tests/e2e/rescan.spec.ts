import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import { type App, rpcAnswered } from "./support/app";
import type { Db } from "./support/api";

// Re-scanning a collection the user has changed on disk, against the real
// scanner: each test gets its own copy of the sample library's audio files
// (`server.collection`, mtimes preserved, so a re-scan of the untouched copy
// finds nothing to do), changes it as a user would in a file manager or a
// tagger, re-scans from the Settings menu and reads Tracks again.
//
// The scanner matches each file it finds to a record by its path, then by its
// content's hash (`backend/src/scanner/classify.rs`): a known path is the same
// file (modified, if its size or mtime changed); an unknown path whose content
// matches a record whose file is gone is that file, moved; anything else is
// new. It never deletes a record whose file is missing.
//
// Only `server.collection` is ever changed here, never the suite's shared copy.

test.use({ privateCollection: true });

const RUMOURS = "Fleetwood Mac - Rumours";
const DARK_SIDE = "Pink Floyd - The Dark Side of the Moon";

/** The active page's toolbar (other tabs' pages stay mounted, hidden). */
function toolbar(page: Page) {
  return page.getByTestId("query-toolbar").filter({ visible: true });
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

/** The grid's lines, as `Grid.text` writes them, sorted: what the rows say,
 * whatever order an unsorted query returns them in. */
async function sortedLines(app: App): Promise<string[]> {
  return (await app.grid.text()).trimEnd().split("\n").sort();
}

/** The grid's line for the track titled `title`; `null` when there's none. */
async function trackLine(app: App, title: string): Promise<string | null> {
  const index = await app.grid.find(title);
  if (index === null) return null;
  return (await app.grid.text()).split("\n")[index] ?? null;
}

/** The path the database holds for the file of the track titled `title`
 * (none for a missing track, several for a title held by several). */
async function filePaths(db: Db, title: string): Promise<string[]> {
  const rows = await db.query(`
    select f.path from track t join file f on f.id = t.file
    where t.title = '${title.replace(/'/g, "''")}' order by f.path`);
  return rows.map((r) => String(r.path));
}

/** Sets Vorbis comments on a FLAC file in place, replacing any of the same
 * name and keeping the rest, as a tagger does. Only the comment block is
 * rewritten; the audio is untouched. */
function retag(file: string, tags: Record<string, string>): void {
  const data = fs.readFileSync(file);
  if (data.toString("latin1", 0, 4) !== "fLaC") {
    throw new Error(`${file} isn't a FLAC file`);
  }
  // Each metadata block: a byte of last-flag and type, 3 bytes of length.
  const blocks: { type: number; body: Buffer }[] = [];
  let offset = 4;
  for (let last = false; !last;) {
    const header = data[offset]!;
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = data.readUIntBE(offset + 1, 3);
    const body = data.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    blocks.push({ type, body: type === 4 ? withTags(body, tags) : body });
  }
  const out: Buffer[] = [data.subarray(0, 4)];
  blocks.forEach(({ type, body }, i) => {
    const header = Buffer.alloc(4);
    header[0] = (i === blocks.length - 1 ? 0x80 : 0) | type;
    header.writeUIntBE(body.length, 1, 3);
    out.push(header, body);
  });
  out.push(data.subarray(offset));
  fs.writeFileSync(file, Buffer.concat(out));
}

/** A Vorbis comment block's body with `tags` set. */
function withTags(body: Buffer, tags: Record<string, string>): Buffer {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const vendorLength = body.readUInt32LE(0);
  const vendor = body.subarray(4, 4 + vendorLength);
  let offset = 4 + vendorLength;
  const count = body.readUInt32LE(offset);
  offset += 4;
  const replaced = new Set(Object.keys(tags).map((k) => k.toUpperCase()));
  const comments: string[] = [];
  for (let i = 0; i < count; i++) {
    const length = body.readUInt32LE(offset);
    const comment = body.toString("utf8", offset + 4, offset + 4 + length);
    offset += 4 + length;
    const key = comment.slice(0, comment.indexOf("=")).toUpperCase();
    if (!replaced.has(key)) comments.push(comment);
  }
  for (const [key, value] of Object.entries(tags)) {
    comments.push(`${key.toUpperCase()}=${value}`);
  }
  const parts = [u32(vendor.length), vendor, u32(comments.length)];
  for (const comment of comments) {
    const bytes = Buffer.from(comment, "utf8");
    parts.push(u32(bytes.length), bytes);
  }
  return Buffer.concat(parts);
}

test("a file added to the collection shows up in Tracks after a re-scan", async ({
  app,
  page,
  server,
}) => {
  await app.openSource("Tracks");
  await expect(toolbar(page).getByText("63 tracks")).toBeVisible();
  const dreams = await trackLine(app, "Dreams");

  await test.step("add a live recording of Dreams in an album folder of its own", async () => {
    const folder = path.join(server.collection, `${RUMOURS} (Live)`);
    const file = path.join(folder, "02. Dreams (Live).flac");
    fs.mkdirSync(folder);
    fs.copyFileSync(
      path.join(server.collection, RUMOURS, "02. Dreams.flac"),
      file,
    );
    retag(file, { title: "Dreams (Live)", album: "Rumours (Live)" });
  });

  await test.step("re-scan, and Tracks has it", async () => {
    await rescan(app, page);
    await refresh(app, page);
    await expect(toolbar(page).getByText("64 tracks")).toBeVisible();
    // New: by the same artist, from its own tags, unrated and never played.
    expect(await trackLine(app, "Dreams (Live)")).toMatch(
      /^Fleetwood Mac\tDreams \(Live\)\t1977\t4:18\t\t0\D*\t$/,
    );
    // The studio recording it was copied from is untouched.
    expect(await trackLine(app, "Dreams")).toBe(dreams);
    await look(page, "added");
  });

  await test.step("its folder is a new album", async () => {
    await app.openSource("Albums");
    await expect(toolbar(page).getByText("7 albums")).toBeVisible();
    expect(await app.grid.find("Rumours (Live)")).not.toBeNull();
    await look(page, "albums");
  });
});

test("an album folder renamed on disk keeps its tracks' ratings and plays after a re-scan", async ({
  app,
  page,
  server,
  db,
}) => {
  const renamed = `${DARK_SIDE} (2023 Remaster)`;
  await app.openSource("Tracks");
  await expect(toolbar(page).getByText("63 tracks")).toBeVisible();
  const before = await sortedLines(app);

  await test.step("rename the album's folder", async () => {
    fs.renameSync(
      path.join(server.collection, DARK_SIDE),
      path.join(server.collection, renamed),
    );
  });

  await test.step("re-scan: the same tracks, rated and played as before", async () => {
    await rescan(app, page);
    await refresh(app, page);
    await expect(toolbar(page).getByText("63 tracks")).toBeVisible();
    expect(await sortedLines(app)).toEqual(before);
    await look(page, "after-rename");
  });

  await test.step("their files were moved, not added", async () => {
    expect(await filePaths(db, "Time")).toEqual([`./${renamed}/04. Time.flac`]);
    expect(await db.value("select count(*) from file")).toBe(63n);
  });
});

test("a retagged file stays the same track after a re-scan, keeping its rating and plays", async ({
  app,
  page,
  server,
}) => {
  await app.openSource("Tracks");
  await expect(toolbar(page).getByText("63 tracks")).toBeVisible();
  const before = await sortedLines(app);
  const money = await trackLine(app, "Money");
  expect(money).toMatch(/^Pink Floyd\tMoney\t/);

  await test.step("retitle Money in its tags", async () => {
    retag(path.join(server.collection, DARK_SIDE, "06. Money.flac"), {
      title: "Money (2023 Remaster)",
    });
  });

  await test.step("re-scan: no new track, and Money's rating and plays are kept", async () => {
    await rescan(app, page);
    await refresh(app, page);
    await expect(toolbar(page).getByText("63 tracks")).toBeVisible();
    // Whichever title the row now shows, everything else reads as before.
    const after = await sortedLines(app);
    expect(
      after.map((line) => line.replace("Money (2023 Remaster)", "Money")),
    ).toEqual(before);
    await look(page, "after-retag");
  });
});

// BUG: a re-scan never reads the tags of a file it already knows. A file whose
// size or mtime changed is classified "modified", and the merge
// (`BATCH_SQL` in `backend/src/scanner/staging.rs`) updates only its `file`
// row's hash, size, duration and mtime; `ModifiedEntry` doesn't even carry the
// tags. So a title, album or artist fixed in a tagger never reaches the
// library. (Possibly deliberate, since the library's own edits would be
// overwritten; then this test should say the opposite.)
test("a retagged file shows its new title after a re-scan", async ({
  app,
  page,
  server,
}) => {
  test.fail();
  await app.openSource("Tracks");
  const money = await trackLine(app, "Money");
  expect(money).toMatch(/^Pink Floyd\tMoney\t/);

  retag(path.join(server.collection, DARK_SIDE, "06. Money.flac"), {
    title: "Money (2023 Remaster)",
  });
  await rescan(app, page);
  await refresh(app, page);

  expect(await trackLine(app, "Money (2023 Remaster)")).toBe(
    money!.replace("Money", "Money (2023 Remaster)"),
  );
});

// BUG: a byte-for-byte copy of a file steals the original's record instead of
// becoming a track of its own. `classify_file` (`backend/src/scanner/classify.rs`)
// treats an unknown path whose hash matches a known file as that file, moved,
// when `Path::new(original_path).exists()` is false. But since paths are stored
// relative to the collection (`./Fleetwood Mac - Rumours/02. Dreams.flac`),
// that check resolves against the server's working directory, not the
// collection root, so it's false for every file whenever the server wasn't
// started from the collection. The original's record moves to the copy, the
// original file is left with none, and the next re-scan moves it back.
test("a copy of a file is a track of its own after a re-scan", async ({
  app,
  page,
  server,
  db,
}) => {
  test.fail();
  await app.openSource("Tracks");
  await expect(toolbar(page).getByText("63 tracks")).toBeVisible();

  const favorites = path.join(server.collection, "Favorites");
  fs.mkdirSync(favorites);
  fs.copyFileSync(
    path.join(server.collection, RUMOURS, "02. Dreams.flac"),
    path.join(favorites, "Dreams.flac"),
  );
  await rescan(app, page);
  await refresh(app, page);

  expect(await filePaths(db, "Dreams")).toEqual([
    "./Favorites/Dreams.flac",
    `./${RUMOURS}/02. Dreams.flac`,
  ]);
  expect(await app.grid.rowCount()).toBe(64);
});
