import { test, expect } from "@playwright/test";
import { QUERIES_FIXTURE, PRESETS_FIXTURE } from "../../src/dev/fixtures";

// "Re-scan collection" is the one Settings row that outlives its own click: a
// scan takes as long as the collection is big, so the menu stays up with the
// row disabled and spinning, and dismisses itself only once the call comes
// back. Both halves need a call held open mid-flight, which is what the route
// below is for — so this is a behavioral test against the assembled app rather
// than a harness snapshot (the pending row's pixels are `settings/menu-
// rescanning`).

test("the settings menu waits out a re-scan, then closes itself", async ({
  page,
}) => {
  let releaseRescan!: () => void;
  const rescanHeld = new Promise<void>((resolve) => {
    releaseRescan = resolve;
  });
  let rescans = 0;

  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    if (body.method === "collection.rescan") {
      rescans += 1;
      await rescanHeld;
    }
    const result =
      body.method === "query.list"
        ? QUERIES_FIXTURE
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

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?sidebar=open");
  await page.getByRole("button", { name: "Settings" }).click();

  const row = page.getByRole("menuitem", { name: "Re-scan collection" });
  await row.click();

  // The click neither dismissed the menu nor left the row clickable again.
  await expect(row).toBeDisabled();
  await row.click({ force: true, noWaitAfter: true });
  expect(rescans).toBe(1);

  releaseRescan();
  await expect(row).toBeHidden();
});
