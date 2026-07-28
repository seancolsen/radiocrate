import { test, expect, type Locator, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "./fixtures";
import type { AppStore } from "../../src/state/store";

// The record-editor entry path: right-click a result row → a DOM context menu
// offering one "Edit {table}" per table whose primary key the row carries → the
// record editor opens as a sidebar inside the query page.
//
// The rows are canvas pixels, so the menu and the sidebar are the only parts a
// locator can see; the row underneath is addressed by coordinates (rows start at
// the canvas's top edge, ~40px tall).

/** The store the app exposes under `?expose=1`. */
interface AppWindow {
  __appStore: AppStore;
}

async function mockRpc(page: Page) {
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result =
      body.method === "query.list"
        ? QUERIES_FIXTURE
        : body.method === "preset.list"
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
}

/** The seeded grid, with rows carrying both a `track` and an `album` key, plus
 * the canned schema + record data the form is built and filled from (`?records=`
 * numbers rows from 1, and the fixture's ids match: row 0 is `track-1`). */
const SEEDED =
  "/?tabs=Lemonade&grid=lemonade&records=track,album&recordFixture=1&expose=1";

/** The same, with every record query held back — long enough to see the form
 * before its data lands. */
const slow = (ms: number) => `${SEEDED}&recordDelay=${ms}`;

async function openGrid(page: Page, url = SEEDED) {
  await mockRpc(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
}

/** Right-clicks a row of the results canvas (row 0 unless told otherwise). */
async function rightClickRow(page: Page, y = 20) {
  await page
    .locator("canvas")
    .click({ button: "right", position: { x: 200, y } });
}

/** The record-editor sidebar (the explorer is an `<aside>` too — match on the
 * accessible name). */
const editorPanel = (page: Page) =>
  page.getByRole("complementary", { name: /^Edit / });

/** The embedded records within the form — the previews of other rows. Only
 * those under a multi-record field are selectable; the one a scalar linked
 * record field shows is not. */
const embeddedRecords = (editor: Locator) => editor.locator(".rc-embedded");
const selectableRecords = (editor: Locator) =>
  editor.locator("[data-selectable]");

/** One form item, by the id the model tracks it under: `r` is the record the
 * editor was opened on, `r:title` its `title` field's label. */
const formItem = (editor: Locator, itemId: string) =>
  editor.locator(`[data-item-id="${itemId}"]`);

const selection = (page: Page) =>
  page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    return [...store.rowSelection(store.state.activeTabId!)];
  });

/** A y inside the nth seeded row. The grid lays rows out from its content, so
 * this is measured (~36px each) rather than declared — near enough the middle of
 * each of the five rows to be safe. */
const rowY = (index: number) => index * 36 + 18;

/** Opens the editor on a grid row through the context menu. */
async function openEditor(page: Page, table = "track", row = 0) {
  await rightClickRow(page, rowY(row));
  await page.getByRole("menuitem", { name: `Edit ${table}` }).click();
  await expect(editorPanel(page)).toBeVisible();
}

test("a row's context menu offers one entry per table it identifies", async ({
  page,
}) => {
  await openGrid(page);
  await rightClickRow(page);

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Edit track",
    "Edit album",
  ]);
  // Right-clicking a row also selects it, so the menu's target is visible.
  expect(await selection(page)).toEqual([0]);
});

test("rows with no primary key offer no menu", async ({ page }) => {
  // Same grid, without the `records=` lineage stand-in.
  await openGrid(page, "/?tabs=Lemonade&grid=lemonade&expose=1");
  await rightClickRow(page);
  await expect(page.getByRole("menu")).toBeHidden();
});

test("choosing an entry opens the record editor on that record", async ({
  page,
}) => {
  await openGrid(page);
  await rightClickRow(page, 60); // row 1
  await page.getByRole("menuitem", { name: "Edit album" }).click();

  const editor = editorPanel(page);
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("heading")).toHaveText("Edit album");
  // The seeded key value for row 1 (`?records=` numbers rows from 1).
  await expect(editor).toContainText("album-2");
  // Choosing an entry dismisses the menu.
  await expect(page.getByRole("menu")).toBeHidden();
});

test("the editor sidebar narrows the results, not the tab bar", async ({
  page,
}) => {
  await openGrid(page);
  const canvasWidth = async () =>
    (await page.locator("canvas").boundingBox())!.width;
  const tabBarWidth = async () =>
    (await page.getByTestId("tab-bar").boundingBox())!.width;

  const before = await canvasWidth();
  const tabsBefore = await tabBarWidth();
  await rightClickRow(page);
  await page.getByRole("menuitem", { name: "Edit track" }).click();
  await expect(editorPanel(page)).toBeVisible();

  const width = await page.evaluate(() =>
    (window as unknown as AppWindow).__appStore.recordSidebarWidth(),
  );
  expect(await canvasWidth()).toBeCloseTo(before - width, 0);
  // The tab bar spans the app frame, outside the query page, and keeps its width.
  expect(await tabBarWidth()).toBe(tabsBefore);
});

test("the menu blocks the rows beneath it", async ({ page }) => {
  await openGrid(page);
  // A 400×30 strip of canvas covering a row well below the menu's anchor.
  const strip = () =>
    page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const dpr = window.devicePixelRatio || 1;
      const ctx = canvas.getContext("2d")!;
      const d = ctx.getImageData(0, 88 * dpr, 400 * dpr, 30 * dpr).data;
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum = (sum * 31 + d[i]) >>> 0;
      return sum;
    });

  await rightClickRow(page); // selects row 0, opens the menu
  expect(await selection(page)).toEqual([0]);
  const blocked = await strip();

  // Hovering a row while the menu is up leaves it unpainted — no hover state.
  await page.mouse.move(300, 100);
  await page.waitForTimeout(50);
  expect(await strip()).toBe(blocked);

  // Clicking that row only dismisses the menu: the blocking layer swallows the
  // click, so the row underneath is never selected.
  await page.mouse.click(300, 100);
  await expect(page.getByRole("menu")).toBeHidden();
  expect(await selection(page)).toEqual([0]);

  // With the menu gone the same hover *does* repaint — so the check above was
  // watching something real. (Wheel scrolling is gated by the same freeze.)
  await page.mouse.move(0, 300);
  await page.mouse.move(300, 100);
  await expect.poll(strip).not.toBe(blocked);
});

test("Escape closes the menu; the close button closes the editor", async ({
  page,
}) => {
  await openGrid(page);
  await rightClickRow(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();

  await rightClickRow(page);
  await page.getByRole("menuitem", { name: "Edit track" }).click();
  const editor = editorPanel(page);
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Close record editor" }).click();
  await expect(editor).toBeHidden();
});

test("the sidebar is resizable, and its width persists", async ({ page }) => {
  await openGrid(page);
  await rightClickRow(page);
  await page.getByRole("menuitem", { name: "Edit track" }).click();
  const editor = editorPanel(page);
  await expect(editor).toBeVisible();
  const before = (await editor.boundingBox())!;

  // Drag the divider 120px to the left — the sidebar grows by that much.
  const divider = page.getByRole("separator", { name: "Resize record editor" });
  const grip = (await divider.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 120, grip.y + 200, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await editor.boundingBox())!.width)
    .toBeCloseTo(before.width + 120, 0);

  // The released width is what a reload restores (it lives in localStorage).
  const stored = await page.evaluate(() =>
    localStorage.getItem("recordSidebarWidth"),
  );
  expect(Number(stored)).toBeCloseTo(before.width + 120, 0);
  await page.reload();
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as unknown as AppWindow).__appStore.recordSidebarWidth(),
    ),
  ).toBeCloseTo(before.width + 120, 0);
});

// ── The form ────────────────────────────────────────────────────────────────
//
// Structure from introspection, data from the seeded fixture (`?recordFixture`),
// and everything below the top level fetched only once it's opened.

test("the form shows its field labels — and the id — before any data lands", async ({
  page,
}) => {
  await openGrid(page, slow(5000));
  await openEditor(page);
  const editor = editorPanel(page);

  // Every field of `track` is there: its own columns, then the tables that
  // reference it, alphabetically.
  await expect(editor.getByText("title", { exact: true })).toBeVisible();
  await expect(editor.getByText("credit", { exact: true })).toBeVisible();
  await expect(editor.getByText("play", { exact: true })).toBeVisible();
  // The key came with the row, so it renders; nothing else has arrived.
  await expect(editor.getByText("track-1")).toBeVisible();
  await expect(editor.getByText("Pray You Catch Me")).toBeHidden();
  // No pencils either — an unloaded field isn't known to be empty.
  await expect(editor.getByRole("button", { name: "Edit title" })).toBeHidden();
  // Nor anything to expand: the counts that say whether there's anything in
  // there haven't arrived.
  await expect(
    editor.getByRole("button", { name: "Expand credit" }),
  ).toBeHidden();
});

test("the form loads the record's values and its related-record counts", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page);
  const editor = editorPanel(page);

  await expect(
    editor.getByText("Pray You Catch Me", { exact: true }),
  ).toBeVisible();
  // The `file` link shows the record it points at, not the id it holds.
  await expect(embeddedRecords(editor).first()).toContainText(
    "Pray You Catch Me.flac",
  );
  await expect(editor.getByText("file-1")).toBeHidden();
  // `credit` and `play` show how many records reference this track.
  await expect(
    editor.getByRole("button", { name: "Expand credit" }),
  ).toBeVisible();
});

test("selecting another row rebuilds the form on that record", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page);
  const editor = editorPanel(page);
  const title = (text: string) => editor.getByText(text, { exact: true });
  await expect(title("Pray You Catch Me")).toBeVisible();

  // The sidebar follows the selection, and the form follows the sidebar.
  await page.locator("canvas").click({ position: { x: 200, y: rowY(2) } });
  await expect(title("Don't Hurt Yourself")).toBeVisible();
  await expect(title("Pray You Catch Me")).toBeHidden();
});

test("a NULL field offers a pencil, which activates an empty input", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page, "track", 4); // track-5 has no album
  const editor = editorPanel(page);

  const pencil = editor.getByRole("button", { name: "Edit album" });
  await expect(pencil).toBeVisible();
  await pencil.click();
  const input = editor.getByRole("textbox");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
});

test("clicking a value edits it; clicking away puts it back into view mode", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page);
  const editor = editorPanel(page);

  await editor.getByText("Pray You Catch Me", { exact: true }).click();
  const input = editor.getByRole("textbox");
  await expect(input).toBeFocused();
  await input.fill("Pray You Catch Me (Live)");
  // Clicking outside the box leaves edit mode, keeping what was typed.
  await editor.getByRole("heading").click();
  await expect(editor.getByRole("textbox")).toBeHidden();
  await expect(editor.getByText("Pray You Catch Me (Live)")).toBeVisible();
});

test("a text field too long for its line expands below its label", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page);
  const editor = editorPanel(page);

  // `title` fits on its line, so it has nothing to expand; the long `genre`
  // doesn't.
  await expect(
    editor.getByRole("button", { name: "Expand title" }),
  ).toBeHidden();
  await editor.getByRole("button", { name: "Expand genre" }).click();
  // Expanded, the value keeps its linebreaks instead of being flattened to one
  // ellipsized line.
  await expect(
    editor.getByText(/whole point is that it doesn't sit still/),
  ).toBeVisible();
});

test("expanding a multi-record field lists its records, each expandable in turn", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page, "track", 2); // track-3: two credits
  const editor = editorPanel(page);

  await editor.getByRole("button", { name: "Expand credit" }).click();
  // Each credit is previewed by the one column that identifies it at a glance:
  // its artist's name, a hop away through the `artist` link. They're ordered by
  // `ord`, which the same generation picked up.
  const credits = selectableRecords(editor);
  await expect(credits).toHaveCount(2);
  await expect(credits.first()).toHaveText("Beyoncé");
  await expect(credits.nth(1)).toHaveText("Jack White");

  // Expanding one loads that record's own form, without the `track` field it was
  // reached through.
  await editor.getByRole("button", { name: "Expand Jack White" }).click();
  await expect(editor.getByText("role", { exact: true })).toBeVisible();
  await expect(editor.getByText("Featured")).toBeVisible();
  await expect(editor.getByText("track", { exact: true })).toBeHidden();
});

test("expanding a scalar linked record field loads that record's form", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page);
  const editor = editorPanel(page);

  await editor.getByRole("button", { name: "Expand file" }).click();
  await expect(editor.getByText("path", { exact: true })).toBeVisible();
  // Both the embedded record above and the `path` field within the sub-form now
  // show the file's path.
  await expect(editor.getByText(/Pray You Catch Me\.flac/)).toHaveCount(2);
  // The linked record's own referencing fields are there too — the tree recurses
  // as far as the data goes.
  await expect(
    editor.getByRole("button", { name: "Collapse file" }),
  ).toBeVisible();
});

test("a multi-record field skeletons its records while they load", async ({
  page,
}) => {
  await openGrid(page, slow(500));
  await openEditor(page);
  const editor = editorPanel(page);

  // The count arrived with the top-level load, so the list has its shape — two
  // empty embedded records — before any of the records themselves are here.
  await editor.getByRole("button", { name: "Expand play" }).click();
  await expect(editor.getByTestId("record-placeholder")).toHaveCount(2);
  await expect(editor.getByTestId("record-placeholder")).toHaveCount(0);
});

// ── Embedded records, focus and selection ───────────────────────────────────

test("a scalar linked record field previews the record it points at", async ({
  page,
}) => {
  await openGrid(page, slow(700));
  await openEditor(page);
  const editor = editorPanel(page);

  // The preview is a second request, made once the top-level load hands over the
  // id: the widget is there, empty, before its content is.
  const preview = embeddedRecords(editor).first();
  await expect(preview).toBeVisible();
  await expect(preview).toHaveText("");
  await expect(preview).toContainText("Pray You Catch Me.flac");
  // It isn't a selectable item — the field's label is what the user selects.
  await expect(preview).not.toHaveAttribute("data-selectable", "");
});

test("embedded records select like result rows, with Shift and Ctrl", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page, "track", 4); // track-5: two credits
  const editor = editorPanel(page);
  await editor.getByRole("button", { name: "Expand credit" }).click();
  const credits = selectableRecords(editor);
  await expect(credits).toHaveCount(2);
  const selected = () =>
    editor.locator('[data-selectable][data-selected="true"]');

  await credits.first().click();
  await expect(selected()).toHaveCount(1);
  // A selected record is a focused one.
  await expect(credits.first()).toBeFocused();

  await credits.nth(1).click({ modifiers: ["Shift"] });
  await expect(selected()).toHaveCount(2);

  await credits.first().click({ modifiers: ["ControlOrMeta"] });
  await expect(selected()).toHaveCount(1);
  await expect(credits.nth(1)).toHaveAttribute("data-selected", "true");

  // Clicking anything that isn't a selectable record ends the selection.
  await editor.getByRole("heading").click();
  await expect(selected()).toHaveCount(0);
});

test("the arrow keys move between form items and open them", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page, "track", 2); // track-3: two credits
  const editor = editorPanel(page);

  // Clicking a field label selects it; Down walks to the next field's label.
  await formItem(editor, "r:title").click();
  await expect(formItem(editor, "r:title")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(formItem(editor, "r:album")).toBeFocused();

  // Right opens the focused field, Down then recurses into what it opened, and
  // Left closes it again.
  await formItem(editor, "r:#credit").click();
  await page.keyboard.press("ArrowRight");
  await expect(selectableRecords(editor)).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await expect(selectableRecords(editor).first()).toBeFocused();
  // Arrowing onto an embedded record selects it, as clicking it would.
  await expect(selectableRecords(editor).first()).toHaveAttribute(
    "data-selected",
    "true",
  );

  await formItem(editor, "r:#credit").click();
  await page.keyboard.press("ArrowLeft");
  await expect(selectableRecords(editor)).toHaveCount(0);
});

test("Delete clears the focused field, and drops a selected record", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page, "track", 2); // track-3: two credits
  const editor = editorPanel(page);

  // A primitive field goes to NULL — in the form only, until it's saved — which
  // is what the pencil is offering to fill back in.
  await formItem(editor, "r:title").click();
  await page.keyboard.press("Delete");
  await expect(
    editor.getByText("Don't Hurt Yourself", { exact: true }),
  ).toBeHidden();
  await expect(
    editor.getByRole("button", { name: "Edit title" }),
  ).toBeVisible();

  // A selected record within a multi-record field goes away, and the field's
  // count follows it down.
  await editor.getByRole("button", { name: "Expand credit" }).click();
  await selectableRecords(editor).first().click();
  await page.keyboard.press("Delete");
  await expect(selectableRecords(editor)).toHaveCount(1);
  await expect(selectableRecords(editor).first()).toHaveText("Jack White");
});

test("Ctrl+Click on a toggle opens every field beside it", async ({ page }) => {
  await openGrid(page);
  await openEditor(page, "track", 2);
  const editor = editorPanel(page);

  await editor
    .getByRole("button", { name: "Expand credit" })
    .click({ modifiers: ["ControlOrMeta"] });
  // `credit` and its siblings `file`, `genre` and `play` all opened at once.
  await expect(
    editor.getByRole("button", { name: "Collapse play" }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "Collapse file" }),
  ).toBeVisible();
});

test("Escape and Tab leave an activated field for a label", async ({
  page,
}) => {
  await openGrid(page);
  await openEditor(page);
  const editor = editorPanel(page);

  await editor.getByText("Pray You Catch Me", { exact: true }).click();
  await editor.getByRole("textbox").fill("Renamed");
  await page.keyboard.press("Escape");
  // The edit is kept in the form, and focus lands back on the field's label.
  await expect(editor.getByRole("textbox")).toBeHidden();
  await expect(editor.getByText("Renamed", { exact: true })).toBeVisible();
  await expect(formItem(editor, "r:title")).toBeFocused();

  // Tab out of an edit and focus moves on to the next item's label instead.
  await editor.getByText("Renamed", { exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(formItem(editor, "r:album")).toBeFocused();
});

// Screenshots: the menu over the rows, and the editor sidebar open beside them.
for (const colorScheme of ["light", "dark"] as const) {
  test(`row context menu - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SEEDED);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await rightClickRow(page);
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page).toHaveScreenshot(`record-menu-${colorScheme}.png`, {
      fullPage: true,
    });
  });

  // The form as it lands: every field of `track`, the values and counts loaded,
  // everything collapsed.
  test(`record editor sidebar - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SEEDED);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await rightClickRow(page);
    await page.getByRole("menuitem", { name: "Edit track" }).click();
    const editor = editorPanel(page);
    await expect(editor).toBeVisible();
    await expect(
      editor.getByText("Pray You Catch Me", { exact: true }),
    ).toBeVisible();
    // The `file` link's embedded record is a second request; wait for it, so the
    // widget is filled rather than caught empty.
    await expect(embeddedRecords(editor).first()).toContainText(".flac");
    await expect(page).toHaveScreenshot(`record-editor-${colorScheme}.png`, {
      fullPage: true,
    });
  });

  // …and opened out: a long text field expanded below its label, a multi-record
  // field listing its records, and one of those expanded into its own form.
  test(`record editor expanded - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SEEDED);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await rightClickRow(page, rowY(2)); // the track with two credits
    await page.getByRole("menuitem", { name: "Edit track" }).click();
    const editor = editorPanel(page);
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "Expand genre" }).click();
    await editor.getByRole("button", { name: "Expand credit" }).click();
    await editor.getByRole("button", { name: "Expand Jack White" }).click();
    await expect(editor.getByText("Featured")).toBeVisible();
    await expect(page).toHaveScreenshot(
      `record-editor-expanded-${colorScheme}.png`,
      {
        fullPage: true,
      },
    );
  });

  // The embedded records themselves, scoped to the panel: a multi-record field
  // listing its records with one of them selected, beside the scalar link's
  // unselectable preview.
  test(`embedded records - ${colorScheme}`, async ({ page }) => {
    await mockRpc(page);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SEEDED);
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await rightClickRow(page, rowY(2)); // the track with two credits
    await page.getByRole("menuitem", { name: "Edit track" }).click();
    const editor = editorPanel(page);
    await editor.getByRole("button", { name: "Expand credit" }).click();
    await expect(selectableRecords(editor)).toHaveCount(2);
    await selectableRecords(editor).first().click();
    await expect(embeddedRecords(editor).last()).toContainText("Jack White");
    await expect(editor).toHaveScreenshot(`record-embedded-${colorScheme}.png`);
  });
}
