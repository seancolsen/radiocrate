import type { Locator, Page } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import { rpcAnswered, type App } from "./support/app";

// The Data structure page against the real server: hiding one of the track
// table's fields there takes it out of every record editor's form, through
// `metadata.field.set_visible` and the field metadata the form is shaped by,
// and un-hiding it brings it back. What the page looks like, and how its tree
// behaves, is `tests/visual/structure.spec.ts`'s.

/** The record-editor sidebar (the explorer is an `<aside>` too, so it's
 * matched on its name). */
const editorPanel = (page: Page) =>
  page.getByRole("complementary", { name: /^Edit / });

/** The Data structure page's tree. */
const structureTree = (page: Page) =>
  page.getByRole("tree", { name: "Data structure" });

/** A row of the tree, by the first word of what it says (a field's name,
 * "Fields"), or by a pattern. */
function treeRow(tree: Locator, name: string | RegExp): Locator {
  return tree.getByRole("treeitem", {
    name: typeof name === "string" ? new RegExp(`^${name} `) : name,
  });
}

/** A tab's handle in the tab bar, by its name. */
const tabHandle = (page: Page, name: string) =>
  page.locator("[data-tab-id]", { hasText: name });

/** The field this journey hides: a column of the track table, which the form shows. */
const FIELD = "track_number";

/** Opens the record editor on the track titled `title`, from its row menu. */
async function editTrack(app: App, page: Page, title: string): Promise<void> {
  await (await app.grid.row(title)).openMenu();
  await page.getByRole("menuitem", { name: "Edit track" }).click();
  const editor = editorPanel(page);
  await expect(editor.getByRole("heading")).toHaveText("Edit track");
  await expect(editor.getByText(title, { exact: true })).toBeVisible();
}

/** Opens the Data structure page from the Settings menu, with the track
 * table's fields listed. */
async function openTrackFields(app: App, page: Page): Promise<Locator> {
  await app.openExplorer();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Data structure" }).click();
  await expect.poll(() => app.activeTabName()).toBe("Data structure");
  const tree = structureTree(page);
  // The table's row says how big it is ("track 63 rows × 9 columns"), which
  // tells it from its "track tags" field's.
  for (const name of [/^track \d/, "Fields"]) {
    const row = treeRow(tree, name);
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
  }
  return tree;
}

/** Hides or un-hides the field from its row's context menu, and waits for
 * the write. */
async function setHidden(page: Page, tree: Locator, hidden: boolean) {
  await treeRow(tree, FIELD).click({ button: "right" });
  const written = rpcAnswered(page, "metadata.field.set_visible");
  await page
    .getByRole("menuitem", { name: hidden ? "Hide field" : "Un-hide field" })
    .click();
  const response = await written;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({
    params: { field: { columnName: FIELD }, visible: !hidden },
  });
}

test("a field hidden on the Data structure page leaves the record editor, and comes back when un-hidden", async ({
  app,
  page,
}) => {
  // Two trips to the Data structure page and a reload.
  test.setTimeout(60_000);
  const editor = editorPanel(page);
  // On one track, a short value is edited in place, in a textbox named for
  // its field.
  const fieldInForm = editor.getByRole("textbox", { name: FIELD, exact: true });

  await test.step("the record editor on a track shows its track_number", async () => {
    await app.openSource("Tracks");
    await expect.poll(() => app.grid.rowCount()).toBe(63);
    await editTrack(app, page, "Lovely Rita");
    await expect(fieldInForm).toBeVisible();
    await look(page, "editor-with-field");
  });

  await test.step("hide track_number on the Data structure page", async () => {
    const tree = await openTrackFields(app, page);
    await expect(treeRow(tree, FIELD)).toBeVisible();
    await setHidden(page, tree, true);
    // Hidden fields are listed only under "Show hidden fields".
    await expect(treeRow(tree, FIELD)).toHaveCount(0);
    await look(page, "hidden-on-structure-page");
  });

  await test.step("the open record editor follows: no track_number", async () => {
    await tabHandle(page, "Tracks").click();
    await expect.poll(() => app.activeTabName()).toBe("Tracks");
    await expect(editor.getByRole("heading")).toHaveText("Edit track");
    await expect(fieldInForm).toHaveCount(0);
    await look(page, "editor-without-field");
  });

  await test.step("after a reload, a record editor opened afresh still leaves it out", async () => {
    await app.reload();
    if ((await app.activeTabName()) !== "Tracks") {
      await tabHandle(page, "Tracks").click();
    }
    await expect.poll(() => app.grid.rowCount()).toBe(63);
    if (!(await editor.isVisible())) await editTrack(app, page, "Lovely Rita");
    await expect(
      editor.getByText("Lovely Rita", { exact: true }),
    ).toBeVisible();
    await expect(fieldInForm).toHaveCount(0);
    await expect(editor).toMatchAriaSnapshot({
      name: "editor-without-field.aria.yml",
    });
    await look(page, "after-reload");
  });

  await test.step("un-hide it, under “Show hidden fields”", async () => {
    const tree = await openTrackFields(app, page);
    await treeRow(tree, "Fields")
      .getByRole("button", { name: "Show hidden fields" })
      .click();
    await expect(treeRow(tree, FIELD)).toBeVisible();
    await setHidden(page, tree, false);
    await look(page, "unhidden-on-structure-page");
  });

  await test.step("the record editor shows track_number again", async () => {
    await tabHandle(page, "Tracks").click();
    await expect.poll(() => app.activeTabName()).toBe("Tracks");
    await expect(fieldInForm).toBeVisible();
    await look(page, "editor-with-field-again");
  });
});
