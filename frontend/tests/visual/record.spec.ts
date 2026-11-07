import { test, expect, type Locator, type Page } from "@playwright/test";
import { SCHEMES, openStory, snapshot, valueEditor } from "./harness";

// The record editor, on its own: the panel as its form lands and opened out,
// mid-edit and after a refused save; the modal picker it opens; and the
// embedded-record widget, straight from cells.

/** The red ✱ marking one field — or one embedded record — as modified. */
const star = (panel: Locator, label: string) =>
  panel.locator(`[aria-label="${label} modified"]`);

/** Raises a field's context menu and takes one of its entries. */
async function openEmbedEditor(
  page: Page,
  stage: Locator,
  field: string,
  entry: "Display" | "Sorting",
) {
  await fieldLabelOf(stage, field).click({ button: "right" });
  await page.getByRole("menuitem", { name: entry, exact: true }).click();
}

const fieldLabelOf = (stage: Locator, name: string) =>
  stage
    .locator("[data-form-item]")
    .filter({ has: stage.page().getByText(name, { exact: true }) })
    .first();

/** The editable part of a field's Querydown editor, by its accessible name. */
const embedEditor = (stage: Locator, name: string) =>
  stage.getByRole("textbox", { name, exact: true });

/** Replaces everything in the focused editor. */
async function rewrite(page: Page, text: string) {
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

for (const colorScheme of SCHEMES) {
  // As the form lands: every field of `track`, values and counts loaded,
  // everything collapsed.
  test(`record-editor/items-collapsed - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/items-collapsed",
      colorScheme,
    );
    await expect(
      stage.getByText("Pray You Catch Me", { exact: true }),
    ).toBeVisible();
    // The `file` link's embedded record is a second request; wait for it, so
    // the widget is filled rather than caught empty.
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/items-collapsed", colorScheme),
    );
  });

  // …and opened out: a long text field expanded below its label, a
  // multi-record field listing its records, and one of those expanded into its
  // own form.
  test(`record-editor/items-expanded - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/items-expanded",
      colorScheme,
    );
    await stage.getByRole("button", { name: "Expand title" }).click();
    await stage.getByRole("button", { name: "Expand credits" }).click();
    await stage.getByRole("button", { name: /^Expand Jack White/ }).click();
    // "Featured" is on screen twice by now — in the credit's own preview and in
    // the form it just opened — so this waits on the form's copy.
    await expect(stage.getByText("Featured").last()).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/items-expanded", colorScheme),
    );
  });

  // Mid-edit: an edited field and a record being created under `credit`, each
  // starred, and the "+" buttons that put it there.
  test(`record-editor/modified - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "record-editor/modified", colorScheme);
    await stage.getByText("6 Inch", { exact: true }).click();
    await valueEditor(stage).fill("6 Inch (Live)");
    await page.keyboard.press("Escape");
    await stage.getByRole("button", { name: "Add credit" }).click();
    await expect(stage.locator("[data-selectable]").first()).toHaveText("New");
    await expect(valueEditor(stage)).toBeFocused();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/modified", colorScheme),
    );
  });

  // A save the database refused: what it said, above a form still holding the
  // change it couldn't write.
  test(`record-editor/save-error - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/save-error",
      colorScheme,
    );
    await stage.getByText("Pray You Catch Me", { exact: true }).click();
    await valueEditor(stage).fill("Sorry");
    await page.keyboard.press("Escape");
    await expect(star(stage, "title")).toBeVisible();
    await stage.getByRole("button", { name: "Save" }).click();
    await expect(stage.getByRole("alert")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/save-error", colorScheme),
    );
  });

  // The editor on two records at once: the same form, showing what they agree
  // on and — where they don't — how many values they hold between them, which
  // the row expands into (`record-editor/varied-expanded` does the expanding).
  // Beside each multi-record field, how many records it has for each of them.
  test(`record-editor/bulk - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "record-editor/bulk", colorScheme);
    await expect(stage.getByRole("heading")).toHaveText("Edit 2 tracks");
    // Both records' data has landed once the multi-record fields can be
    // opened, which takes the counts of every one of them.
    await expect(
      stage.getByRole("button", { name: "Expand credits" }),
    ).toBeVisible();
    await expect(
      stage.getByRole("button", { name: "Expand plays" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/bulk", colorScheme),
    );
  });

  // …with one of those fields opened out. Both tracks are credited to Beyoncé
  // at order 1, so that is one row standing for two records, over the one
  // credit each of them holds alone — and the shared row expands into the form
  // that edits both records at once.
  test(`record-editor/bulk-expanded - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/bulk-expanded",
      colorScheme,
    );
    await stage.getByRole("button", { name: "Expand credits" }).click();
    await expect(stage.locator("[data-selectable]")).toHaveCount(3);
    await stage.getByRole("button", { name: /^Expand Beyoncé/ }).click();
    // The artist both credits point at, previewed inside the row's own form —
    // a second request, so the widget is waited for rather than caught empty.
    await expect(stage.getByText("Beyoncé").nth(1)).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/bulk-expanded", colorScheme),
    );
  });

  // Two of the fields three records disagree on, opened out: the values they
  // hold, commonest first. `title` is three plain values; `rating` is a link,
  // so each of its values is the record it points at — and the commonest of
  // them is opened into its own form, as a field they agreed on would open into
  // the one record it points at.
  test(`record-editor/varied-expanded - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/varied-expanded",
      colorScheme,
    );
    await expect(stage.getByRole("heading")).toHaveText("Edit 3 tracks");
    await stage.getByRole("button", { name: "Expand title" }).click();
    await stage.getByRole("button", { name: "Expand rating" }).click();
    // Each distinct rating is a record of its own, previewed — a second
    // request apiece, so they're waited for rather than caught empty.
    await expect(stage.locator(".rc-embedded")).toHaveCount(2);
    await expect(stage.getByText("3.5", { exact: true })).toBeVisible();
    await stage.getByRole("button", { name: "Expand 4" }).click();
    await expect(stage.getByText("value", { exact: true })).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/varied-expanded", colorScheme),
    );
  });

  // The values a text field's records disagree on, edited where they stand:
  // the long one expanded below its row, and another in an open editor.
  test(`record-editor/varied-editing - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/varied-editing",
      colorScheme,
    );
    await expect(stage.getByRole("heading")).toHaveText("Edit 3 tracks");
    await stage.getByRole("button", { name: "Expand title" }).click();
    await stage
      .getByRole("button", { name: /^Expand Don't Hurt Yourself/ })
      .click();
    await stage.getByText("Hold Up", { exact: true }).click();
    await expect(valueEditor(stage)).toBeFocused();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/varied-editing", colorScheme),
    );
  });

  // A value's autocomplete, up: the chevron in its box and the column's values
  // under it. The list portals out of the panel, but lands on top of the stage.
  test(`record-editor/autocomplete - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/autocomplete",
      colorScheme,
    );
    await stage.getByRole("textbox", { name: "title" }).click();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByRole("option")).toHaveCount(5);
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/autocomplete", colorScheme),
    );
  });

  // The pager, which only comes up once the values overrun a page.
  test(`value-autocomplete/paged - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "value-autocomplete/paged",
      colorScheme,
    );
    await expect(page.getByText("1–50 of 120")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("value-autocomplete/paged", colorScheme),
    );
  });

  // The modal picker on its own: the search box with its sort and display
  // buttons, and the results as the embedded records they're about to become.
  // Shot through the dialog (it portals out of the stage).
  test(`record-picker/basic - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "record-picker/basic", colorScheme);
    const picker = page.getByRole("dialog");
    await expect(picker.getByTestId("picker-results")).toHaveAttribute(
      "data-rows",
      "3",
    );
    await expect(picker).toHaveScreenshot(
      snapshot("record-picker/basic", colorScheme),
    );
  });

  // One preview widget, from cells alone, in its selected state.
  test(`embedded-record/selected - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "embedded-record/selected",
      colorScheme,
    );
    await expect(stage.locator(".rc-embedded")).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("embedded-record/selected", colorScheme),
    );
  });
}

for (const colorScheme of SCHEMES) {
  // The user's own arrangement of a table: `title` first, and two hidden fields
  // on show, dimmed.
  test(`record-editor/fields-customized - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/fields-customized",
      colorScheme,
    );
    await expect(
      stage.getByText("Pray You Catch Me", { exact: true }),
    ).toBeVisible();
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/fields-customized", colorScheme),
    );
  });

  // The two rows under a field whose embedded record is being customized.
  test(`record-editor/embed-display - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/embed-display",
      colorScheme,
    );
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    await openEmbedEditor(page, stage, "file", "Display");
    await expect(
      embedEditor(stage, "Display of file").locator(".cm-line"),
    ).not.toBeEmpty();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/embed-display", colorScheme),
    );
  });

  test(`record-editor/embed-sorting - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/embed-sorting",
      colorScheme,
    );
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    await openEmbedEditor(page, stage, "credits", "Display");
    await openEmbedEditor(page, stage, "credits", "Sorting");
    await expect(stage.locator("[data-selectable]")).toHaveCount(2);
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/embed-sorting", colorScheme),
    );
  });

  test(`record-editor/embed-problem - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/embed-problem",
      colorScheme,
    );
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    await openEmbedEditor(page, stage, "file", "Display");
    await rewrite(page, "$nope");
    await expect(stage.getByRole("alert")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/embed-problem", colorScheme),
    );
  });

  // A field in hand: dimmed where it is, its chip by the pointer, and the drop
  // line in the gap it would land in.
  test(`record-editor/field-drag - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/field-drag",
      colorScheme,
    );
    await expect(
      stage.getByText("Pray You Catch Me", { exact: true }),
    ).toBeVisible();
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    await dragLabel(page, stage, "title", "disc_number", 0.1);
    await expect(stage.locator("[data-field-row].opacity-50")).toHaveCount(1);
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/field-drag", colorScheme),
    );
  });
}

/** One top-level field's label. */
function fieldLabel(stage: Locator, name: string): Locator {
  return stage
    .locator("[data-form-item]")
    .filter({ has: stage.page().getByText(name, { exact: true }) })
    .first();
}

/** The field labels on show, top to bottom. */
function fieldNames(stage: Locator): Promise<string[]> {
  return stage.locator("[data-form-item]").allInnerTexts();
}

/** Presses on `from`'s label and moves the mouse to a fraction `at` of the way
 * down `to`'s row, leaving the button down. */
async function dragLabel(
  page: Page,
  stage: Locator,
  from: string,
  to: string,
  at: number,
) {
  const a = (await fieldLabel(stage, from).boundingBox())!;
  const b = (await fieldLabel(stage, to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * at, { steps: 8 });
}

/** The params of every call the page has made to `method`, in order. */
function rpcCalls(page: Page, method: string): Promise<unknown[]> {
  return page.evaluate(
    (name) =>
      (window.__rpcCalls ?? [])
        .filter((call) => call.method === name)
        .map((call) => call.params),
    method,
  );
}

/** Opens the panel's actions menu. */
async function openActions(page: Page) {
  await page.getByRole("button", { name: "Record actions" }).click();
}

async function loaded(page: Page): Promise<Locator> {
  const stage = await openStory(page, "record-editor/items-collapsed", "light");
  await expect(
    stage.getByText("Pray You Catch Me", { exact: true }),
  ).toBeVisible();
  return stage;
}

test.describe("customizing embedded records", () => {
  const calls = (page: Page, method: string) =>
    page.evaluate(
      (m) => (window.__rpcCalls ?? []).filter((call) => call.method === m),
      method,
    );

  async function opened(page: Page, story = "record-editor/embed-display") {
    const stage = await openStory(page, story, "light");
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    return stage;
  }

  const menuEntries = (page: Page) =>
    page.getByRole("menuitem").allInnerTexts();

  test("each kind of field offers what it can customize, in its place", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/embed-sorting");
    await fieldLabelOf(stage, "file").click({ button: "right" });
    expect(await menuEntries(page)).toEqual([
      "Pick a record",
      "Enter a new record",
      "Display",
      "Clear",
      "Hide field",
    ]);
    await page.keyboard.press("Escape");

    await fieldLabelOf(stage, "credits").click({ button: "right" });
    expect(await menuEntries(page)).toEqual([
      "New record",
      "Display",
      "Sorting",
      "Delete all records",
      "Hide field",
    ]);
    await page.keyboard.press("Escape");

    await fieldLabelOf(stage, "title").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Display" })).toHaveCount(
      0,
    );
  });

  test("the editor opens on the generated Querydown, with the caret in it", async ({
    page,
  }) => {
    const stage = await opened(page);
    await openEmbedEditor(page, stage, "file", "Display");
    const editor = embedEditor(stage, "Display of file");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("$path");
    expect(await calls(page, "metadata.field.set_display")).toEqual([]);
  });

  test("what's typed shows as it settles, and saves on leaving the editor", async ({
    page,
  }) => {
    const stage = await opened(page);
    const widget = stage.locator(".rc-embedded").first();
    await openEmbedEditor(page, stage, "file", "Display");
    await rewrite(page, "$id");
    await expect(widget).toHaveText("file-1");
    // Not written yet: that waits for the app to go quiet.
    expect(await calls(page, "metadata.field.set_display")).toEqual([]);

    await stage.getByRole("button", { name: "Close display editor" }).click();
    await expect(embedEditor(stage, "Display of file")).toHaveCount(0);
    await expect(fieldLabelOf(stage, "file")).toBeFocused();
    await expect
      .poll(() => calls(page, "metadata.field.set_display"))
      .toEqual([
        {
          method: "metadata.field.set_display",
          params: {
            tableName: "track",
            field: { columnName: "file" },
            display: "$id",
          },
        },
      ]);
    await expect(widget).toHaveText("file-1");

    // Opens on what the user wrote, this time.
    await openEmbedEditor(page, stage, "file", "Display");
    await expect(embedEditor(stage, "Display of file")).toHaveText("$id");
  });

  test("the save waits for the app to go quiet, without leaving the editor", async ({
    page,
  }) => {
    const stage = await opened(page);
    await openEmbedEditor(page, stage, "file", "Display");
    await rewrite(page, "$id");
    await expect
      .poll(() => calls(page, "metadata.field.set_display"), { timeout: 8000 })
      .toHaveLength(1);
    await expect(embedEditor(stage, "Display of file")).toBeVisible();
  });

  test("Restore default goes back to what's generated, and closes", async ({
    page,
  }) => {
    const stage = await opened(page);
    const widget = stage.locator(".rc-embedded").first();
    const generated = await widget.innerText();
    await openEmbedEditor(page, stage, "file", "Display");
    await rewrite(page, "$id");
    await expect(widget).toHaveText("file-1");

    await stage.getByRole("button", { name: "Restore default" }).click();
    await expect(embedEditor(stage, "Display of file")).toHaveCount(0);
    await expect(widget).toHaveText(generated);
    await expect
      .poll(() => calls(page, "metadata.field.set_display"))
      .toEqual([
        {
          method: "metadata.field.set_display",
          params: {
            tableName: "track",
            field: { columnName: "file" },
            display: null,
          },
        },
      ]);
  });

  test("Escape closes the editor", async ({ page }) => {
    const stage = await opened(page);
    await openEmbedEditor(page, stage, "file", "Display");
    await page.keyboard.press("Escape");
    await expect(embedEditor(stage, "Display of file")).toHaveCount(0);
    await expect(fieldLabelOf(stage, "file")).toBeFocused();
  });

  test("a multi-record field opens, re-displays and re-sorts under its editors", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/embed-sorting");
    const rows = stage.locator("[data-selectable]");
    await expect(rows).toHaveCount(0);

    await openEmbedEditor(page, stage, "credits", "Display");
    await expect(rows).toHaveCount(2);
    await rewrite(page, "$order");
    await expect(rows).toHaveText(["1", "2"]);

    await openEmbedEditor(page, stage, "credits", "Sorting");
    await expect(embedEditor(stage, "Sorting of credits")).toBeFocused();
    await rewrite(page, "\\\\order \\d");
    await expect(rows).toHaveText(["2", "1"]);

    await stage.getByRole("button", { name: "Close sorting editor" }).click();
    await expect
      .poll(() => calls(page, "metadata.field.set_sorting"))
      .toEqual([
        {
          method: "metadata.field.set_sorting",
          params: {
            tableName: "track",
            field: {
              multiLink: { relatedTableName: "credit", fkColumnName: "track" },
            },
            sorting: "\\\\order \\d",
          },
        },
      ]);
    await expect(embedEditor(stage, "Display of credits")).toBeVisible();
  });

  test("Querydown that won't compile says so, and the records stay as they were", async ({
    page,
  }) => {
    const stage = await opened(page);
    const widget = stage.locator(".rc-embedded").first();
    const before = await widget.innerText();
    await openEmbedEditor(page, stage, "file", "Display");
    await rewrite(page, "$nope");
    await expect(stage.getByRole("alert")).toContainText("nope");
    await expect(widget).toHaveText(before);
    // Nothing the database said, so no second message.
    await expect(stage.locator("p.text-danger")).toHaveCount(1);
  });

  test("only asking for an editor moves the caret to it", async ({ page }) => {
    const stage = await opened(page);
    await openEmbedEditor(page, stage, "file", "Display");
    const editor = embedEditor(stage, "Display of file");
    await expect(editor).toBeFocused();

    // Off somewhere else, and asked for again while it's still open.
    await fieldLabelOf(stage, "title").click();
    await expect(editor).not.toBeFocused();
    await openEmbedEditor(page, stage, "file", "Display");
    await expect(editor).toBeFocused();
  });
});

test.describe("autocomplete", () => {
  const options = (page: Page) => page.getByRole("option");
  const chevron = (stage: Locator) =>
    stage.getByRole("button", { name: "Autocomplete", exact: true });

  /** The record editor on track 5, with its title in edit mode. */
  async function editTitle(page: Page) {
    const stage = await openStory(page, "record-editor/autocomplete", "light");
    const title = stage.getByRole("textbox", { name: "title" });
    await title.click();
    await expect(valueEditor(stage)).toBeFocused();
    return { stage, title };
  }

  test("shows a chevron only in edit mode, and only offers when asked", async ({
    page,
  }) => {
    const stage = await openStory(page, "record-editor/autocomplete", "light");
    const title = stage.getByRole("textbox", { name: "title" });
    await expect(title).toBeVisible();
    await expect(chevron(stage)).toHaveCount(0);

    await title.click();
    await expect(chevron(stage)).toBeVisible();
    await page.keyboard.type("x");
    await page.waitForTimeout(300);
    await expect(options(page)).toHaveCount(0);
  });

  test("the chevron turns it on and off, and the edit goes on", async ({
    page,
  }) => {
    const { stage } = await editTitle(page);
    await chevron(stage).click();
    await expect(options(page)).toHaveCount(5);
    await expect(valueEditor(stage)).toBeFocused();
    await chevron(stage).click();
    await expect(options(page)).toHaveCount(0);
    await expect(valueEditor(stage)).toBeFocused();
  });

  test("typing searches what the values contain, whatever the case", async ({
    page,
  }) => {
    const { stage } = await editTitle(page);
    await page.keyboard.press("Control+Enter");
    await expect(options(page)).toHaveCount(5);
    await valueEditor(stage).fill("SORRY");
    await expect(options(page)).toHaveText(["Sorry1"]);
    await valueEditor(stage).fill("nothing like this");
    await expect(page.getByText("No matching values")).toBeVisible();
  });

  test("the keyboard picks a value, and leaves the edit going", async ({
    page,
  }) => {
    const { stage } = await editTitle(page);
    await page.keyboard.press("Control+Enter");
    await expect(options(page)).toHaveCount(5);

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(options(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(options(page).nth(2)).toContainText("Hold Up");
    await page.keyboard.press("Enter");

    await expect(options(page)).toHaveCount(0);
    await expect(valueEditor(stage)).toBeFocused();
    await expect(valueEditor(stage)).toHaveValue("Hold Up");
    // With the list gone, Enter is back to ending the edit.
    await page.keyboard.press("Enter");
    await expect(valueEditor(stage)).toHaveCount(0);
  });

  test("Escape closes the list and nothing else; Enter on no highlight ends the edit", async ({
    page,
  }) => {
    const { stage } = await editTitle(page);
    await page.keyboard.press("Control+Enter");
    await expect(options(page)).toHaveCount(5);
    await page.keyboard.press("Escape");
    await expect(options(page)).toHaveCount(0);
    await expect(valueEditor(stage)).toBeFocused();

    await page.keyboard.press("Control+Enter");
    await expect(options(page)).toHaveCount(5);
    await page.keyboard.press("Enter");
    await expect(valueEditor(stage)).toHaveCount(0);
    await expect(options(page)).toHaveCount(0);
  });

  test("Tab takes the highlighted value on its way to the next field", async ({
    page,
  }) => {
    const { stage, title } = await editTitle(page);
    await page.keyboard.press("Control+Enter");
    await expect(options(page)).toHaveCount(5);
    const first = await options(page)
      .first()
      .locator("span")
      .first()
      .innerText();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    await expect(options(page)).toHaveCount(0);
    await expect(title).toHaveValue(first);
    await expect(valueEditor(stage)).toHaveCount(0);
  });

  test("clicking a value takes it, and clicking away closes the list", async ({
    page,
  }) => {
    const { stage } = await editTitle(page);
    await page.keyboard.press("Control+Enter");
    const third = options(page).nth(2);
    const value = await third.locator("span").first().innerText();
    await third.click();
    await expect(valueEditor(stage)).toHaveValue(value);
    await expect(valueEditor(stage)).toBeFocused();

    await page.keyboard.press("Control+Enter");
    await expect(options(page)).toHaveCount(5);
    await stage.getByRole("heading").click();
    await expect(options(page)).toHaveCount(0);
    await expect(valueEditor(stage)).toHaveCount(0);
  });

  test("a second line takes the feature away, and Ctrl+Enter with it", async ({
    page,
  }) => {
    const { stage } = await editTitle(page);
    await page.keyboard.press("Shift+Enter");
    await expect(chevron(stage)).toHaveCount(0);
    await page.keyboard.press("Control+Enter");
    await expect(options(page)).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await expect(chevron(stage)).toBeVisible();
  });

  test("a number column searches what its values contain too", async ({
    page,
  }) => {
    const stage = await openStory(page, "record-editor/autocomplete", "light");
    const disc = stage.getByRole("textbox", { name: "disc_number" });
    await disc.click();
    await page.keyboard.press("Control+Enter");
    await expect(options(page)).toHaveText(["15"]);
    await valueEditor(stage).fill("9");
    await expect(page.getByText("No matching values")).toBeVisible();
  });

  test("the pager and PageDown turn pages, and the arrows cross them", async ({
    page,
  }) => {
    await openStory(page, "value-autocomplete/paged", "light");
    await expect(page.getByText("1–50 of 120")).toBeVisible();
    await expect(options(page)).toHaveCount(50);

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("51–100 of 120")).toBeVisible();
    await page.keyboard.press("PageDown");
    await expect(page.getByText("101–120 of 120")).toBeVisible();
    await expect(options(page)).toHaveCount(20);
    await expect(
      page.getByRole("button", { name: "Next page" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Previous page" }).click();
    await expect(page.getByText("51–100 of 120")).toBeVisible();

    await page.keyboard.press("ArrowUp");
    await expect(options(page).last()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByText("101–120 of 120")).toBeVisible();
    await expect(options(page).first()).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

test.describe("hiding fields", () => {
  test("the field goes away, and the actions menu can bring it back", async ({
    page,
  }) => {
    const stage = await loaded(page);

    // Nothing hidden: the menu doesn't mention it.
    await openActions(page);
    await expect(page.getByRole("menuitem", { name: /hidden/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await fieldLabel(stage, "title").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Hide field" }).click();
    expect(await fieldNames(stage)).not.toContain("title");
    await expect
      .poll(() => rpcCalls(page, "metadata.field.set_visible"))
      .toEqual([
        {
          tableName: "track",
          field: { columnName: "title" },
          visible: false,
        },
      ]);

    await openActions(page);
    await page.getByRole("menuitem", { name: "Show 1 hidden field" }).click();
    expect(await fieldNames(stage)).toContain("title");
    await expect(fieldLabel(stage, "title")).toHaveCSS("opacity", "0.6");

    await openActions(page);
    await page.getByRole("menuitem", { name: "Hide hidden fields" }).click();
    expect(await fieldNames(stage)).not.toContain("title");
  });

  test("a hidden field can be un-hidden, which ends showing hidden fields", async ({
    page,
  }) => {
    const stage = await loaded(page);
    await fieldLabel(stage, "title").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Hide field" }).click();
    await openActions(page);
    await page.getByRole("menuitem", { name: "Show 1 hidden field" }).click();

    await fieldLabel(stage, "title").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Un-hide field" }).click();
    await expect(fieldLabel(stage, "title")).toHaveCSS("opacity", "1");
    await expect
      .poll(() => rpcCalls(page, "metadata.field.set_visible"))
      .toEqual([
        {
          tableName: "track",
          field: { columnName: "title" },
          visible: false,
        },
        { tableName: "track", field: { columnName: "title" }, visible: true },
      ]);

    await openActions(page);
    await expect(page.getByRole("menuitem", { name: /hidden/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // So the next field hidden goes away, rather than staying up dimmed.
    await fieldLabel(stage, "title").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Hide field" }).click();
    expect(await fieldNames(stage)).not.toContain("title");
  });

  test("the count covers several fields", async ({ page }) => {
    const stage = await loaded(page);
    for (const name of ["title", "disc_number"]) {
      await fieldLabel(stage, name).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Hide field" }).click();
    }
    await openActions(page);
    await expect(
      page.getByRole("menuitem", { name: "Show 2 hidden fields" }),
    ).toBeVisible();
  });

  test("a hidden field on show can be edited and rearranged", async ({
    page,
  }) => {
    const stage = await loaded(page);
    await fieldLabel(stage, "title").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Hide field" }).click();
    await openActions(page);
    await page.getByRole("menuitem", { name: "Show 1 hidden field" }).click();

    await fieldLabel(stage, "title").dblclick();
    const editor = valueEditor(stage);
    await editor.fill("Renamed");
    await editor.press("Enter");
    await expect(star(stage, "title")).toBeVisible();

    await dragLabel(page, stage, "title", "id", 0.1);
    await page.mouse.up();
    expect((await fieldNames(stage))[0]).toBe("title");
  });
});

test.describe("rearranging fields", () => {
  test("dropping a label moves its field, without moving it until then", async ({
    page,
  }) => {
    const stage = await loaded(page);
    const before = await fieldNames(stage);
    expect(before.slice(0, 3)).toEqual(["id", "file", "title"]);

    await dragLabel(page, stage, "title", "file", 0.1);
    expect(await fieldNames(stage)).toEqual(before);
    await page.mouse.up();

    expect((await fieldNames(stage)).slice(0, 3)).toEqual([
      "id",
      "title",
      "file",
    ]);
  });

  test("the first move resequences the table, and the next only moves one", async ({
    page,
  }) => {
    const stage = await loaded(page);
    const names = await fieldNames(stage);
    const writes = () => rpcCalls(page, "metadata.field.set_order");

    await dragLabel(page, stage, "title", "id", 0.1);
    await page.mouse.up();
    expect((await fieldNames(stage)).slice(0, 2)).toEqual(["title", "id"]);
    await expect.poll(async () => (await writes()).length).toBe(1);
    const [sent] = (await writes()) as {
      tableName: string;
      orders: { field: unknown; order: number }[];
    }[];
    expect(sent.tableName).toBe("track");
    // Every field gets a place, the ones listing related records included.
    expect(sent.orders.map((entry) => entry.order)).toEqual(
      names.map((_, i) => i + 1),
    );
    expect(sent.orders.slice(0, 2).map((entry) => entry.field)).toEqual([
      { columnName: "title" },
      { columnName: "id" },
    ]);
    expect(sent.orders.at(-1)?.field).toMatchObject({
      multiLink: { fkColumnName: "track" },
    });

    await dragLabel(page, stage, "id", "title", 0.1);
    await page.mouse.up();
    expect((await fieldNames(stage)).slice(0, 2)).toEqual(["id", "title"]);
    await expect.poll(async () => (await writes()).length).toBe(2);
    expect((await writes())[1]).toEqual({
      tableName: "track",
      orders: [{ field: { columnName: "id" }, order: 0 }],
    });
  });

  test("the order follows the record editor onto other records", async ({
    page,
  }) => {
    const stage = await openStory(page, "record-editor/bulk", "light");
    await expect(fieldLabel(stage, "title")).toBeVisible();
    await dragLabel(page, stage, "title", "id", 0.1);
    await page.mouse.up();
    expect((await fieldNames(stage))[0]).toBe("title");
  });

  test("Escape cancels a drag", async ({ page }) => {
    const stage = await loaded(page);
    const before = await fieldNames(stage);
    await dragLabel(page, stage, "title", "disc_number", 0.1);
    await expect(stage.locator("[data-field-row].opacity-50")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(stage.locator("[data-field-row].opacity-50")).toHaveCount(0);
    await page.mouse.up();
    expect(await fieldNames(stage)).toEqual(before);
  });

  test("a click still only selects the label, and a double click still edits", async ({
    page,
  }) => {
    const stage = await loaded(page);
    await fieldLabel(stage, "title").click();
    await expect(fieldLabel(stage, "title")).toBeFocused();
    await fieldLabel(stage, "title").dblclick();
    await expect(valueEditor(stage)).toBeVisible();
  });

  test("a touch picks a label up with a long press", async ({ page }) => {
    const stage = await loaded(page);
    const names = await fieldNames(stage);
    const cdp = await page.context().newCDPSession(page);
    const from = (await fieldLabel(stage, "title").boundingBox())!;
    const to = (await fieldLabel(stage, "file").boundingBox())!;
    const x = from.x + from.width / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: from.y + from.height / 2 }],
    });
    await page.waitForTimeout(700);
    await expect(stage.locator("[data-field-row].opacity-50")).toHaveCount(1);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: to.y + 2 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    const moved = names.filter((name) => name !== "title");
    moved.splice(1, 0, "title");
    await expect.poll(() => fieldNames(stage)).toEqual(moved);
    await expect(page.getByRole("menuitem")).toHaveCount(0);
  });

  test("a touch held and let go without a move raises the context menu", async ({
    page,
  }) => {
    const stage = await loaded(page);
    const names = await fieldNames(stage);
    const cdp = await page.context().newCDPSession(page);
    const label = (await fieldLabel(stage, "title").boundingBox())!;
    const x = label.x + label.width / 2;
    const y = label.y + label.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await page.waitForTimeout(700);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(
      page.getByRole("menuitem", { name: "Hide field" }),
    ).toBeVisible();
    expect(await fieldNames(stage)).toEqual(names);
  });

  test("a touch that moves straight away is a scroll, not a drag", async ({
    page,
  }) => {
    const stage = await loaded(page);
    const names = await fieldNames(stage);
    const cdp = await page.context().newCDPSession(page);
    const label = (await fieldLabel(stage, "title").boundingBox())!;
    const x = label.x + label.width / 2;
    const y = label.y + label.height / 2;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let i = 1; i <= 6; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + i * 12 }],
      });
    }
    await page.waitForTimeout(700);
    await expect(stage.locator("[data-field-row].opacity-50")).toHaveCount(0);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(await fieldNames(stage)).toEqual(names);
    await expect(page.getByRole("menuitem")).toHaveCount(0);
  });
});

// The tree stays open from one form to the next, and from one visit to the next,
// by the path to each item: the same place on another record, and nowhere else.
test("the record editor reopens what was left expanded", async ({ page }) => {
  // Track 3's: its second credit stays closed, so only the first is remembered.
  let stage = await openStory(page, "record-editor/items-expanded", "light");
  await stage.getByRole("button", { name: "Expand credits" }).click();
  await stage.getByRole("button", { name: /^Expand Beyoncé/ }).click();
  await stage.getByRole("button", { name: "Expand artist" }).click();
  await expect(
    stage.getByRole("button", { name: "Collapse artist" }),
  ).toBeVisible();

  // Track 5, which the user hasn't opened anything on, on a new visit.
  stage = await openStory(page, "record-editor/modified", "light");
  await expect(
    stage.getByRole("button", { name: "Collapse credits" }),
  ).toBeVisible();
  await expect(
    stage.getByRole("button", { name: /^Collapse Beyoncé/ }),
  ).toBeVisible();
  await expect(
    stage.getByRole("button", { name: "Collapse artist" }),
  ).toBeVisible();
  await expect(
    stage.getByRole("button", { name: /^Expand The Weeknd/ }),
  ).toBeVisible();
});

test("the record editor reopens a long text field, not a short one", async ({
  page,
}) => {
  let stage = await openStory(page, "record-editor/items-expanded", "light");
  await stage.getByRole("button", { name: "Expand title" }).click();
  await expect(
    stage.getByRole("button", { name: "Collapse title" }),
  ).toBeVisible();

  stage = await openStory(page, "record-editor/items-expanded", "light");
  await expect(
    stage.getByRole("button", { name: "Collapse title" }),
  ).toBeVisible();

  // Track 5's title fits on its line, so there is nothing to expand.
  stage = await openStory(page, "record-editor/modified", "light");
  await expect(stage.getByText("6 Inch", { exact: true })).toBeVisible();
  await expect(
    stage.getByRole("button", { name: /(Collapse|Expand) title/ }),
  ).toHaveCount(0);
});
