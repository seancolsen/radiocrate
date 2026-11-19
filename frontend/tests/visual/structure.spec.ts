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

  // The "Add field" menu: a computed column, or a contextual query.
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
    await expect(page.getByRole("menuitem")).toHaveText([
      "Computed column",
      "Contextual query",
    ]);
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/add-field", colorScheme),
    );
  });

  // A table's computed columns: one of the app's own open on its expression,
  // another customized, and one of the user's own, open too.
  test(`data-structure/computed-columns - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/computed-columns",
      colorScheme,
    );
    await scrollToTop(row(stage, "firstplay Computed"));
    await expect(row(stage, "lastplay Computed")).toContainText("Built-in");
    await expect(row(stage, "year Computed")).toContainText("Customized");
    await expect(stage.getByLabel("Expression of lastplay")).toHaveText(
      "#play.timestamp%max",
    );
    await expect(stage.getByLabel("Expression of tagcount")).toHaveText(
      "#track_tag",
    );
    // Only the app's own has a default to go back to.
    await expect(
      stage.getByRole("button", { name: "Reset to default" }),
    ).toHaveCount(1);
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/computed-columns", colorScheme),
    );
  });

  // A computed column whose expression doesn't fit the schema: the problem
  // under its editor.
  test(`data-structure/computed-column-problem - ${colorScheme}`, async ({
    page,
  }) => {
    const stage = await openStory(
      page,
      "data-structure/computed-column-problem",
      colorScheme,
    );
    await expect(stage.getByRole("alert")).toContainText(
      "Column yeer not found",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/computed-column-problem", colorScheme),
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

  // The Querydown prelude's editor on a prelude the user saved: nothing to
  // save, and no default to go back to.
  test(`data-structure/prelude - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "data-structure/prelude", colorScheme);
    await expect(stage.getByLabel("Querydown Prelude")).toContainText(
      "@recent = 1m",
    );
    await expect(stage.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(
      stage.getByRole("button", { name: "Reset to default" }),
    ).toHaveCount(0);
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/prelude", colorScheme),
    );
  });

  // As it is until the user writes one: empty, the app having no prelude of
  // its own.
  test(`data-structure/prelude-empty - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/prelude-empty",
      colorScheme,
    );
    await expect(stage.getByLabel("Querydown Prelude")).toHaveText("");
    await expect(stage.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/prelude-empty", colorScheme),
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
      "ahead of every query",
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

/** The tables listed, top to bottom, by name. */
async function tableNames(stage: Locator): Promise<string[]> {
  const rows = stage.locator(
    '[data-item-id^="table:"]:not([data-item-id*="/"]) > [role="treeitem"]',
  );
  return (await rows.allInnerTexts()).map((text) => text.split(/\s/)[0]);
}

/** Presses on table `from`'s row and moves the mouse to a fraction `at` of the
 * way down table `to`'s row, leaving the button down. */
async function dragTable(
  page: Page,
  stage: Locator,
  from: string,
  to: string,
  at: number,
) {
  const a = (await row(stage, `${from} `).boundingBox())!;
  const b = (await row(stage, `${to} `).boundingBox())!;
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + b.height * at, { steps: 8 });
}

for (const colorScheme of SCHEMES) {
  // The tables as the user has arranged them: two dragged to the top, and a
  // hidden one listed faded under the pressed "Show hidden tables".
  test(`data-structure/tables-arranged - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/tables-arranged",
      colorScheme,
    );
    expect((await tableNames(stage)).slice(0, 3)).toEqual([
      "track",
      "album",
      "artist",
    ]);
    await expect(
      row(stage, "Tables").getByRole("button", { name: "Show hidden tables" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/tables-arranged", colorScheme),
    );
  });

  // A table in hand: dimmed where it is, its chip by the pointer, and the drop
  // line in the gap it would land in.
  test(`data-structure/table-drag - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(page, "data-structure/tables", colorScheme);
    await dragTable(page, stage, "role", "artist", 0.1);
    await expect(stage.locator("[data-drag-row].opacity-50")).toHaveCount(1);
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/table-drag", colorScheme),
    );
  });

  // A table's text search, open at the app's default.
  test(`data-structure/text-search - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/text-search",
      colorScheme,
    );
    await scrollToTop(row(stage, "Query settings"));
    await expect(stage.getByLabel("Text search of track")).toContainText(
      "++#artist{name:@x}",
    );
    await expect(
      stage.getByRole("button", { name: "Reset to default" }),
    ).toBeDisabled();
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/text-search", colorScheme),
    );
  });

  // Its "?": the help, in a popover.
  test(`data-structure/text-search-help - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/text-search",
      colorScheme,
    );
    await stage.getByRole("button", { name: "About text search" }).click();
    const help = page.getByTestId("help-popover");
    await expect(help).toContainText(
      "When you enter bare words into a Querydown filter for track records",
    );
    await expect(help).toHaveScreenshot(
      snapshot("data-structure/text-search-help", colorScheme),
    );
  });

  // A linked record comparison naming a column its table hasn't got.
  test(`data-structure/setting-problem - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/setting-problem",
      colorScheme,
    );
    await scrollToTop(row(stage, "Query settings"));
    await expect(stage.getByRole("alert")).toContainText("titel");
    await expect(row(stage, "Linked record comparison")).toContainText(
      "Customized",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/setting-problem", colorScheme),
    );
  });

  // A table's custom comparisons: the app's own, at its condition, and one of
  // the user's.
  test(`data-structure/custom-comparisons - ${colorScheme}`, async ({
    page,
  }) => {
    const stage = await openStory(
      page,
      "data-structure/custom-comparisons",
      colorScheme,
    );
    await scrollToTop(row(stage, "Custom comparisons"));
    await expect(row(stage, "Custom comparisons")).toContainText("2");
    await expect(stage.getByLabel("Condition of artist on track")).toHaveText(
      "++#artist{name:@x}",
    );
    await expect(row(stage, /^artist (Built-in|Customized)$/)).toContainText(
      "Built-in",
    );
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/custom-comparisons", colorScheme),
    );
  });

  // A comparison naming a column its table hasn't got.
  test(`data-structure/comparison-problem - ${colorScheme}`, async ({
    page,
  }) => {
    const stage = await openStory(
      page,
      "data-structure/comparison-problem",
      colorScheme,
    );
    await scrollToTop(row(stage, "Custom comparisons"));
    await expect(stage.getByRole("alert")).toContainText("labl");
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/comparison-problem", colorScheme),
    );
  });

  // A table's record picker, open on its sorting.
  test(`data-structure/record-picker - ${colorScheme}`, async ({ page }) => {
    const stage = await openStory(
      page,
      "data-structure/record-picker",
      colorScheme,
    );
    await scrollToTop(row(stage, "Query settings"));
    await expect(
      stage.getByLabel("Sorting of the record picker on album"),
    ).toBeVisible();
    await expect(stage).toHaveScreenshot(
      snapshot("data-structure/record-picker", colorScheme),
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
    .locator("[data-drag-row] > [role=treeitem]");
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
  await expect(row(stage, "Fields 17 fields")).toBeVisible();
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
  await expect(row(stage, "Fields 16 fields")).toBeVisible();
  await expect(showHidden).toHaveAttribute("aria-pressed", "false");

  // Shown, it's listed faded.
  await showHidden.click();
  await expect(showHidden).toHaveAttribute("aria-pressed", "true");
  await expect(row(stage, "Fields 17 fields")).toBeVisible();
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
  const fields = row(stage, "Fields 17 fields");
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
  await expect(row(stage, "Fields 18 fields")).toBeVisible();
  // The filter is guessed from the schema's links, and has the caret.
  const filter = stage.getByLabel("Filter of credits by role");
  await expect(filter).toContainText("track.id:@id");
  await expect(filter).toBeFocused();
  await expect
    .poll(async () => (await calls(page, "dml")).length)
    .toBeGreaterThan(0);
});

test("Add field adds a computed column, and opens it on its expression", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/add-field", "light");
  // From a closed "Fields": adding opens it, since that's where the column
  // goes.
  const fields = row(stage, "Fields 17 fields");
  await fields.click();
  await expect(fields).toHaveAttribute("aria-expanded", "false");
  await row(stage, "Fields").getByRole("button", { name: "Add field" }).click();
  await page.getByRole("menuitem", { name: "Computed column" }).click();
  await expect(fields).toHaveAttribute("aria-expanded", "true");

  // A name to type over, which is made into one a query can say.
  const name = stage.getByLabel("Name of the new computed column");
  await expect(name).toBeFocused();
  await name.fill("release decade");
  await name.press("Enter");

  const added = row(stage, "release_decade Computed");
  await expect(added).toHaveAttribute("aria-expanded", "true");
  await expect(row(stage, "Fields 18 fields")).toBeVisible();
  expect(await calls(page, "metadata.computed_column.set")).toEqual([
    {
      method: "metadata.computed_column.set",
      params: { tableName: "track", name: "release_decade", expression: "" },
    },
  ]);
  // The expression has the caret, and is written as its row closes.
  const expression = stage.getByLabel("Expression of release_decade");
  await expect(expression).toBeFocused();
  await expect(stage.getByText("isn’t defined yet")).toBeVisible();
  await page.keyboard.type("album.year");
  await added.click();
  await expect
    .poll(async () =>
      (await calls(page, "metadata.computed_column.set")).at(-1),
    )
    .toEqual({
      method: "metadata.computed_column.set",
      params: {
        tableName: "track",
        name: "release_decade",
        expression: "album.year",
      },
    });
});

test("a computed column of the user's is renamed and removed from its menu, one of the app's only hidden", async ({
  page,
}) => {
  const stage = await openStory(
    page,
    "data-structure/computed-columns",
    "light",
  );
  // One of the app's own: its name is fixed, and it's there to stay.
  await row(stage, "year Computed").click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["Hide field"]);
  await page.keyboard.press("Escape");

  const mine = row(stage, "tagcount Computed");
  await mine.click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText([
    "Rename",
    "Hide field",
    "Remove",
  ]);
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const name = stage.getByLabel("Name of tagcount");
  await expect(name).toBeFocused();
  await name.fill("tags");
  await name.press("Enter");
  // Its row goes by the new name, still open on its expression.
  const renamed = row(stage, "tags Computed");
  await expect(renamed).toBeFocused();
  await expect(renamed).toHaveAttribute("aria-expanded", "true");
  await expect(stage.getByLabel("Expression of tags")).toHaveText("#track_tag");
  expect(await calls(page, "metadata.computed_column.rename")).toEqual([
    {
      method: "metadata.computed_column.rename",
      params: { tableName: "track", name: "tagcount", newName: "tags" },
    },
  ]);

  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Remove “tags” from every track?");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(renamed).toHaveCount(0);
  await expect
    .poll(() => calls(page, "metadata.computed_column.delete"))
    .toEqual([
      {
        method: "metadata.computed_column.delete",
        params: { tableName: "track", name: "tags" },
      },
    ]);
});

test("one of the app's computed columns takes the user's expression, and is reset", async ({
  page,
}) => {
  const stage = await openStory(
    page,
    "data-structure/computed-columns",
    "light",
  );
  const lastplay = row(stage, "lastplay Computed");
  const editor = stage
    .getByTestId("computed-column-editor")
    .filter({ has: page.getByLabel("Expression of lastplay") });
  const expression = editor.getByLabel("Expression of lastplay");
  const reset = editor.getByRole("button", { name: "Reset to default" });
  await expect(lastplay).toContainText("Built-in");
  await expect(reset).toBeDisabled();

  await expression.fill("#play.timestamp%min");
  await expect(lastplay).toContainText("Customized");
  await expect(reset).toBeEnabled();
  // Left blank, the app's expression is the one in force again.
  await expression.fill("");
  await expect(lastplay).toContainText("Built-in");
  await expect(editor.getByText("Blank: the default is used.")).toBeVisible();

  // Reset goes straight out, and the app's own expression is back on show.
  await reset.click();
  await expect(expression).toHaveText("#play.timestamp%max");
  await expect(reset).toBeDisabled();
  await expect
    .poll(async () =>
      (await calls(page, "metadata.computed_column.set")).at(-1),
    )
    .toEqual({
      method: "metadata.computed_column.set",
      params: { tableName: "track", name: "lastplay", expression: null },
    });
});

test("a custom comparison is added, renamed and removed, one of the app's only reset", async ({
  page,
}) => {
  const stage = await openStory(
    page,
    "data-structure/custom-comparisons",
    "light",
  );
  // One of the app's own: its name is fixed, and it's there to stay.
  await row(stage, /^artist (Built-in|Customized)$/).click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveCount(0);

  const list = row(stage, "Custom comparisons");
  await list
    .getByRole("button", { name: "New custom comparison for track" })
    .click();
  const name = stage.getByLabel("Name of the new custom comparison");
  await expect(name).toBeFocused();
  await name.fill("by label");
  await name.press("Enter");
  const added = row(stage, "by_label");
  await expect(added).toHaveAttribute("aria-expanded", "true");
  await expect(list).toContainText("3");
  const condition = stage.getByLabel("Condition of by_label on track");
  await expect(condition).toBeFocused();
  await expect(
    stage.getByText("Blank: by_label isn’t defined yet."),
  ).toBeVisible();
  await page.keyboard.type("album.title:@x");
  await added.click();
  await expect
    .poll(async () =>
      (await calls(page, "metadata.custom_comparison.set")).at(-1),
    )
    .toEqual({
      method: "metadata.custom_comparison.set",
      params: {
        tableName: "track",
        name: "by_label",
        expression: "album.title:@x",
      },
    });

  await added.click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["Rename", "Remove"]);
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = stage.getByLabel("Name of by_label");
  await rename.fill("label");
  await rename.press("Enter");
  const renamed = row(stage, "label");
  await expect(renamed).toBeFocused();
  expect(await calls(page, "metadata.custom_comparison.rename")).toEqual([
    {
      method: "metadata.custom_comparison.rename",
      params: { tableName: "track", name: "by_label", newName: "label" },
    },
  ]);

  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Remove “label” from track?");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(renamed).toHaveCount(0);
  await expect
    .poll(() => calls(page, "metadata.custom_comparison.delete"))
    .toEqual([
      {
        method: "metadata.custom_comparison.delete",
        params: { tableName: "track", name: "label" },
      },
    ]);

  // The app's own takes the user's condition, and is reset.
  const artist = stage.getByLabel("Condition of artist on track");
  const reset = stage.getByRole("button", { name: "Reset to default" });
  await expect(reset).toBeDisabled();
  await artist.fill("++#artist{name:=@x}");
  await expect(row(stage, /^artist (Built-in|Customized)$/)).toContainText(
    "Customized",
  );
  await reset.click();
  await expect(artist).toHaveText("++#artist{name:@x}");
  await expect(row(stage, /^artist (Built-in|Customized)$/)).toContainText(
    "Built-in",
  );
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

test("a table's context menu hides it, and brings it back", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/tables", "light");
  const tables = row(stage, "Tables");
  const showHidden = tables.getByRole("button", { name: "Show hidden tables" });
  await expect(showHidden).toHaveCount(0);

  const role = row(stage, "role ");
  await role.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide table" }).click();
  await expect
    .poll(() => calls(page, "metadata.table.set_visible"))
    .toEqual([
      {
        method: "metadata.table.set_visible",
        params: { tableName: "role", visible: false },
      },
    ]);
  await expect(role).toHaveCount(0);
  await expect(row(stage, "Tables 9 tables")).toBeVisible();

  // The toggle is about what's listed under the row: closed, it's gone.
  await tables.click();
  await expect(showHidden).toHaveCount(0);
  await tables.click();
  await expect(showHidden).toHaveCount(1);

  await showHidden.click();
  await expect(role.locator(".opacity-60")).toHaveCount(1);
  await role.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Un-hide table" }).click();
  await expect(role.locator(".opacity-60")).toHaveCount(0);
  await expect(showHidden).toHaveCount(0);
});

test("a table dropped in a new place moves there, and is written", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/tables", "light");
  const before = await tableNames(stage);
  expect(before.slice(0, 2)).toEqual(["album", "artist"]);

  await dragTable(page, stage, "role", "artist", 0.1);
  // Nothing moves until it's dropped.
  expect(await tableNames(stage)).toEqual(before);
  await page.mouse.up();

  const after = before.filter((name) => name !== "role");
  after.splice(1, 0, "role");
  await expect.poll(() => tableNames(stage)).toEqual(after);
  const writes = await calls(page, "metadata.table.set_order");
  expect(writes).toHaveLength(1);
  // The first move gives every table a key, in the new order.
  expect(writes[0].params).toEqual({
    orders: after.map((tableName, i) => ({ tableName, order: i + 1 })),
  });
  // The release's click didn't open the table.
  await expect(row(stage, "role ")).toHaveAttribute("aria-expanded", "false");
});

test("a table is picked up by a long press, and held without a move raises its menu", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/tables", "light");
  const before = await tableNames(stage);
  const cdp = await page.context().newCDPSession(page);
  const from = (await row(stage, "role ").boundingBox())!;
  const to = (await row(stage, "artist ").boundingBox())!;
  const x = from.x + 40;

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y: from.y + from.height / 2 }],
  });
  await page.waitForTimeout(700);
  await expect(stage.locator("[data-drag-row].opacity-50")).toHaveCount(1);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x, y: to.y + 2 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const moved = before.filter((name) => name !== "role");
  moved.splice(1, 0, "role");
  await expect.poll(() => tableNames(stage)).toEqual(moved);
  await expect(page.getByRole("menuitem")).toHaveCount(0);

  const held = (await row(stage, "track ").boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: held.x + 40, y: held.y + held.height / 2 }],
  });
  await page.waitForTimeout(700);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(
    page.getByRole("menuitem", { name: "Hide table" }),
  ).toBeVisible();
  expect(await tableNames(stage)).toEqual(moved);
});

test("a text search is written once its editor closes, and reset", async ({
  page,
}) => {
  const stage = await openStory(page, "data-structure/text-search", "light");
  const editor = stage.getByLabel("Text search of track");
  const reset = stage.getByRole("button", { name: "Reset to default" });
  const settingRow = row(stage, "Text search");
  const defaultText = await editor.textContent();

  await editor.fill("title:@x");
  await expect(settingRow).toContainText("Customized");
  await expect(reset).toBeEnabled();
  // Written as the editor goes, without waiting for the app to go quiet.
  await settingRow.click();
  await expect
    .poll(() => calls(page, "metadata.table.set_querydown"))
    .toEqual([
      {
        method: "metadata.table.set_querydown",
        params: {
          tableName: "track",
          setting: "defaultTextSearch",
          text: "title:@x",
        },
      },
    ]);

  await settingRow.click();
  await reset.click();
  await expect(editor).toHaveText(defaultText ?? "");
  await expect(settingRow).toContainText("Built-in");
  await expect
    .poll(async () =>
      (await calls(page, "metadata.table.set_querydown")).at(-1),
    )
    .toMatchObject({ params: { text: null } });
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
