import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  PRESETS_FIXTURE,
  SOURCES_FIXTURE,
  TABLE_SUMMARIES_FIXTURE,
} from "../../src/dev/fixtures";
import { SCHEMES, openStory, snapshot } from "./harness";

// The Data structure page: a tree of the database's tables — each with its
// fields and its query presets — and the Querydown prelude. First what it looks
// like, a state at a time, through the component harness; then how it behaves
// there (the keyboard, the rows that stick, what's remembered, what a field's
// menu and the "Add field" menu do); then the assembled app's way into it, and
// the statistics it reads on the way.
//
// What the presets under it do — creating, renaming and deleting one — is
// `presets.spec.ts`'s, and the prelude's checking is `querydown.spec.ts`'s.

/** A row of the tree, by the start of what it says. */
function row(scope: Locator | Page, name: string | RegExp): Locator {
  return scope.getByRole("treeitem", {
    name: typeof name === "string" ? new RegExp(`^${name}`) : name,
  });
}

/** Scrolls the page until `target` is as high as it goes: right under the rows
 * of the items it's within, which stick there. From the top, since a row that's
 * stuck already is in view wherever its place in the page is. */
async function scrollToTop(target: Locator): Promise<void> {
  await target.evaluate((el) => {
    const page = el.closest('[data-testid="data-structure"]');
    if (page) page.scrollTop = 0;
    el.scrollIntoView({ block: "start" });
  });
}

/** Where a row sits within the page, from its top edge, in px. */
async function offsetIn(stage: Locator, target: Locator): Promise<number> {
  const [outer, inner] = await Promise.all([
    stage.getByTestId("data-structure").boundingBox(),
    target.boundingBox(),
  ]);
  return Math.round(inner!.y - outer!.y);
}

for (const colorScheme of SCHEMES) {
  // As it first opens: every table, closed, with its columns and rows counted,
  // and the prelude closed under them.
  test(`data-structure/tables - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "data-structure/tables", colorScheme);
    await expect(row(stage, "track 12,509 rows × 7 columns")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(row(stage, "Tables 10 tables")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/tables", colorScheme),
    );
  });

  // A table's fields, scrolled up under its row: columns with their types and
  // statistics, the hidden ones faded under a pressed "Show hidden fields",
  // then the related records and a contextual query, which have neither.
  test(`data-structure/fields - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "data-structure/fields", colorScheme);
    await scrollToTop(row(stage, /^track \d/));
    await expect(row(stage, "title Column VARCHAR")).toContainText(
      "11,876 distinct, 0% NULL",
    );
    await expect(row(stage, "featured Query")).toBeVisible();
    await expect(
      row(stage, "Fields").getByRole("button", { name: "Show hidden fields" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/fields", colorScheme),
    );
  });

  // Phone width.
  test(`data-structure/fields-narrow - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/fields-narrow",
      colorScheme,
    );
    await scrollToTop(row(stage, /^track \d/));
    await expect(row(stage, "track_number Column")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/fields-narrow", colorScheme),
    );
  });

  // A related-records field and a contextual query, each open on its query
  // editor: sorting and display with the ⋮ for the one, all three sections,
  // "Base table" and the "?" for the other.
  test(`data-structure/field-editors - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/field-editors",
      colorScheme,
    );
    await scrollToTop(row(stage, "Fields"));
    const editors = stage.getByTestId("field-query-editor");
    const related = editors.filter({
      has: page.getByLabel("Sorting of plays"),
    });
    await expect(related.getByRole("button", { name: "Filter" })).toHaveCount(
      0,
    );
    await expect(
      related.getByRole("button", { name: "Sort", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      related.getByRole("button", { name: "Input options" }),
    ).toBeVisible();
    const query = editors.filter({
      has: page.getByLabel("Filter of featured"),
    });
    await expect(
      query.getByRole("button", { name: "Base table" }),
    ).toBeVisible();
    await expect(query.getByLabel("Filter of featured")).toContainText(
      "track:=@id",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/field-editors", colorScheme),
    );
  });

  // The "Add field" menu, with its one way to add one.
  test(`data-structure/add-field - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/add-field",
      colorScheme,
    );
    await scrollToTop(row(stage, /^track \d/));
    await row(stage, "Fields")
      .getByRole("button", { name: "Add field" })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Contextual query" }),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/add-field", colorScheme),
    );
  });

  // Scrolled a long way into a table's presets: the rows of everything they're
  // within stuck to the top, one under the next.
  test(`data-structure/sticky - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "data-structure/sticky", colorScheme);
    await scrollToTop(row(stage, "Filter presets"));
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/sticky", colorScheme),
    );
  });

  // Two tables' presets by section, the album's empty sections ("None")
  // included, with the Default badges.
  test(`data-structure/presets - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "data-structure/presets", colorScheme);
    await scrollToTop(row(stage, /^track \d/));
    await expect(stage.getByRole("button", { name: /^vetted/ })).toBeVisible();
    await expect(stage.getByText("Default")).toHaveCount(3);
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/presets", colorScheme),
    );
  });

  // "vetted" and "loved" open at once, with an edit to the first on its way to
  // the backend: nothing to do about it, so no ✱ and no save.
  test(`data-structure/presets-expanded - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/presets-expanded",
      colorScheme,
    );
    await scrollToTop(row(stage, /^track \d/));
    await expect(stage.getByPlaceholder("Preset name")).toHaveCount(2);
    await expect(stage.getByLabel("Unsaved changes")).toHaveCount(0);
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/presets-expanded", colorScheme),
    );
  });

  // Hovering an open preset's heading, right of its ⋮ — which toggles it too:
  // the accent border around the whole preset.
  test(`data-structure/presets-hover - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/presets-expanded",
      colorScheme,
    );
    await scrollToTop(row(stage, /^track \d/));
    const toggle = stage.getByRole("button", { name: /^vetted/ });
    const box = (await toggle.boundingBox())!;
    await page.mouse.move(box.x + 400, box.y + box.height / 2);
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/presets-hover", colorScheme),
    );
  });

  // New presets at the top of their sections, in the editor a saved one
  // opens: one written from scratch, one a copy.
  test(`data-structure/presets-draft - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/presets-draft",
      colorScheme,
    );
    await expect(
      stage.getByRole("button", { name: "Create preset" }),
    ).toHaveCount(2);
    await expect(stage.getByLabel("Preset name").first()).toHaveValue(
      "nineties",
    );
    await expect(stage.getByLabel("Preset name").last()).toHaveValue(
      "by artist copy",
    );
    await scrollToTop(row(stage, /^track \d/));
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/presets-draft", colorScheme),
    );
  });

  // Deleting "vetted", which a saved query and an open playlist use: the
  // confirmation names both.
  test(`data-structure/preset-delete - ${colorScheme}`, async ({ page }) => {
    await openStory(page, "data-structure/preset-delete", colorScheme);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Road Trip")).toBeVisible();
    await expect(dialog.getByText("Lemonade")).toBeVisible();
    await expect(dialog).toHaveScreenshot(
      snapshot("data-structure/preset-delete", colorScheme),
    );
  });

  // The Querydown prelude's editor at the default value: Reset to default and
  // Save both disabled.
  test(`data-structure/prelude - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "data-structure/prelude", colorScheme);
    await expect(stage.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/prelude", colorScheme),
    );
  });

  // The prelude edited and not yet saved: the ✱ on Save.
  test(`data-structure/prelude-unsaved - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/prelude-unsaved",
      colorScheme,
    );
    await expect(stage.getByRole("button", { name: "Save" })).toBeEnabled();
    await expect(stage.getByTestId("prelude-unsaved")).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/prelude-unsaved", colorScheme),
    );
  });

  // The "?" hovered: the help in our own tooltip, not the browser's.
  test(`data-structure/prelude-help - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "data-structure/prelude", colorScheme);
    await stage.getByRole("button", { name: "Help" }).hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "prepend all queries",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/prelude-help", colorScheme),
    );
  });

  // The prelude holding a prelude that doesn't parse: the problem under the
  // toolbar, and Save disabled.
  test(`data-structure/prelude-problem - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/prelude-problem",
      colorScheme,
    );
    await expect(stage.getByRole("alert")).toContainText("Unclosed");
    await expect(stage.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/prelude-problem", colorScheme),
    );
  });
}

// ── How the tree behaves ─────────────────────────────────────────────────────

test("the arrow keys move between rows, and open and close them", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/tables", "light");
  const tables = row(stage, "Tables");
  const album = row(stage, /^album \d/);
  const artist = row(stage, /^artist \d/);

  await tables.focus();
  await page.keyboard.press("ArrowDown");
  await expect(album).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(artist).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(album).toBeFocused();

  // Right opens, then steps in; Left steps out, then closes.
  await page.keyboard.press("ArrowRight");
  await expect(album).toHaveAttribute("aria-expanded", "true");
  await expect(album).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(row(stage, "Fields")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  // A column has nothing to open, so Right leaves it where it is.
  const id = row(stage, "id Column UUID");
  await expect(id).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(id).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(stage, "Fields")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(stage, "Fields")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowLeft");
  await expect(album).toBeFocused();

  // Enter and Space open and close; End and Home go to the ends.
  await page.keyboard.press("Enter");
  await expect(album).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press(" ");
  await expect(album).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("End");
  await expect(row(stage, "Querydown prelude")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tables).toBeFocused();
});

test("a preset is a row of the tree, and Escape leaves an editor for its row", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/field-editors", "light");
  // Down from the last field's row: past its editor, to the next row there is.
  const featured = row(stage, "featured Query");
  await featured.focus();
  await page.keyboard.press("ArrowDown");
  await expect(row(stage, "Query settings")).toBeFocused();

  // Into an editor with the pointer, and out of it with Escape.
  const filter = stage.getByLabel("Filter of featured");
  await filter.click();
  await expect(filter).toBeFocused();
  // The arrows are the text's while the caret is in it.
  await page.keyboard.press("ArrowUp");
  await expect(filter).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(featured).toBeFocused();

  // A preset's heading takes the same keys.
  const story = await openStory(page, "data-structure/presets", "light");
  const sorting = row(story, "Sorting presets").first();
  await sorting.focus();
  await page.keyboard.press("ArrowDown");
  const preset = story.getByRole("button", { name: /^newest first/ });
  await expect(preset).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(preset).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(preset).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowLeft");
  await expect(sorting).toBeFocused();
});

test("a row with others under it sticks while they're scrolled", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/sticky", "light");
  const tables = row(stage, "Tables");
  const track = row(stage, /^track \d/);
  // `album`'s, `track`'s and `track_tag`'s are on show.
  const settings = row(stage, "Query settings").nth(1);
  const filters = row(stage, "Filter presets");
  await scrollToTop(filters);

  // One under the next, a row's height apart, and what was scrolled to under
  // them all rather than behind them.
  expect(await offsetIn(stage, tables)).toBe(0);
  expect(await offsetIn(stage, track)).toBe(30);
  expect(await offsetIn(stage, settings)).toBe(60);
  expect(await offsetIn(stage, filters)).toBe(90);
  // The tables above have scrolled away; the rows stuck are of `track` alone.
  await expect(row(stage, /^album \d/)).not.toBeInViewport();

  // Moving up with the keyboard brings a row out from under the stack.
  await filters.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  const lastField = row(stage, "featured Query");
  await expect(lastField).toBeFocused();
  expect(await offsetIn(stage, lastField)).toBeGreaterThanOrEqual(90);
});

test("Ctrl+Click on a row opens or closes every row beside it", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/tables", "light");
  const tables = stage
    .getByRole("group")
    .first()
    .locator(":scope > div > [role=treeitem]");
  await expect(tables).toHaveCount(10);
  await row(stage, /^track \d/).click({ modifiers: ["ControlOrMeta"] });
  for (const table of await tables.all()) {
    await expect(table).toHaveAttribute("aria-expanded", "true");
  }
  await row(stage, /^album \d/).click({ modifiers: ["ControlOrMeta"] });
  for (const table of await tables.all()) {
    await expect(table).toHaveAttribute("aria-expanded", "false");
  }
  // "Tables" itself is beside the prelude, not the tables.
  await expect(row(stage, "Tables")).toHaveAttribute("aria-expanded", "true");
});

test("what's open is still open after a reload", async ({ page }) => {
  const stage = await openStory(page, "data-structure/tables", "light");
  await row(stage, /^track \d/).click();
  await row(stage, "Fields").click();
  await row(stage, "Querydown prelude").click();
  await expect(row(stage, "title Column")).toBeVisible();

  await page.reload();
  await expect(row(stage, "title Column")).toBeVisible();
  await expect(row(stage, "Querydown prelude")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(row(stage, /^album \d/)).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  // Closing everything is remembered too, rather than read as a first visit.
  await row(stage, "Querydown prelude").click();
  await row(stage, "Tables").click();
  await page.reload();
  await expect(row(stage, "Tables")).toHaveAttribute("aria-expanded", "false");
  await expect(row(stage, /^album \d/)).toHaveCount(0);
});

/** The RPC calls the harness page has made, by method. */
async function calls(page: Page, method: string) {
  return await page.evaluate(
    (m) => (window.__rpcCalls ?? []).filter((c) => c.method === m),
    method,
  );
}

test("a field's context menu hides it, and brings it back", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/add-field", "light");
  const fields = row(stage, "Fields");
  const showHidden = fields.getByRole("button", { name: "Show hidden fields" });
  // Nothing hidden, nothing to show.
  await expect(row(stage, "Fields 10 fields")).toBeVisible();
  await expect(showHidden).toHaveCount(0);

  const title = row(stage, "title Column");
  await title.click({ button: "right" });
  // Hiding is all the menu offers a column.
  await expect(page.getByRole("menuitem")).toHaveCount(1);
  await page.getByRole("menuitem", { name: "Hide field" }).click();
  await expect
    .poll(() => calls(page, "metadata.field.set_visible"))
    .toEqual([
      {
        method: "metadata.field.set_visible",
        params: {
          tableName: "track",
          field: { columnName: "title" },
          visible: false,
        },
      },
    ]);
  // It's gone from the list, and the toggle that shows it is there.
  await expect(title).toHaveCount(0);
  await expect(row(stage, "Fields 9 fields")).toBeVisible();
  await expect(showHidden).toHaveAttribute("aria-pressed", "false");

  // Shown, it's listed faded.
  await showHidden.click();
  await expect(showHidden).toHaveAttribute("aria-pressed", "true");
  await expect(row(stage, "Fields 10 fields")).toBeVisible();
  await expect(title.locator(".opacity-60")).toHaveCount(1);

  await title.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Un-hide field" }).click();
  await expect(title.locator(".opacity-60")).toHaveCount(0);
  await expect
    .poll(async () => (await calls(page, "metadata.field.set_visible")).length)
    .toBe(2);
  // With nothing hidden, there's nothing for the toggle to show.
  await expect(showHidden).toHaveCount(0);
});

test("a contextual query's context menu renames it, and removes it", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/fields", "light");
  const dml = async () => (await calls(page, "dml")).length;
  await row(stage, "featured Query").click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText([
    "Rename",
    "Hide field",
    "Remove",
  ]);

  // Renamed in place, and the row has the keyboard back.
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const name = stage.getByLabel("Name of featured");
  await expect(name).toBeFocused();
  await name.fill("guest spots");
  await name.press("Enter");
  const renamed = row(stage, "guest spots Query");
  await expect(renamed).toBeFocused();
  await expect.poll(dml).toBe(1);

  // Escape backs out of a rename.
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await stage.getByLabel("Name of guest spots").fill("nope");
  await page.keyboard.press("Escape");
  await expect(renamed).toBeFocused();

  // Removing asks first.
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Remove “guest spots” from every track?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(renamed).toBeVisible();

  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove" })
    .click();
  await expect(renamed).toHaveCount(0);
  await expect.poll(dml).toBe(2);
});

test("Add field adds a contextual query, and opens it on its filter", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/add-field", "light");
  // From a closed "Fields": adding opens it, since that's where the query goes.
  const fields = row(stage, "Fields 10 fields");
  await fields.click();
  await expect(fields).toHaveAttribute("aria-expanded", "false");
  await row(stage, "Fields").getByRole("button", { name: "Add field" }).click();
  await page.getByRole("menuitem", { name: "Contextual query" }).click();
  await expect(fields).toHaveAttribute("aria-expanded", "true");

  // As in the record editor: a name to type over, then the table to list.
  const name = stage.getByLabel("Name of the new query");
  await expect(name).toBeFocused();
  await name.fill("credits by role");
  await name.press("Enter");
  await stage
    .getByTestId("provisional-query")
    .getByRole("combobox")
    .selectOption("credit");

  const added = row(stage, "credits by role Query");
  await expect(added).toHaveAttribute("aria-expanded", "true");
  await expect(row(stage, "Fields 11 fields")).toBeVisible();
  // The filter is guessed from the schema's links, and has the caret.
  const filter = stage.getByLabel("Filter of credits by role");
  await expect(filter).toContainText("track.id:@id");
  await expect(filter).toBeFocused();
  await expect
    .poll(async () => (await calls(page, "dml")).length)
    .toBeGreaterThan(0);
});

test("a related-records field's Querydown is written, and restored", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/field-editors", "light");
  const editor = stage.getByTestId("field-query-editor").filter({
    hasNot: page.getByRole("button", { name: "Filter", exact: true }),
  });
  const sorting = editor.getByLabel("Sorting of plays");
  const restore = page.getByRole("menuitem", { name: "Restore default" });
  const openOptions = () =>
    editor.getByRole("button", { name: "Input options" }).click();
  const generated = await sorting.textContent();

  await sorting.fill("\\\\timestamp");
  await openOptions();
  await expect(restore).toBeEnabled();
  await page.keyboard.press("Escape");
  // Written once the user leaves the editor, without waiting for the app to
  // go quiet.
  await editor.getByRole("button", { name: "Display" }).click();
  await expect(editor.getByLabel("Display of plays")).toBeVisible();
  await row(stage, "plays Related").click();
  await expect
    .poll(() => calls(page, "metadata.field.set_sorting"))
    .toEqual([
      {
        method: "metadata.field.set_sorting",
        params: {
          tableName: "track",
          field: {
            multiLink: { relatedTableName: "play", fkColumnName: "track" },
          },
          sorting: "\\\\timestamp",
        },
      },
    ]);

  await row(stage, "plays Related").click();
  await openOptions();
  await restore.click();
  await expect(sorting).toHaveText(generated ?? "");
  await openOptions();
  await expect(restore).toBeDisabled();
});

// ── In the assembled app ─────────────────────────────────────────────────────

/** Answers the RPC route from the fixtures, recording the methods called. */
async function mockRpc(page: Page): Promise<string[]> {
  const methods: string[] = [];
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    methods.push(body.method);
    const result =
      body.method === "source.list"
        ? SOURCES_FIXTURE
        : body.method === "preset.list"
          ? PRESETS_FIXTURE
          : body.method === "table.summarize"
            ? TABLE_SUMMARIES_FIXTURE
            : body.method.endsWith(".list")
              ? []
              : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
  await page.route("**/api/query", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
  return methods;
}

test("Settings opens the page, which reads the statistics once and again on Refresh", async ({
  page,
}) => {
  const methods = await mockRpc(page);
  const summaries = () => methods.filter((m) => m === "table.summarize").length;
  await page.goto("/?sidebar=open&recordFixture=1");
  // Nothing asks for them until the page is open.
  await expect.poll(() => methods).toContain("preset.list");
  expect(summaries()).toBe(0);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Data structure" }).click();
  const tree = page.getByTestId("data-structure");
  await expect(page.locator("[data-tab-id]")).toHaveText(["Data structure"]);
  await expect(row(tree, "track 12,509 rows × 7 columns")).toBeVisible();
  expect(summaries()).toBe(1);

  // Coming back to the tab doesn't read them again; Refresh does.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
  await page.locator("[data-tab-id]", { hasText: "Data structure" }).click();
  await expect(row(tree, /^track \d/)).toBeVisible();
  expect(summaries()).toBe(1);
  await tree.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(summaries).toBe(2);
  // Refresh is a control on the row, not the row: "Tables" stays open.
  await expect(row(tree, "Tables")).toHaveAttribute("aria-expanded", "true");
});

test("the page takes over a Query presets or Querydown Prelude tab left open", async ({
  page,
}) => {
  await mockRpc(page);
  await page.addInitScript(() => {
    if (localStorage.getItem("openTabs") !== null) return;
    localStorage.setItem(
      "openTabs",
      JSON.stringify({
        version: 1,
        activeTabId: "settings:querydown-prelude",
        tabs: [{ kind: "presets" }, { kind: "prelude" }],
      }),
    );
  });
  await page.goto("/?recordFixture=1");
  await expect(page.locator("[data-tab-id]")).toHaveText(["Data structure"]);
  await expect(page.getByTestId("data-structure")).toBeVisible();
});
