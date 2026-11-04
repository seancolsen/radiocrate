import { test, expect, type Page } from "@playwright/test";
import {
  FILTER_DEF,
  PRESETS_FIXTURE,
  SOURCES_FIXTURE,
} from "../../src/dev/fixtures";

// The Querydown editors checking what's typed into them, end to end: the real
// compiler (WASM, in the page) against the canned schema `?recordFixture=1`
// installs. What the problems look like is `query.spec.ts`'s and
// `shell.spec.ts`'s business; this is about when they come and go.

/** Fulfill the RPC route from fixtures (no backend), with `/api/query`
 * stubbed empty, as `toolbar.spec.ts` does. */
async function mockRpc(page: Page) {
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result =
      body.method === "source.list"
        ? SOURCES_FIXTURE
        : body.method === "preset.list"
          ? PRESETS_FIXTURE
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

const def = (d: unknown) => encodeURIComponent(JSON.stringify(d));

test("a problem typed into the filter shows once the typing pauses, underlined, and goes when it's fixed", async ({
  page,
}) => {
  await mockRpc(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    `/?tabs=Lemonade&clean=1&count=12&recordFixture=1&section=filter&def=${def(FILTER_DEF)}`,
  );
  const filter = page.getByPlaceholder("Filter");
  const strip = page.getByTestId("query-diagnostic");

  await filter.fill("jazz year:");
  await expect(strip).toContainText("Unexpected end of input");
  await expect(strip).toContainText("Filter · line 1, column 11");
  await expect(filter).toHaveAttribute("aria-invalid", "true");
  // The end of the input, where a value was wanted, is marked in the editor.
  await expect(filter.locator(".cm-qd-problem-point")).toHaveCount(1);

  // Fixed, it's gone at once — no waiting on a pause.
  await filter.press("End");
  await page.keyboard.type("2");
  await expect(
    strip.filter({ hasText: "Unexpected end of input" }),
  ).toHaveCount(0, { timeout: 200 });
  await expect(filter).toHaveAttribute("aria-invalid", "false");
  await expect(filter.locator(".cm-qd-problem-point")).toHaveCount(0);
});

test("a prelude that doesn't parse can't be saved", async ({ page }) => {
  await mockRpc(page);
  await page.goto("/?sidebar=open&recordFixture=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Querydown Prelude" }).click();
  const prelude = page.getByTestId("prelude-page");
  const field = prelude.getByLabel("Querydown Prelude");
  const save = prelude.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();

  await field.press("ControlOrMeta+End");
  await page.keyboard.type("\n#track.x = (");
  await expect(save).toBeDisabled();
  await expect(prelude.getByTestId("prelude-unsaved")).toBeVisible();
  await expect(prelude.getByRole("alert")).toContainText("Unclosed (");
  await expect(field.locator(".cm-qd-problem")).toHaveText("(");

  await page.keyboard.type("1)");
  await expect(save).toBeEnabled();
  await expect(prelude.getByRole("alert")).toHaveCount(0);

  await save.click();
  await expect(save).toBeDisabled();
  await expect(prelude.getByTestId("prelude-unsaved")).toHaveCount(0);
});

test("a new preset's definition is checked as it's written", async ({
  page,
}) => {
  await mockRpc(page);
  await page.goto("/?sidebar=open&recordFixture=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Query presets" }).click();
  const manager = page.getByTestId("preset-manager");
  await manager.getByRole("button", { name: /^track \d/ }).click();
  await manager
    .getByRole("button", { name: "New sorting preset for track" })
    .click();

  const definition = manager.getByLabel("Preset definition");
  await definition.fill("\\\\title $");
  await expect(manager.getByRole("alert")).toContainText("Unexpected $");
  await expect(definition.locator(".cm-qd-problem")).toHaveText("$");

  await definition.fill("\\\\title");
  await expect(manager.getByRole("alert")).toHaveCount(0);
});
