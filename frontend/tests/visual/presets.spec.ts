import { test, expect, type Page } from "@playwright/test";
import { PRESETS_FIXTURE, SOURCES_FIXTURE } from "../../src/dev/fixtures";

// The preset manager in the assembled app: reached from the Settings menu, and
// creating, renaming and deleting a preset all the way to the RPC.

/** An RPC call the app made: its method and params. */
interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** Answers the RPC route from the fixtures, recording every call. */
async function mockRpc(page: Page): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as Call & { id: number };
    calls.push({ method: body.method, params: body.params });
    const result =
      body.method === "source.list"
        ? SOURCES_FIXTURE
        : body.method === "preset.list"
          ? PRESETS_FIXTURE
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

  // Rename, in its editor.
  await manager.getByLabel("Preset name").fill("by decade");
  await manager.getByRole("button", { name: "Save preset" }).click();
  await expect(
    manager.getByRole("button", { name: /^by decade/ }),
  ).toBeVisible();
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
