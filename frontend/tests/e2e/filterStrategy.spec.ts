import type { Page } from "@playwright/test";
import { test, expect, look } from "./fixtures";
import { rpcAnswered } from "./support/app";

// Basic text filtering, against the real server: words typed into a filter go
// through the conversion to Querydown, the compiler and DuckDB's text search on
// the sample library. The sample's titles use a typographic apostrophe
// ("Don’t Stop"), which bare Querydown can't hold, so these words would be a
// syntax error as Querydown and are a plain search as basic text.

/** The active page's toolbar (other tabs' pages stay mounted, hidden). */
function toolbar(page: Page) {
  return page.getByTestId("query-toolbar").filter({ visible: true });
}

/** The active page's filter input, by the placeholder naming its strategy. */
function filterInput(page: Page, placeholder: string) {
  return page.getByPlaceholder(placeholder, { exact: true }).filter({
    visible: true,
  });
}

/** Switches the visible filter strategy toggle (the first, in a dialog when
 * one is open) to `strategy`. */
async function chooseStrategy(
  page: Page,
  strategy: "Basic text" | "Querydown",
) {
  await page
    .getByRole("button", { name: "Filter strategy" })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole("menuitemradio", { name: strategy }).click();
}

test("a basic-text filter finds what it says, stays basic text, and turns into the same Querydown", async ({
  app,
  page,
}) => {
  // The autosave alone waits out 5 s of quiet after the last edit's run.
  test.setTimeout(60_000);
  await app.openSource("Tracks");
  await expect(toolbar(page).getByText("63 tracks")).toBeVisible();

  await test.step("switch the filter to basic text and search", async () => {
    await toolbar(page)
      .getByRole("button", { name: "Filter", exact: true })
      .click();
    await expect(filterInput(page, "Querydown filter")).toBeVisible();
    await chooseStrategy(page, "Basic text");
    const saved = rpcAnswered(page, "source.update_definition", 20_000);
    await filterInput(page, "Basic text filter").fill("don’t stop");
    await expect(toolbar(page).getByText("1 track")).toBeVisible();
    await expect.poll(() => app.grid.text()).toMatch(/\tDon’t Stop\t/);
    await look(page, "basic-text");

    const response = await saved;
    expect(response.ok()).toBe(true);
    const { params } = response.request().postDataJSON() as {
      params: { definition: string };
    };
    expect(JSON.parse(params.definition)).toMatchObject({
      filter: { custom: "don’t stop", strategy: "basic_text" },
    });
  });

  await test.step("one word alone finds both its tracks", async () => {
    await filterInput(page, "Basic text filter").fill("don’t");
    await expect(toolbar(page).getByText("2 tracks")).toBeVisible();
  });

  await test.step("it reopens as basic text after a reload", async () => {
    await filterInput(page, "Basic text filter").fill("don’t stop");
    await expect(toolbar(page).getByText("1 track")).toBeVisible();
    const saved = rpcAnswered(page, "source.update_definition", 20_000);
    expect((await saved).ok()).toBe(true);
    // Closed, so that what reopens comes from the server, not the browser.
    await page.getByRole("button", { name: "Close Tracks" }).click();
    await app.reload();
    await app.openSource("Tracks");
    await expect(toolbar(page).getByText("1 track")).toBeVisible();
    await toolbar(page)
      .getByRole("button", { name: "Filter", exact: true })
      .click();
    await expect(filterInput(page, "Basic text filter")).toHaveText(
      "don’t stop",
    );
    await look(page, "reopened");
  });

  await test.step("switched to Querydown, it's the code it stood for, finding the same", async () => {
    await chooseStrategy(page, "Querydown");
    await expect(filterInput(page, "Querydown filter")).toHaveText(
      `"don’t" stop`,
    );
    await expect(toolbar(page).getByText("1 track")).toBeVisible();
    await expect.poll(() => app.grid.text()).toMatch(/\tDon’t Stop\t/);
    await look(page, "querydown");
  });
});

test("the record picker searches in basic text from the start, every time it opens", async ({
  app,
  page,
}) => {
  await app.openSource("Tracks");
  await expect.poll(() => app.grid.rowCount()).toBe(63);
  const editor = page.getByRole("complementary", { name: /^Edit / });
  const picker = page.getByRole("dialog");
  const results = picker.getByTestId("picker-results");
  // A filled link field's label opens its picker on a double-click.
  const albumLabel = editor.getByText("album", { exact: true });

  await test.step("open the album picker on a track", async () => {
    await (await app.grid.row("Lovely Rita")).openMenu();
    await page.getByRole("menuitem", { name: "Edit track" }).click();
    await expect(editor.getByRole("heading")).toHaveText("Edit track");
    await albumLabel.dblclick();
    await expect(picker.getByRole("heading")).toHaveText("Pick album");
  });

  await test.step("words find the album", async () => {
    await expect(picker.getByPlaceholder("Basic text filter")).toBeFocused();
    await picker.getByPlaceholder("Basic text filter").fill("sgt. pepper’s");
    await expect(results).toHaveAttribute("data-rows", "1");
    await look(page, "picker-basic-text");
  });

  await test.step("switched to Querydown, it finds the same", async () => {
    await chooseStrategy(page, "Querydown");
    await expect(picker.getByPlaceholder("Querydown filter")).toHaveText(
      `"sgt." "pepper’s"`,
    );
    await expect(results).toHaveAttribute("data-rows", "1");
  });

  await test.step("opened again, it's back on basic text, empty", async () => {
    await picker.getByRole("button", { name: "Close record picker" }).click();
    await expect(picker).toBeHidden();
    await albumLabel.dblclick();
    // Empty: every album is listed again. (An empty editor's text is its
    // placeholder, so the box itself can't say.)
    await expect(picker.getByPlaceholder("Basic text filter")).toBeFocused();
    await expect
      .poll(async () => Number(await results.getAttribute("data-rows")))
      .toBeGreaterThan(1);
    await expect(picker.getByPlaceholder("Querydown filter")).toHaveCount(0);
  });
});
