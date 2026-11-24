import type { Locator, Page } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import { rpcAnswered, type App } from "./support/app";

// Writing records from the results: the record editor on one track and on
// several at once, and the row menu's "Rate track". Each write is read back
// through the grid, then again after a reload, which proves it reached the
// database rather than only the page.

/** The record-editor sidebar (the explorer is an `<aside>` too, so it's
 * matched on its name). */
const editorPanel = (page: Page) =>
  page.getByRole("complementary", { name: /^Edit / });

/** The editor's open value input: a field being edited. */
const valueEditor = (editor: Locator) =>
  editor.locator("textarea:not([readonly])");

/** The Tracks grid's columns, by position in a row of `app.grid.text()`. */
const TITLE = 1;
const RATING = 4;

/** Every row of the active tab's grid, split into its cells. */
async function gridRows(app: App): Promise<string[][]> {
  return (await app.grid.text())
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"));
}

/** The titles of the rows `first` … `last`, as the grid shows them. */
async function titlesOf(app: App, first: number, last: number) {
  return (await gridRows(app))
    .slice(first, last + 1)
    .map((cells) => cells[TITLE]);
}

/** The rating column of the track titled `title`, as the grid shows it. */
async function ratingOf(app: App, title: string): Promise<string | undefined> {
  return (await gridRows(app)).find((cells) => cells[TITLE] === title)?.[
    RATING
  ];
}

/** How many rows are titled `title`. */
async function countTitled(app: App, title: string): Promise<number> {
  return (await gridRows(app)).filter((cells) => cells[TITLE] === title).length;
}

/** Opens Tracks and waits for all of its rows, and for their records. */
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

/** Waits until the editor has nothing left to save: Reset and Save show only
 * while the form holds changes, and stay up ("Saving…") until the save has
 * landed. */
async function expectSaved(editor: Locator): Promise<void> {
  await expect(editor.getByRole("button", { name: "Reset" })).toBeHidden();
  await expect(editor.getByRole("button", { name: /^Sav/ })).toBeHidden();
}

test("a retitled track keeps its title after a reload", async ({
  app,
  page,
}) => {
  await openTracks(app);
  const editor = editorPanel(page);

  await test.step("open the record editor from the row's menu", async () => {
    await (await app.grid.row("Lovely Rita")).openMenu();
    await page.getByRole("menuitem", { name: "Edit track" }).click();
    await expect(editor.getByRole("heading")).toHaveText("Edit track");
    await expect(
      editor.getByText("Lovely Rita", { exact: true }),
    ).toBeVisible();
    await look(page, "editor-open");
  });

  await test.step("retitle it and save", async () => {
    await editor.getByText("Lovely Rita", { exact: true }).click();
    await valueEditor(editor).fill("Lovely Rita (meter maid)");
    await page.keyboard.press("Escape");
    await look(page, "edited");
    const saved = rpcAnswered(page, "dml");
    await editor.getByRole("button", { name: "Save" }).click();
    await saved;
    await expectSaved(editor);
    await look(page, "saved");
  });

  await test.step("the grid row follows", async () => {
    await expect.poll(() => app.grid.find("Lovely Rita")).toBeNull();
    await expect
      .poll(() => app.grid.find("Lovely Rita (meter maid)"))
      .not.toBeNull();
  });

  await test.step("and it's still there after a reload", async () => {
    await reloadTracks(app);
    expect(await app.grid.find("Lovely Rita (meter maid)")).not.toBeNull();
    expect(await app.grid.find("Lovely Rita")).toBeNull();
    await look(page, "after-reload");
  });
});

test("one edit in the record editor lands on every selected track", async ({
  app,
  page,
}) => {
  await openTracks(app);
  const editor = editorPanel(page);
  const first = (await app.grid.find("Getting Better"))!;
  const last = first + 2;
  const titles = await titlesOf(app, first, last);
  expect(titles).toEqual([
    "Getting Better",
    "Good Morning Good Morning",
    "Lovely Rita",
  ]);

  await test.step("select three rows and open the editor on them", async () => {
    await (await app.grid.row(first)).click();
    await (await app.grid.row(last)).click({ modifiers: ["Shift"] });
    await (await app.grid.row(last)).openMenu();
    await page.getByRole("menuitem", { name: "Edit track" }).click();
    await expect(editor.getByRole("heading")).toHaveText("Edit 3 tracks");
    // What three real tracks agree on, and how many values they hold where
    // they don't, as the backend aggregates them. The multi-record fields'
    // counts are the last to land.
    await expect(
      editor.getByRole("button", { name: "Expand plays" }),
    ).toBeVisible();
    const embedded = editor.locator(".rc-embedded");
    await expect(embedded.first()).toContainText("Sgt. Pepper");
    await expect(embedded.nth(1)).toContainText("Like");
    await look(page, "editor-on-three");
    await expect(editor).toMatchAriaSnapshot({ name: "bulk-editor.aria.yml" });
  });

  await test.step("give all three one title, and save", async () => {
    await editor.getByRole("button", { name: "Expand title" }).click();
    await editor
      .getByRole("button", { name: "Use this value for all records" })
      .first()
      .click();
    await valueEditor(editor).fill("Side Two Medley");
    await page.keyboard.press("Escape");
    await look(page, "edited");
    const saved = rpcAnswered(page, "dml");
    await editor.getByRole("button", { name: "Save" }).click();
    await saved;
    await expectSaved(editor);
    await look(page, "saved");
  });

  await test.step("every one of the rows follows", async () => {
    await expect.poll(() => countTitled(app, "Side Two Medley")).toBe(3);
    for (const title of titles) {
      expect(await app.grid.find(title)).toBeNull();
    }
  });

  await test.step("and they're all still there after a reload", async () => {
    await reloadTracks(app);
    expect(await countTitled(app, "Side Two Medley")).toBe(3);
    for (const title of titles) {
      expect(await app.grid.find(title)).toBeNull();
    }
    await look(page, "after-reload");
  });
});

test("the row menu rates a track, rated or not, and the rating stays", async ({
  app,
  page,
  api,
  db,
}) => {
  await test.step("arrange an unrated track", async () => {
    // Every track in the sample library is rated, so make one that isn't.
    const id = await db.value(
      "SELECT id::VARCHAR FROM track WHERE title = 'Good Morning Good Morning'",
    );
    await api.rpc("dml", {
      operations: [
        {
          operation: "update",
          id: "unrate",
          table: "track",
          where: { id: id as string },
          values: { rating: null },
        },
      ],
    });
  });

  await openTracks(app);
  expect(await ratingOf(app, "Getting Better")).toBe("✔️");
  expect(await ratingOf(app, "Good Morning Good Morning")).toBe("");

  /** Rates the track titled `title` through its row menu. */
  async function rate(title: string, rating: RegExp) {
    await (await app.grid.row(title)).openMenu();
    const menu = page.getByRole("menu").first();
    await menu.getByRole("menuitem", { name: "Rate track" }).click();
    const ratings = menu.getByRole("menu");
    await expect(ratings.getByRole("menuitem")).toHaveText([
      "-1: 🗑️ (Skip)",
      "0: ✔️ (Like)",
      "1: ⭐ (Prefer)",
      "2: ❤️ (Love)",
    ]);
    await look(page, `rate-${title}`);
    const saved = rpcAnswered(page, "dml");
    await ratings.getByRole("menuitem", { name: rating }).click();
    await saved;
    await expect(menu).toBeHidden();
  }

  await test.step("a liked track becomes loved", async () => {
    await rate("Getting Better", /Love/);
    await expect.poll(() => ratingOf(app, "Getting Better")).toBe("❤️");
  });

  await test.step("the unrated track gets its first rating", async () => {
    await rate("Good Morning Good Morning", /Prefer/);
    await expect
      .poll(() => ratingOf(app, "Good Morning Good Morning"))
      .toBe("⭐");
    await look(page, "rated");
  });

  await test.step("both ratings are still there after a reload", async () => {
    await reloadTracks(app);
    expect(await ratingOf(app, "Getting Better")).toBe("❤️");
    expect(await ratingOf(app, "Good Morning Good Morning")).toBe("⭐");
  });
});
