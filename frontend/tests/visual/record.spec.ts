import { test, expect, type Locator, type Page } from "@playwright/test";
import { SCHEMES, openStory, snapshot, valueEditor } from "./harness";

// The record editor, on its own: the panel as its form lands and opened out,
// mid-edit and after a refused save; the modal picker it opens; and the
// embedded-record widget, straight from cells.

/** The red ✱ marking one field — or one embedded record — as modified. */
const star = (panel: Locator, label: string) =>
  panel.locator(`[aria-label="${label} modified"]`);

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
