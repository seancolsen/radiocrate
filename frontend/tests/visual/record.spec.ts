import { test, expect, type Locator, type Page } from "@playwright/test";
import { SCHEMES, openStory, snapshot, valueEditor } from "./harness";

// The record editor, on its own: the panel as its form lands and opened out,
// mid-edit and after a refused save; the modal picker it opens; and the
// embedded-record widget, straight from cells.

/** The red ✱ marking one field — or one embedded record — as modified. */
const star = (panel: Locator, label: string) =>
  panel.locator(`[aria-label="${label} modified"]`);

/** Opens a field's query editor from its context menu, on the section given
 * (its first, unless said otherwise). */
async function openQueryEditor(
  page: Page,
  stage: Locator,
  field: string,
  section?: "Filter" | "Sort" | "Display",
) {
  await fieldLabelOf(stage, field).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit query", exact: true }).click();
  if (section !== undefined) {
    await queryEditorOf(stage)
      .getByRole("button", { name: section, exact: true })
      .click();
  }
}

/** A field's query editor, all of it: toolbar, text and what's said under it. */
const queryEditorOf = (stage: Locator) =>
  stage.getByTestId("field-query-editor");

/** Takes "Restore default" from the ⋮ inside a query editor's text. */
async function restoreDefault(page: Page, stage: Locator) {
  await queryEditorOf(stage)
    .getByRole("button", { name: "Input options" })
    .click();
  await page.getByRole("menuitem", { name: "Restore default" }).click();
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

  // Mid-edit: an edited field and a record being created under `play`, each
  // starred, and the "+" buttons that put it there.
  test(`record-editor/modified - ${colorScheme}`, async ({ page }) => {
    // A new play's timestamp starts at now: a fixed now, for a steady snapshot.
    await page.clock.setFixedTime("2016-04-24T08:12:00");
    const stage = await openStory(page, "record-editor/modified", colorScheme);
    await stage.getByText("6 Inch", { exact: true }).click();
    await valueEditor(stage).fill("6 Inch (Live)");
    await page.keyboard.press("Escape");
    await stage.getByRole("button", { name: "Add play" }).click();
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

  // Find and replace on the values a text field's records disagree on: the
  // panel under the field's row, and each value previewing the replacement.
  test(`record-editor/find-replace - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/find-replace",
      colorScheme,
    );
    await expect(stage.getByRole("heading")).toHaveText("Edit 3 tracks");
    await stage.getByRole("button", { name: "Expand title" }).click();
    await stage.getByRole("button", { name: "Find and replace" }).click();
    const find = stage.getByRole("textbox", { name: "Find", exact: true });
    await expect(find).toBeFocused();
    await find.fill("you");
    await stage
      .getByRole("textbox", { name: "Replace", exact: true })
      .fill("U");
    await expect(stage.getByText("Pray U Catch Me")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/find-replace", colorScheme),
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

  // Its columns as their annotations have them.
  test(`embedded-record/annotated - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "embedded-record/annotated",
      colorScheme,
    );
    await expect(stage.locator(".rc-embedded")).not.toContainText("hidden-id");
    await expect(stage).toHaveScreenshot(
      snapshot("embedded-record/annotated", colorScheme),
    );
  });
}

test("an embedded record's relative time keeps counting on a still page", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2020-01-01T00:05:30") });
  const stage = await openStory(page, "embedded-record/relative-time", "light");
  const widget = stage.locator(".rc-embedded");
  await expect(widget).toHaveText("5 minutes ago");
  await page.clock.fastForward("02:00");
  await expect(widget).toHaveText("7 minutes ago");
});

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

  // The query editor under a linked-record field: the one section it has,
  // pressed, and the ⋮ inside the text.
  test(`record-editor/embed-display - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/embed-display",
      colorScheme,
    );
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    await openQueryEditor(page, stage, "file");
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
    // A related-records field's: sorting and display, open on sorting.
    await openQueryEditor(page, stage, "track tags");
    await expect(
      queryEditorOf(stage).getByRole("button", { name: "Sort", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
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
    await openQueryEditor(page, stage, "file");
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
      "Edit query",
      "Clear",
      "Hide field",
    ]);
    await page.keyboard.press("Escape");

    await fieldLabelOf(stage, "credits").click({ button: "right" });
    expect(await menuEntries(page)).toEqual([
      "New record",
      "Edit query",
      "Delete all records",
      "Hide field",
    ]);
    await page.keyboard.press("Escape");

    await fieldLabelOf(stage, "title").click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Edit query" }),
    ).toHaveCount(0);
  });

  test("the editor opens on the generated Querydown, with the caret in it", async ({
    page,
  }) => {
    const stage = await opened(page);
    await openQueryEditor(page, stage, "file");
    const editor = embedEditor(stage, "Display of file");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("$path");
    expect(await calls(page, "metadata.field.set_display")).toEqual([]);
  });

  test("annotations in what's typed shape the embedded record", async ({
    page,
  }) => {
    const stage = await opened(page);
    const widget = stage.locator(".rc-embedded").first();
    await openQueryEditor(page, stage, "file");
    await rewrite(page, '$id @{hide:"yes"} $path @{prefix:"at "}');
    await expect(widget).toHaveText(/^at .*\.flac$/);
    await expect(widget.locator("span")).toHaveCount(1);
  });

  test("what's typed shows as it settles, and saves on leaving the editor", async ({
    page,
  }) => {
    const stage = await opened(page);
    const widget = stage.locator(".rc-embedded").first();
    await openQueryEditor(page, stage, "file");
    await rewrite(page, "$id");
    await expect(widget).toHaveText("file-1");
    // Not written yet: that waits for the app to go quiet.
    expect(await calls(page, "metadata.field.set_display")).toEqual([]);

    await stage.getByRole("button", { name: "Close query editor" }).click();
    await expect(embedEditor(stage, "Display of file")).toHaveCount(0);
    await expect(fieldLabelOf(stage, "file")).toBeFocused();
    await expect
      .poll(() => calls(page, "metadata.field.set_display"))
      .toEqual([
        {
          method: "metadata.field.set_display",
          params: {
            schemaName: "main",
            tableName: "track",
            field: { columnName: "file" },
            display: "$id",
          },
        },
      ]);
    await expect(widget).toHaveText("file-1");

    // Opens on what the user wrote, this time.
    await openQueryEditor(page, stage, "file");
    await expect(embedEditor(stage, "Display of file")).toHaveText("$id");
  });

  test("the save waits for the app to go quiet, without leaving the editor", async ({
    page,
  }) => {
    const stage = await opened(page);
    await openQueryEditor(page, stage, "file");
    await rewrite(page, "$id");
    await expect
      .poll(() => calls(page, "metadata.field.set_display"), { timeout: 8000 })
      .toHaveLength(1);
    await expect(embedEditor(stage, "Display of file")).toBeVisible();
  });

  test("Restore default goes back to what's generated, from the editor's ⋮", async ({
    page,
  }) => {
    const stage = await opened(page);
    const widget = stage.locator(".rc-embedded").first();
    const generated = await widget.innerText();
    await openQueryEditor(page, stage, "file");
    await rewrite(page, "$id");
    await expect(widget).toHaveText("file-1");

    await restoreDefault(page, stage);
    const editor = embedEditor(stage, "Display of file");
    await expect(editor).toHaveText("$path");
    await expect(widget).toHaveText(generated);
    // Nothing more to restore.
    await queryEditorOf(stage)
      .getByRole("button", { name: "Input options" })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Restore default" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect
      .poll(() => calls(page, "metadata.field.set_display"))
      .toEqual([
        {
          method: "metadata.field.set_display",
          params: {
            schemaName: "main",
            tableName: "track",
            field: { columnName: "file" },
            display: null,
          },
        },
      ]);
  });

  test("Escape closes the editor", async ({ page }) => {
    const stage = await opened(page);
    await openQueryEditor(page, stage, "file");
    await page.keyboard.press("Escape");
    await expect(embedEditor(stage, "Display of file")).toHaveCount(0);
    await expect(fieldLabelOf(stage, "file")).toBeFocused();
  });

  test("a multi-record field opens, re-displays and re-sorts under its editor", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/embed-sorting");
    const rows = stage.locator("[data-selectable]");
    await expect(rows).toHaveCount(0);

    await openQueryEditor(page, stage, "track tags", "Display");
    await expect(rows).toHaveCount(2);
    await rewrite(page, "$tag");
    await expect(rows).toHaveText(["tag-rnb", "tag-rock"]);

    await queryEditorOf(stage)
      .getByRole("button", { name: "Sort", exact: true })
      .click();
    await expect(embedEditor(stage, "Sorting of track tags")).toBeFocused();
    await rewrite(page, "\\\\tag \\d");
    await expect(rows).toHaveText(["tag-rock", "tag-rnb"]);

    await stage.getByRole("button", { name: "Close query editor" }).click();
    await expect
      .poll(() => calls(page, "metadata.field.set_sorting"))
      .toEqual([
        {
          method: "metadata.field.set_sorting",
          params: {
            schemaName: "main",
            tableName: "track",
            field: {
              multiLink: {
                relatedTableName: "track_tag",
                fkColumnName: "track",
              },
            },
            sorting: "\\\\tag \\d",
          },
        },
      ]);
    await expect(queryEditorOf(stage)).toHaveCount(0);
  });

  test("Querydown that won't compile says so, and the records stay as they were", async ({
    page,
  }) => {
    const stage = await opened(page);
    const widget = stage.locator(".rc-embedded").first();
    const before = await widget.innerText();
    await openQueryEditor(page, stage, "file");
    await rewrite(page, "$nope");
    await expect(stage.getByRole("alert")).toContainText("nope");
    await expect(widget).toHaveText(before);
    // Nothing the database said, so no second message.
    await expect(stage.locator("p.text-danger")).toHaveCount(1);
  });

  test("only asking for an editor moves the caret to it", async ({ page }) => {
    const stage = await opened(page);
    await openQueryEditor(page, stage, "file");
    const editor = embedEditor(stage, "Display of file");
    await expect(editor).toBeFocused();

    // Off somewhere else, and asked for again while it's still open.
    await fieldLabelOf(stage, "title").click();
    await expect(editor).not.toBeFocused();
    await openQueryEditor(page, stage, "file");
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
          schemaName: "main",
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
          schemaName: "main",
          tableName: "track",
          field: { columnName: "title" },
          visible: false,
        },
        {
          schemaName: "main",
          tableName: "track",
          field: { columnName: "title" },
          visible: true,
        },
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
    // Every field gets a place, the ones listing related records and the
    // computed columns included.
    expect(sent.orders.map((entry) => entry.order)).toEqual(
      names.map((_, i) => i + 1),
    );
    expect(sent.orders.slice(0, 2).map((entry) => entry.field)).toEqual([
      { columnName: "title" },
      { columnName: "id" },
    ]);
    expect(
      sent.orders.some(
        (entry) =>
          (entry.field as { multiLink?: { fkColumnName: string } }).multiLink
            ?.fkColumnName === "track",
      ),
    ).toBe(true);
    expect(sent.orders.at(-1)?.field).toEqual({ computedColumn: "tags" });

    await dragLabel(page, stage, "id", "title", 0.1);
    await page.mouse.up();
    expect((await fieldNames(stage)).slice(0, 2)).toEqual(["id", "title"]);
    await expect.poll(async () => (await writes()).length).toBe(2);
    expect((await writes())[1]).toEqual({
      schemaName: "main",
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
  await stage
    .getByRole("button", { name: "Expand artist", exact: true })
    .click();
  await expect(
    stage.getByRole("button", { name: "Collapse artist", exact: true }),
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
    stage.getByRole("button", { name: "Collapse artist", exact: true }),
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

for (const colorScheme of SCHEMES) {
  // A contextual query opened out, with its editor showing: its label in its own
  // color, the count of what it found, the editor's toolbar over its filter, and
  // the record it found.
  test(`record-editor/contextual-query - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/contextual-query",
      colorScheme,
    );
    await stage.getByRole("button", { name: "Expand featured" }).click();
    await expect(stage.getByText("Jack White", { exact: true })).toBeVisible();
    await fieldLabelOf(stage, "featured").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit query" }).click();
    await expect(embedEditor(stage, "Filter of featured")).toBeFocused();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/contextual-query", colorScheme),
    );
  });

  // A contextual query that groups what it finds: a row for each group, showing
  // what the query displays, with no toggle to open it by.
  test(`record-editor/contextual-query-grouped - ${colorScheme}`, async ({
    page,
  }) => {
    const stage = await openStory(
      page,
      "record-editor/contextual-query-grouped",
      colorScheme,
    );
    await stage.getByRole("button", { name: "Expand by artist" }).click();
    await expect(stage.getByTestId("query-row")).toHaveCount(2);
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/contextual-query-grouped", colorScheme),
    );
  });

  // A contextual query being added: the new field at the bottom, its default
  // name selected to be typed over, and the Base selector beside it.
  test(`record-editor/provisional-query - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/provisional-query",
      colorScheme,
    );
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    await stage.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Add contextual query" }).click();
    await expect(
      stage.getByRole("textbox", { name: "Name of the new query" }),
    ).toBeFocused();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/provisional-query", colorScheme),
    );
  });
}

for (const colorScheme of SCHEMES) {
  // A computed column's expression being edited, under its field: one of the
  // app's own, so "Reset to default" is there, with nothing yet to reset.
  test(`record-editor/computed-expression - ${colorScheme}`, async ({
    page,
  }) => {
    const stage = await openStory(
      page,
      "record-editor/computed-expression",
      colorScheme,
    );
    await expect(stage.getByText("2016-05-02 21:47:00")).toBeVisible();
    await fieldLabelOf(stage, "last_play").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit expression" }).click();
    const expression = embedEditor(stage, "Expression of last_play");
    await expect(expression).toBeFocused();
    await expect(expression).toHaveText("#play.timestamp%max");
    await expect(
      stage.getByRole("button", { name: "Reset to default" }),
    ).toBeDisabled();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/computed-expression", colorScheme),
    );
  });

  // The user's own computed columns after the app's: one with a value, one
  // saying why it has none, and one with no expression yet.
  test(`record-editor/computed-columns - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "record-editor/computed-columns",
      colorScheme,
    );
    await expect(stage.getByText("Column label not found")).toBeVisible();
    await expect(
      stage.getByRole("button", {
        name: "Write the expression of unwritten",
      }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/computed-columns", colorScheme),
    );
  });

  // A computed column being added: the new field at the bottom, its default
  // name selected to be typed over.
  test(`record-editor/provisional-computed - ${colorScheme}`, async ({
    page,
  }) => {
    const stage = await openStory(
      page,
      "record-editor/provisional-computed",
      colorScheme,
    );
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    await stage.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Add computed column" }).click();
    await expect(
      stage.getByRole("textbox", { name: "Name of the new computed column" }),
    ).toBeFocused();
    await expect(stage).toHaveScreenshot(
      snapshot("record-editor/provisional-computed", colorScheme),
    );
  });
}

test.describe("computed columns", () => {
  /** The calls of `method` the page has made, oldest first. */
  const calls = (page: Page, method: string) =>
    page.evaluate(
      (wanted) =>
        (window.__rpcCalls ?? [])
          .filter((call) => call.method === wanted)
          .map((call) => call.params),
      method,
    );

  async function opened(page: Page, story: string) {
    const stage = await openStory(page, story, "light");
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    return stage;
  }

  /** A computed column's row: its label and what it shows. */
  const computedRow = (stage: Locator, name: string) =>
    stage.locator("[data-field-row]").filter({
      has: stage.page().getByText(name, { exact: true }),
    });

  test("show what the app's own come to for the record, each read-only", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/items-collapsed");
    const shown = async (name: string) =>
      (await computedRow(stage, name).innerText()).replace(/\s+/g, " ").trim();
    expect(await shown("first_play")).toBe("first_play 2016-04-24 08:12:00");
    expect(await shown("last_play")).toBe("last_play 2016-05-02 21:47:00");
    expect(await shown("artists")).toBe("artists [Beyoncé]");
    expect(await shown("year")).toBe("year 2016");
    expect(await shown("play_count")).toBe("play_count 2");
    // Nothing of theirs is a text box to type into.
    await expect(computedRow(stage, "year").getByRole("textbox")).toHaveCount(
      0,
    );
  });

  test("show the value several records share, and how many they don't", async ({
    page,
  }) => {
    // Two tracks, whose files differ: there's no one file to wait on.
    const stage = await openStory(page, "record-editor/bulk", "light");
    // Both were added at once; only one of them has an album to take a year
    // from.
    await expect(computedRow(stage, "added")).toContainText(
      "2016-04-23 19:04:00",
    );
    await expect(computedRow(stage, "year")).toContainText("2 distinct values");
    await expect(computedRow(stage, "duration")).toContainText(
      "2 distinct values",
    );
  });

  test("its chevron opens the editor of its expression, leaving the caret where it was", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/computed-expression");
    const expression = embedEditor(stage, "Expression of year");
    await expect(expression).toHaveCount(0);
    await stage.getByRole("button", { name: "Expand year" }).click();
    await expect(expression).toHaveText("album.year");
    await expect(expression).not.toBeFocused();
    // The value stays beside the label.
    await expect(computedRow(stage, "year").first()).toContainText("2016");
    await stage.getByRole("button", { name: "Collapse year" }).click();
    await expect(expression).toHaveCount(0);
  });

  test("one of the app's own can be edited, not renamed or removed", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/computed-expression");
    await fieldLabelOf(stage, "year").click({ button: "right" });
    expect(await page.getByRole("menuitem").allInnerTexts()).toEqual([
      "Edit expression",
      "Copy",
      "Hide field",
    ]);
    await page.getByRole("menuitem", { name: "Edit expression" }).click();
    const expression = embedEditor(stage, "Expression of year");
    await expect(expression).toBeFocused();
    const reset = stage.getByRole("button", { name: "Reset to default" });
    await expect(reset).toBeDisabled();

    // The user's expression is the column's at once, and its value follows.
    await rewrite(page, "track_number");
    await expect(computedRow(stage, "year").first()).toHaveText(
      /^year\s*1(?!\d)/,
    );
    await expect(reset).toBeEnabled();
    // Escape, in the text, gives the field back the keyboard, leaving the
    // editor open — once the first has closed the completions typing raised.
    await expression.press("Escape");
    await expect(expression).toBeFocused();
    await expression.press("Escape");
    await expect(fieldLabelOf(stage, "year")).toBeFocused();
    await expect(expression).toBeVisible();
    // Collapsing the field closes the editor, and what was typed is written as
    // it goes.
    await stage.getByRole("button", { name: "Collapse year" }).click();
    await expect(expression).toHaveCount(0);
    await expect
      .poll(() => calls(page, "metadata.computed_column.set"))
      .toEqual([
        {
          schemaName: "main",
          tableName: "track",
          name: "year",
          expression: "track_number",
        },
      ]);

    // Double-clicking the label opens the editor too; resetting goes back to
    // the app's expression, and is written straight away.
    await fieldLabelOf(stage, "year").dblclick();
    await expect(embedEditor(stage, "Expression of year")).toBeFocused();
    await reset.click();
    await expect(embedEditor(stage, "Expression of year")).toHaveText(
      "album.year",
    );
    await expect(computedRow(stage, "year").first()).toContainText("2016");
    await stage.getByRole("button", { name: "Collapse year" }).click();
    await expect(embedEditor(stage, "Expression of year")).toHaveCount(0);
    await expect
      .poll(async () =>
        (await calls(page, "metadata.computed_column.set")).at(-1),
      )
      .toEqual({
        schemaName: "main",
        tableName: "track",
        name: "year",
        expression: null,
      });
  });

  test("a problem with an expression shows under it, and in place of the value", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/computed-expression");
    await fieldLabelOf(stage, "year").dblclick();
    await rewrite(page, "album.yeer");
    const editor = stage.getByTestId("computed-column-editor");
    await expect(editor.getByRole("alert")).toContainText(
      "Column yeer not found",
    );
    await expect(computedRow(stage, "year").first()).toContainText(
      "Column yeer not found",
    );
    // The other columns go on showing what they did.
    await expect(computedRow(stage, "play_count")).toContainText("2");
  });

  test("one being added takes a name, then its expression", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/provisional-computed");
    await stage.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Add computed column" }).click();
    await page.keyboard.type("album year");
    await page.keyboard.press("Enter");

    // Named — as a query can say it — it's a field, with its editor open.
    await expect(stage.getByTestId("provisional-computed")).toHaveCount(0);
    await expect(fieldLabelOf(stage, "album_year")).toBeVisible();
    const expression = embedEditor(stage, "Expression of album_year");
    await expect(expression).toBeFocused();
    await expect(
      stage.getByRole("button", { name: "Reset to default" }),
    ).toHaveCount(0);
    expect(await calls(page, "metadata.computed_column.set")).toEqual([
      {
        schemaName: "main",
        tableName: "track",
        name: "album_year",
        expression: "",
      },
    ]);

    await page.keyboard.type("file.added");
    await expect(computedRow(stage, "album_year")).toContainText(
      "2016-04-23 19:04:00",
    );
    await stage.getByRole("button", { name: "Collapse album_year" }).click();
    await expect
      .poll(async () =>
        (await calls(page, "metadata.computed_column.set")).at(-1),
      )
      .toEqual({
        schemaName: "main",
        tableName: "track",
        name: "album_year",
        expression: "file.added",
      });
  });

  test("Escape drops one being added", async ({ page }) => {
    const stage = await opened(page, "record-editor/provisional-computed");
    await stage.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Add computed column" }).click();
    await page.keyboard.type("nothing");
    await page.keyboard.press("Escape");
    await expect(stage.getByTestId("provisional-computed")).toHaveCount(0);
    await expect(fieldLabelOf(stage, "nothing")).toHaveCount(0);
    expect(await calls(page, "metadata.computed_column.set")).toEqual([]);
  });

  test("one of the user's own is renamed, its place going with it, and removed", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/computed-columns");
    await expect(computedRow(stage, "tag_count")).toContainText("2");
    await fieldLabelOf(stage, "tag_count").click({ button: "right" });
    expect(await page.getByRole("menuitem").allInnerTexts()).toEqual([
      "Edit expression",
      "Copy",
      "Rename",
      "Hide field",
      "Remove",
    ]);

    await page.getByRole("menuitem", { name: "Rename" }).click();
    const name = stage.getByRole("textbox", { name: "Name of tag_count" });
    await expect(name).toBeFocused();
    await page.keyboard.type("tags applied");
    await page.keyboard.press("Enter");
    // One call renames the column and what's customized about its field.
    await expect(fieldLabelOf(stage, "tags_applied")).toBeFocused();
    await expect(fieldLabelOf(stage, "tag_count")).toHaveCount(0);
    await expect(computedRow(stage, "tags_applied")).toContainText("2");
    expect(await calls(page, "metadata.computed_column.rename")).toEqual([
      {
        schemaName: "main",
        tableName: "track",
        name: "tag_count",
        newName: "tags_applied",
      },
    ]);

    // A name another field has is numbered, never refused.
    await fieldLabelOf(stage, "tags_applied").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.keyboard.type("title");
    await page.keyboard.press("Enter");
    await expect(fieldLabelOf(stage, "title_2")).toBeFocused();

    await fieldLabelOf(stage, "title_2").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Remove “title_2” from every track?");
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(fieldLabelOf(stage, "title_2")).toHaveCount(0);
    await expect
      .poll(() => calls(page, "metadata.computed_column.delete"))
      .toEqual([{ schemaName: "main", tableName: "track", name: "title_2" }]);
  });

  test("a long value, open, shows whole below its label", async ({ page }) => {
    const stage = await opened(page, "record-editor/computed-expression");
    await fieldLabelOf(stage, "artists").dblclick();
    await rewrite(page, "file.path");
    // Open, the field gives the value the width it needs, over the editor,
    // where it wraps rather than being cut off beside the label.
    const whole = stage.locator(".whitespace-pre-wrap", {
      hasText: "Pray You Catch Me.flac",
    });
    await expect(whole).toBeVisible();
    // Closed, it's cut off beside the label.
    await stage.getByRole("button", { name: "Collapse artists" }).click();
    await expect(whole).toHaveCount(0);
    await expect(computedRow(stage, "artists").first()).toContainText(
      "./Beyoncé/Lemonade",
    );
  });
});

test.describe("contextual queries", () => {
  /** The `dml` requests the page has sent, oldest first. */
  const writes = (page: Page) =>
    page.evaluate(() =>
      (window.__rpcCalls ?? [])
        .filter((call) => call.method === "dml")
        .map((call) => call.params),
    );

  async function opened(page: Page, story: string) {
    const stage = await openStory(page, story, "light");
    await expect(stage.locator(".rc-embedded").first()).toContainText(".flac");
    return stage;
  }

  test("runs only once expanded", async ({ page }) => {
    const stage = await opened(page, "record-editor/contextual-query");
    await expect(fieldLabelOf(stage, "featured")).toBeVisible();
    await expect(stage.getByText("Jack White", { exact: true })).toHaveCount(0);
    await stage.getByRole("button", { name: "Expand featured" }).click();
    await expect(stage.getByText("Jack White", { exact: true })).toBeVisible();
    // What it found has no delete button: it isn't the field's to take away.
    await expect(
      stage.getByRole("button", { name: /^Delete Jack White/ }),
    ).toHaveCount(0);
  });

  test("lists a grouped query's rows, which aren't records", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/contextual-query-grouped");
    await stage.getByRole("button", { name: "Expand by artist" }).click();
    const rows = stage.getByTestId("query-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Beyoncé");
    await expect(rows.nth(0)).toContainText("1");
    await expect(rows.nth(1)).toContainText("Jack White");
    // A row stands for no one record: there's nothing to open it into.
    await expect(
      stage.getByRole("button", { name: /Expand (Beyoncé|Jack White)/ }),
    ).toHaveCount(0);
  });

  test("its menu edits, renames and removes it", async ({ page }) => {
    const stage = await opened(page, "record-editor/contextual-query");
    await fieldLabelOf(stage, "featured").click({ button: "right" });
    expect(await page.getByRole("menuitem").allInnerTexts()).toEqual([
      "Edit query",
      "Rename",
      "Hide field",
      "Remove",
    ]);

    await page.getByRole("menuitem", { name: "Rename" }).click();
    const name = stage.getByRole("textbox", { name: "Name of featured" });
    await expect(name).toBeFocused();
    await page.keyboard.type("guests");
    await page.keyboard.press("Enter");
    await expect(fieldLabelOf(stage, "guests")).toBeFocused();
    await expect
      .poll(() => writes(page))
      .toEqual([
        {
          operations: [
            {
              operation: "update",
              id: "op1",
              schema: "metadata",
              table: "contextual_query",
              where: { id: "query-featured" },
              values: { name: "guests" },
            },
          ],
        },
      ]);

    await fieldLabelOf(stage, "guests").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Remove “guests” from every track?");
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(fieldLabelOf(stage, "guests")).toHaveCount(0);
    await expect.poll(async () => (await writes(page)).length).toBe(2);
  });

  test("one being added takes a name, then a base, and guesses a filter", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/provisional-query");
    await stage.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Add contextual query" }).click();
    await page.keyboard.type("credited");
    await page.keyboard.press("Enter");
    const base = stage.getByRole("combobox", { name: "Base" });
    await expect(base).toBeFocused();
    await expect(base).toHaveValue("");

    await base.selectOption("credit");
    await expect(stage.getByTestId("provisional-query")).toHaveCount(0);
    await expect(fieldLabelOf(stage, "credited")).toBeVisible();
    const filter = embedEditor(stage, "Filter of credited");
    await expect(filter).toBeFocused();
    // The credits of the track, by the link from credit to track — so it runs.
    await expect(filter).toHaveText("track.id:@id");
    await expect(stage.getByText("The Weeknd", { exact: true })).toBeVisible();
    expect((await writes(page))[0]).toMatchObject({
      operations: [
        {
          operation: "insert",
          schema: "metadata",
          table: "contextual_query",
          values: { table_name: "track", name: "credited" },
        },
      ],
    });
  });

  test("one listing its own table starts with no filter", async ({ page }) => {
    const stage = await opened(page, "record-editor/provisional-query");
    await stage.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Add contextual query" }).click();
    await page.keyboard.press("Enter");
    await stage.getByRole("combobox", { name: "Base" }).selectOption("track");
    const filter = embedEditor(stage, "Filter of query");
    await expect(filter).toBeFocused();
    await expect(filter).toHaveText("");
    // No filter, so nothing runs yet.
    await expect(
      stage.getByText("Write a filter to run this query."),
    ).toBeVisible();
  });

  test("its editor shows which section it's on, and a new base table starts it over", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/contextual-query");
    await openQueryEditor(page, stage, "featured");
    const editor = queryEditorOf(stage);
    const toggle = (name: string) =>
      editor.getByRole("button", { name, exact: true });
    await expect(toggle("Filter")).toHaveAttribute("aria-pressed", "true");
    await expect(toggle("Sort")).toHaveAttribute("aria-pressed", "false");
    await toggle("Display").click();
    await expect(toggle("Display")).toHaveAttribute("aria-pressed", "true");
    await expect(toggle("Filter")).toHaveAttribute("aria-pressed", "false");
    await expect(embedEditor(stage, "Display of featured")).toBeFocused();

    await editor.getByRole("button", { name: "Base table" }).click();
    // It lists credits: the one checked.
    await expect(
      page.getByRole("menuitemradio", { name: "credit", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await page
      .getByRole("menuitemradio", { name: "track", exact: true })
      .click();
    // Seeded as a new query on tracks would be: a track's own table has no
    // link to guess a filter from, and the display is a track's.
    await toggle("Filter").click();
    await expect(embedEditor(stage, "Filter of featured")).toHaveText("");
    await toggle("Display").click();
    await expect(embedEditor(stage, "Display of featured")).toHaveText(
      "$file.path $title",
    );
    await expect
      .poll(async () => (await writes(page)).at(-1))
      .toMatchObject({
        operations: [
          {
            operation: "update",
            schema: "metadata",
            table: "contextual_query",
            where: { id: "query-featured" },
          },
        ],
      });
    await editor.getByRole("button", { name: "Base table" }).click();
    await expect(
      page.getByRole("menuitemradio", { name: "track", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("Escape while it's being named drops a query being added", async ({
    page,
  }) => {
    const stage = await opened(page, "record-editor/provisional-query");
    await stage.getByRole("button", { name: "Record actions" }).click();
    await page.getByRole("menuitem", { name: "Add contextual query" }).click();
    await expect(stage.getByTestId("provisional-query")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(stage.getByTestId("provisional-query")).toHaveCount(0);
  });
});

test.describe("find and replace", () => {
  test("replaces in the form alone, keeping the field open, and remembers its toggles", async ({
    page,
  }) => {
    const stage = await openStory(page, "record-editor/find-replace", "light");
    await stage.getByRole("button", { name: "Expand title" }).click();
    const toggle = stage.getByRole("button", { name: "Find and replace" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await stage.getByRole("textbox", { name: "Find", exact: true }).fill("you");
    await stage
      .getByRole("textbox", { name: "Replace", exact: true })
      .fill("U");

    // "You" and "Yourself" are capitalized, so matching case finds neither,
    // and the choice outlives the form.
    const replace = stage.getByRole("button", { name: "Replace", exact: true });
    await expect(replace).toBeEnabled();
    await stage.getByRole("button", { name: "Match case" }).click();
    await expect(replace).toBeDisabled();
    expect(await page.evaluate(() => localStorage.getItem("findOptions"))).toBe(
      '{"matchCase":true,"wholeWord":false,"regex":false}',
    );
    await stage.getByRole("button", { name: "Match case" }).click();

    await replace.click();
    await expect(
      stage.getByRole("textbox", { name: "Find", exact: true }),
    ).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const values = stage.getByRole("textbox", { name: "title", exact: true });
    await expect(values).toHaveCount(3);
    await expect(values.nth(0)).toHaveValue(/^Don't Hurt Urself — Live/);
    await expect(values.nth(1)).toHaveValue("Hold Up");
    await expect(values.nth(2)).toHaveValue("Pray U Catch Me");
    // Only in the form: the field is starred until it's saved.
    await expect(stage.locator('[aria-label="title modified"]')).toBeVisible();
  });
});
