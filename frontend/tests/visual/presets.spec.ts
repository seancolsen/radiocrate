import { test, expect, type Page } from "@playwright/test";
import {
  PRESETS_FIXTURE,
  SOURCES_FIXTURE,
  VETTED_PRESET_ID,
} from "../../src/dev/fixtures";
import type { AppStoreFacade } from "../../src/dev/seed";

// Presets in the assembled app, all the way to the RPC: the preset manager,
// reached from the Settings menu, creating, renaming and deleting one; and a
// query's own presets, which it folds into its custom Querydown, takes out,
// and can run with before they've ever been saved.

/** An RPC call the app made: its method and params. */
interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** Answers the RPC route from the fixtures (with `presets` for the preset list),
 * recording every call. */
async function mockRpc(
  page: Page,
  presets: readonly unknown[] = PRESETS_FIXTURE,
): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as Call & { id: number };
    calls.push({ method: body.method, params: body.params });
    const result =
      body.method === "source.list"
        ? SOURCES_FIXTURE
        : body.method === "preset.list"
          ? presets
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
  return calls;
}

test("the preset manager creates, renames and deletes a preset", async ({
  page,
}) => {
  const calls = await mockRpc(page);
  const methods = () => calls.map((c) => c.method);
  await page.goto("/?sidebar=open");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Query presets" }).click();
  const manager = page.getByTestId("preset-manager");
  // Every table starts collapsed.
  const track = manager.getByRole("button", { name: /^track \d/ });
  await expect(track).toHaveAttribute("aria-expanded", "false");
  await track.click();
  await expect(manager.getByRole("button", { name: /^vetted/ })).toBeVisible();

  // Create: a sort for `track`, from its section heading's "+", inline.
  await manager
    .getByRole("button", { name: "New sorting preset for track" })
    .click();
  const name = manager.getByLabel("Preset name");
  await expect(name).toBeFocused();
  await name.fill("by year");
  await manager.getByLabel("Preset definition").fill("\\\\year");
  await manager.getByRole("button", { name: "Create preset" }).click();
  // It opens in the editor, as saved.
  await expect(
    manager.getByRole("button", { name: /^by year/ }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect.poll(methods).toContain("preset.add");
  expect(calls.find((c) => c.method === "preset.add")?.params).toMatchObject({
    name: "by year",
    baseTable: "track",
    section: "sort",
    definition: "\\\\year",
    isDefault: false,
  });

  // Rename, in its editor. It stays open, and closing it sends the write
  // without waiting for the app to go quiet.
  await manager.getByLabel("Preset name").fill("by decade");
  const heading = manager.getByRole("button", { name: /^by decade/ });
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  expect(methods()).not.toContain("preset.update");
  await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await expect.poll(methods).toContain("preset.update");
  expect(calls.find((c) => c.method === "preset.update")?.params).toMatchObject(
    { name: "by decade", definition: "\\\\year" },
  );

  // Delete, from the row's menu, through the confirmation.
  await manager.getByRole("button", { name: "Actions for by decade" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(manager.getByRole("button", { name: /^by decade/ })).toHaveCount(
    0,
  );
  await expect.poll(methods).toContain("preset.delete");
});

test("Ctrl+Click on a table expands or collapses every table", async ({
  page,
}) => {
  await mockRpc(page);
  await page.goto("/?sidebar=open");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Query presets" }).click();
  const manager = page.getByTestId("preset-manager");
  const headings = manager.getByRole("heading").getByRole("button");
  await expect(headings.first()).toBeVisible();
  const count = await headings.count();
  expect(count).toBeGreaterThan(1);

  await manager
    .getByRole("button", { name: /^track \d/ })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(
    manager.getByRole("heading").getByRole("button", { expanded: true }),
  ).toHaveCount(count);

  await manager
    .getByRole("button", { name: /^album \d/ })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(
    manager.getByRole("heading").getByRole("button", { expanded: true }),
  ).toHaveCount(0);
});

/** The active tab's working definition, read out of the exposed store. */
async function liveDefinition(page: Page) {
  return await page.evaluate(() => {
    const store = (window as unknown as { __appStore: AppStoreFacade })
      .__appStore;
    return store.queryTab(store.state.activeTabId ?? "")?.live;
  });
}

/** Opens "Lemonade" on `def`, saved, with the record fixture's schema to compile
 * against, and its filter builder open. */
async function openQuery(page: Page, def: unknown): Promise<void> {
  const encoded = encodeURIComponent(JSON.stringify(def));
  await page.goto(
    `/?tabs=Lemonade&clean=1&recordFixture=1&expose=1&section=filter&def=${encoded}`,
  );
  await expect(page.getByTestId("query-toolbar")).toBeVisible();
}

/** A section's options menu, opened. */
async function openOptions(page: Page, section: string): Promise<void> {
  await page.getByRole("button", { name: `${section} options` }).click();
}

const RUNNABLE = {
  base: "track",
  filter: { custom: "", presets: [] as string[] },
  sort: { custom: "" } as unknown,
  display: { custom: "" },
};

/** A preset the record fixture's schema compiles. */
const TITLE_PRESET = {
  ...PRESETS_FIXTURE[0],
  name: "titled",
  definition: "title:jazz",
};

test("a query's preset is inlined into the custom filter, or removed", async ({
  page,
}) => {
  await mockRpc(page, [TITLE_PRESET]);
  await openQuery(page, {
    ...RUNNABLE,
    filter: { custom: "year:1999", presets: [VETTED_PRESET_ID] },
  });
  const inline = page.getByRole("button", { name: "Inline into custom" });
  const remove = page.getByRole("button", { name: "Remove preset" });
  const heading = page.getByRole("button", { name: /^titled/ });
  // No actions menu on a query's preset.
  await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(
    0,
  );

  // Closed: Remove only. Open: Inline appears in the editor, and Remove goes.
  await expect(inline).toHaveCount(0);
  await heading.click();
  await expect(inline).toBeVisible();
  await expect(remove).toHaveCount(0);
  await heading.click();
  await expect(remove).toBeVisible();
  await expect(inline).toHaveCount(0);

  await heading.click();
  await inline.click();
  await expect(heading).toHaveCount(0);
  await expect
    .poll(async () => (await liveDefinition(page))?.filter)
    .toEqual({ custom: "year:1999\ntitle:jazz", presets: [] });

  await openOptions(page, "Filter");
  await page.getByRole("menuitemcheckbox", { name: "titled" }).click();
  await expect(heading).toBeVisible();
  await remove.click();
  await expect(heading).toHaveCount(0);
  await expect
    .poll(async () => (await liveDefinition(page))?.filter)
    .toEqual({ custom: "year:1999\ntitle:jazz", presets: [] });
});

test("typing into a query's preset re-runs the query and saves it later", async ({
  page,
}) => {
  const calls = await mockRpc(page, [TITLE_PRESET]);
  const runs: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/query")) {
      runs.push(request.postData() ?? "");
    }
  });
  await openQuery(page, {
    ...RUNNABLE,
    filter: { custom: "", presets: [VETTED_PRESET_ID] },
  });
  await expect.poll(() => runs.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: /^titled/ }).click();
  const before = runs.length;
  await page.getByLabel("Preset definition").fill("title:blues");
  await expect.poll(() => runs.slice(before).join()).toContain("blues");
  // Still open, and not written yet: the app hasn't gone quiet.
  await expect(page.getByLabel("Preset definition")).toBeVisible();
  const updates = () => calls.filter((c) => c.method === "preset.update");
  expect(updates()).toHaveLength(0);

  // Written by itself, once it has.
  await expect.poll(updates, { timeout: 10_000 }).toHaveLength(1);
  expect(updates()[0].params).toMatchObject({
    id: VETTED_PRESET_ID,
    definition: "title:blues",
  });
  await expect(page.getByLabel("Preset definition")).toBeVisible();
});

test("a query runs with a new preset before it's saved, and saves it on request", async ({
  page,
}) => {
  const calls = await mockRpc(page, []);
  const runs: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/query")) {
      runs.push(request.postData() ?? "");
    }
  });
  await openQuery(page, RUNNABLE);
  await expect.poll(() => runs.length).toBeGreaterThan(0);

  await openOptions(page, "Filter");
  await page.getByRole("menuitem", { name: "Add new" }).click();
  await expect(page.getByLabel("Preset name")).toBeFocused();
  await expect(page.getByLabel("Unsaved changes")).toBeVisible();

  const before = runs.length;
  await page.getByLabel("Preset definition").fill("title:blues");
  await expect.poll(() => runs.slice(before).join()).toContain("blues");
  const methods = () => calls.map((c) => c.method);
  expect(methods()).not.toContain("preset.add");

  const create = page.getByRole("button", { name: "Create preset" });
  await expect(create).toBeDisabled();
  await page.getByLabel("Preset name").fill("the blues");
  await create.click();
  await expect.poll(methods).toContain("preset.add");
  expect(calls.find((c) => c.method === "preset.add")?.params).toMatchObject({
    name: "the blues",
    definition: "title:blues",
    baseTable: "track",
    section: "filter",
  });
  // Saved, and still open.
  await expect(page.getByLabel("Unsaved changes")).toHaveCount(0);
  await expect(page.getByLabel("Preset definition")).toBeVisible();
});

test("switching a sort from a preset to custom leaves the custom sort empty", async ({
  page,
}) => {
  await mockRpc(page, [
    { ...TITLE_PRESET, section: "sort", definition: "\\\\title" },
  ]);
  await openQuery(page, { ...RUNNABLE, sort: { preset: VETTED_PRESET_ID } });
  await page.getByRole("button", { name: "Sort", exact: true }).click();
  await openOptions(page, "Sort");
  await page.getByRole("menuitemradio", { name: "Custom sort" }).click();
  await expect
    .poll(async () => (await liveDefinition(page))?.sort)
    .toEqual({ custom: "" });
});

test("Manage presets opens the manager at the query's table", async ({
  page,
}) => {
  await mockRpc(page);
  await openQuery(page, RUNNABLE);
  await openOptions(page, "Filter");
  await page.getByRole("menuitem", { name: "Manage presets" }).click();
  const manager = page.getByTestId("preset-manager");
  await expect(
    manager.getByRole("button", { name: /^track \d/ }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    manager.getByRole("heading").getByRole("button", { expanded: true }),
  ).toHaveCount(1);
});
