import type { Browser, Page } from "@playwright/test";
import { test as base, expect, look, type AllowedError } from "./fixtures";
import { App, rpcAnswered } from "./support/app";
import { E2E_NOW } from "./support/paths";
import type { Server } from "./support/server";
import { abortedByUnload } from "./support/unload";

// Live updates across devices (`specs/2026-11-live-updates/spec.md`, phase 5):
// two browser contexts on one server, standing for two devices. What one of
// them writes reaches the other through the real change stream
// (`GET /api/events`) and the refetch that follows, with no Refresh — except
// for query results, which stay as they are, marked out of date, until the
// user asks (§4.4).
//
// The test's own `app` / `page` are device A, where the change is made; `other`
// is device B, which follows it.

/** A second device: its own browser context on the test's server, with the
 * same options as the suite's (`playwright.e2e.config.ts`), its clock frozen
 * at the same instant, and the app loaded on it. */
interface Device {
  page: Page;
  app: App;
}

/** The second device's guards fail the test on what the `page` fixture's fail
 * it on: a page error, a `console.error`, a 5xx from `/api/`. The server's
 * panic guard already covers both devices. */
async function openDevice(
  browser: Browser,
  server: Server,
  allowedErrors: readonly AllowedError[],
): Promise<{ device: Device; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({
    baseURL: server.baseURL,
    serviceWorkers: "block",
    timezoneId: "UTC",
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(E2E_NOW);

  const errors: string[] = [];
  const allowed = (text: string) =>
    allowedErrors.some((a) =>
      typeof a === "string" ? text.includes(a) : a.test(text),
    );
  const report = (text: string) => {
    if (abortedByUnload(page, text) || allowed(text)) return;
    errors.push(`device B: ${text}`);
  };
  page.on("pageerror", (error) => report(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") report(`console.error: ${message.text()}`);
  });
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() < 500 || !new URL(url).pathname.startsWith("/api/"))
      return;
    report(`${response.status()} from ${url}`);
  });

  const app = new App(page);
  await app.load();
  return { device: { page, app }, errors, close: () => context.close() };
}

// Written as a fixture so that it can move into `fixtures.ts` as it is, once a
// second spec wants a second device.
const test = base.extend<{ other: Device }>({
  other: async ({ browser, server, allowedErrors }, use, testInfo) => {
    const { device, errors, close } = await openDevice(
      browser,
      server,
      allowedErrors,
    );
    try {
      await use(device);
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      if (failed) {
        await testInfo.attach("device-b.png", {
          body: await device.page.screenshot().catch(() => Buffer.alloc(0)),
          contentType: "image/png",
        });
      }
      await close();
    }
    if (errors.length > 0 && testInfo.status === testInfo.expectedStatus) {
      throw new Error(
        `Unexpected errors during the test:\n${errors.join("\n")}`,
      );
    }
  },
});

/** A page's toolbar: the active tab's (other tabs' pages stay mounted,
 * hidden). */
function toolbar(page: Page) {
  return page.getByTestId("query-toolbar").filter({ visible: true });
}

/** The ten most played tracks, as in `query.spec.ts`. */
const MOST_PLAYED = "play_count:>=80";

test("a query renamed on one device is renamed on the other, in its explorer and its open tab", async ({
  app,
  page,
  other,
}) => {
  await test.step("B has Albums open", async () => {
    await other.app.openSource("Albums");
    await other.app.openExplorer();
    await expect(
      other.page.getByRole("button", { name: "Close Albums" }),
    ).toBeVisible();
    await look(other.page, "b-albums-open");
  });

  await test.step("A renames Albums from its explorer", async () => {
    await app.openExplorer();
    await app.source("Albums").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const field = page.getByRole("textbox", { name: "Query name" });
    await expect(field).toBeFocused();
    const renamed = rpcAnswered(page, "source.rename");
    await field.fill("Records");
    await field.press("Enter");
    expect((await renamed).ok()).toBe(true);
    await expect(app.source("Records")).toBeVisible();
    await look(page, "a-renamed");
  });

  await test.step("B's explorer and B's tab follow, with no Refresh", async () => {
    await expect(other.app.sources).toMatchAriaSnapshot(`
      - tree "Sources":
        - treeitem "Tracks" [level=1]
        - treeitem "Records" [level=1]
        - treeitem "Artists" [level=1]
    `);
    await expect(
      other.page.getByRole("button", { name: "Close Records" }),
    ).toBeVisible();
    await look(other.page, "b-followed");
  });
});

test("a query edited on one device marks the other's open page out of date, and only Refresh re-runs it", async ({
  app,
  page,
  other,
}) => {
  // A's edit autosaves after 5 s of quiet.
  test.setTimeout(60_000);

  await test.step("both devices have Tracks open, all 63 rows", async () => {
    await other.app.openSource("Tracks");
    await expect(toolbar(other.page).getByText("63 tracks")).toBeVisible();
    await other.app.grid.recordsKnown();
    await other.app.settled();
    await app.openSource("Tracks");
    await expect(toolbar(page).getByText("63 tracks")).toBeVisible();
  });

  // From here on, any query B sends is a re-run the change caused.
  const queries: string[] = [];
  other.page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/query")
      queries.push(request.postData() ?? "");
  });

  await test.step("A filters it to the most played, and it autosaves", async () => {
    const saved = rpcAnswered(page, "source.update_definition", 20_000);
    await toolbar(page)
      .getByRole("button", { name: "Filter", exact: true })
      .click();
    await page
      .getByPlaceholder("Filter")
      .filter({ visible: true })
      .fill(MOST_PLAYED);
    await expect(toolbar(page).getByText("10 tracks")).toBeVisible();
    expect((await saved).ok()).toBe(true);
    await look(page, "a-filtered");
  });

  const refresh = toolbar(other.page).getByRole("button", { name: "Refresh" });

  await test.step("B's Refresh carries the dot, and its rows stay as they were", async () => {
    await expect
      .poll(() =>
        other.page.evaluate(() => {
          const s = window.__appStore;
          return s.state.pages[s.activeTabId()!]?.changedElsewhere;
        }),
      )
      .toBe(true);
    await refresh.hover();
    await expect(other.page.getByRole("tooltip")).toContainText(
      "Changed on another device",
    );
    await look(other.page, "b-out-of-date");
    await expect(toolbar(other.page).getByText("63 tracks")).toBeVisible();
    expect(await other.app.grid.rowCount()).toBe(63);
    expect(queries).toEqual([]);
  });

  await test.step("B's page holds A's definition, still unrun", async () => {
    await toolbar(other.page)
      .getByRole("button", { name: "Filter", exact: true })
      .click();
    await expect(
      other.page.getByPlaceholder("Filter").filter({ visible: true }),
    ).toHaveText(MOST_PLAYED);
    expect(await other.app.grid.rowCount()).toBe(63);
    expect(queries).toEqual([]);
  });

  await test.step("Refresh on B runs it: A's rows, and no dot", async () => {
    await refresh.click();
    await expect(toolbar(other.page).getByText("10 tracks")).toBeVisible();
    await expect.poll(() => other.app.grid.rowCount()).toBe(10);
    expect(queries).toHaveLength(1);
    expect(
      await other.page.evaluate(() => {
        const s = window.__appStore;
        return s.state.pages[s.activeTabId()!]?.changedElsewhere ?? false;
      }),
    ).toBe(false);
    expect(await other.app.grid.text()).toMatchSnapshot("most-played.txt");
    await look(other.page, "b-refreshed");
  });
});

test("a shortcut rebound on one device works on the other", async ({
  app,
  page,
  other,
}) => {
  const toggle = (device: Page) =>
    device.getByRole("button", { name: /^(Close|Open) explorer$/ });

  await test.step("B's explorer toggle names the default chord", async () => {
    // The toggle is in the tab bar, which shows once a tab is open.
    await other.app.openSource("Tracks");
    await other.app.openExplorer();
    await expect(toggle(other.page)).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+B",
    );
  });

  await test.step("A rebinds “Toggle explorer sidebar” in its shortcuts editor", async () => {
    await app.openExplorer();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
    const row = page.getByRole("button", {
      name: /Explorer: Toggle explorer sidebar/,
    });
    await expect(row).toContainText("Ctrl+B");
    await row.click();
    await expect(
      page.getByRole("heading", { name: "Set keyboard shortcut" }),
    ).toBeVisible();
    await page.keyboard.press("Control+Alt+J");
    const set = rpcAnswered(page, "keybinding.set");
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    expect((await set).ok()).toBe(true);
    await expect(row).toContainText("Ctrl+Alt+J");
    await look(page, "a-rebound");
  });

  await test.step("B's toggle names the new chord, and the chord works there", async () => {
    await expect(toggle(other.page)).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Alt+J",
    );
    await expect(other.app.explorer).toBeVisible();
    await other.page.keyboard.press("Control+b");
    await expect(other.app.explorer).toBeVisible();
    await other.page.keyboard.press("Control+Alt+J");
    await expect(other.app.explorer).toBeHidden();
    await look(other.page, "b-explorer-closed");
  });
});
