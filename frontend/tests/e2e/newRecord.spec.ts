import type { Page } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import { rpcAnswered, type App } from "./support/app";

// Adding a record from a query page: the toolbar's "New …" button opens the
// record editor on a blank record of the query's base table, and saving it
// inserts it. The query re-runs, so the record shows among the rows, and the
// editor moves on to it as the database now holds it.

/** The record-editor sidebar, as it's named while creating a record and once
 * it has (the explorer is an `<aside>` too, so it's matched on its name). */
const editorPanel = (page: Page) =>
  page.getByRole("complementary", { name: /^(New|Edit) album$/ });

const TITLE = "Live at the Hollow Hill";

async function openAlbums(app: App, rows: number): Promise<void> {
  if ((await app.activeTabName()) !== "Albums") await app.openSource("Albums");
  await expect.poll(() => app.grid.rowCount()).toBe(rows);
}

test("a new album is saved, shows among the rows and stays after a reload", async ({
  app,
  page,
  db,
}) => {
  await openAlbums(app, 6);
  const editor = editorPanel(page);

  await test.step("the toolbar opens the editor on a blank album", async () => {
    await page.getByRole("button", { name: "New album" }).click();
    await expect(editor.getByRole("heading")).toHaveText("New album");
    // Nothing to save until something is filled in.
    await expect(editor.getByRole("button", { name: "Save" })).toBeHidden();
    await look(page, "blank");
  });

  await test.step("type its title straight away, and save", async () => {
    // The first field is open for typing as the editor opens.
    await expect(editor.locator("textarea:not([readonly])")).toBeFocused();
    await page.keyboard.type(TITLE);
    await page.keyboard.press("Escape");
    await look(page, "filled-in");
    const saved = rpcAnswered(page, "dml");
    await editor.getByRole("button", { name: "Save" }).click();
    await saved;
  });

  await test.step("the editor is on the album the database holds", async () => {
    await expect(editor.getByRole("heading")).toHaveText("Edit album");
    await expect(editor.getByText(TITLE, { exact: true })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Save" })).toBeHidden();
    expect(
      Number(
        await db.value(`select count(*) from album where title = '${TITLE}'`),
      ),
    ).toBe(1);
    await look(page, "saved");
  });

  await test.step("the rows include it, before and after a reload", async () => {
    await expect.poll(() => app.grid.rowCount()).toBe(7);
    expect(await app.grid.find(TITLE)).not.toBeNull();
    await app.reload();
    await openAlbums(app, 7);
    expect(await app.grid.find(TITLE)).not.toBeNull();
  });
});
