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
  await expect(manager.getByRole("button", { name: /^vetted/ })).toBeVisible();

  // Create: a sort for `track`, from its section heading's "+".
  await manager
    .getByRole("button", { name: "New sorting preset for track" })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Preset name").fill("by year");
  await dialog.getByLabel("Preset definition").fill("\\\\year");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
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

  // Rename, from the row's menu.
  await manager.getByRole("button", { name: "Actions for by year" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await manager.getByLabel("Rename preset").fill("by decade");
  await manager.getByLabel("Rename preset").press("Enter");
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
