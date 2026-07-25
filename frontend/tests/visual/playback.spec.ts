import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "./fixtures";
import type { AppStore } from "../../src/state/store";

/** The store the app exposes under `?expose=1` (the same seam reload.spec uses). */
interface AppWindow {
  __appStore: AppStore;
}

// Behavioral (not screenshot) coverage of the play path: double-clicking a
// result row streams that row's track, and the audio element's own `ended` event
// advances to the next row's track. That second part is what keeps a
// backgrounded PWA playing — the queue lives in the audio layer, so the
// transition needs no repaint, no effect, and no visible app.

/** A decodable WAV of pure silence — long enough that nothing ends on its own
 * mid-test, so every transition under test is one the code made. */
function silentWav(seconds = 30): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds * 2); // 16-bit mono zeros
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Fulfill the RPC route from fixtures, and the audio stream with silence, so
 * nothing reaches a backend. Records which track ids were requested. */
async function mockBackend(page: Page): Promise<string[]> {
  const streamed: string[] = [];
  await page.route("**/api/rpc", async (route) => {
    const body = route.request().postDataJSON() as {
      method: string;
      id: number;
    };
    const result = body.method === "query.list" ? QUERIES_FIXTURE : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
    });
  });
  await page.route("**/api/query", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
  await page.route("**/api/tracks/*/stream", (route) => {
    const id = /tracks\/([^/]+)\/stream/.exec(route.request().url())?.[1];
    if (id) streamed.push(id);
    void route.fulfill({ contentType: "audio/wav", body: silentWav() });
  });
  return streamed;
}

/** The `src` of the app's (single, hidden) audio element. */
async function audioSrc(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector("audio")?.getAttribute("src") ?? "",
  );
}

test("double-click plays a row's track, and `ended` advances to the next", async ({
  page,
}) => {
  const streamed = await mockBackend(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    "/?tabs=Lemonade&grid=lemonade&tracks=track-a,track-b,track-c",
  );
  await expect(page.locator("canvas[data-rows]")).toBeVisible();

  // Double-click the first row (rows start at the top of the canvas).
  await page.locator("canvas").dblclick({ position: { x: 200, y: 10 } });

  // The bar appears and the first row's track is being streamed.
  await expect(page.getByTestId("now-playing")).toBeVisible();
  await expect.poll(() => audioSrc(page)).toContain("track-a");

  // The track ends: the audio layer advances on its own, with no UI involvement.
  await page.evaluate(() =>
    document.querySelector("audio")?.dispatchEvent(new Event("ended")),
  );
  await expect.poll(() => audioSrc(page)).toContain("track-b");

  // And again, to the last queued row.
  await page.evaluate(() =>
    document.querySelector("audio")?.dispatchEvent(new Event("ended")),
  );
  await expect.poll(() => audioSrc(page)).toContain("track-c");
  expect(streamed).toEqual(["track-a", "track-b", "track-c"]);

  // The queue is now dry: ending the last track clears the bar.
  await page.evaluate(() =>
    document.querySelector("audio")?.dispatchEvent(new Event("ended")),
  );
  await expect(page.getByTestId("now-playing")).toBeHidden();
});

// The playing row's accent marker is canvas paint, asserted against the canvas
// pixels rather than a screenshot: `toHaveScreenshot` reproduces late canvas
// content in dark mode but not light (the marker is verifiably in the backing
// store either way — `page.screenshot` shows it in both).
for (const colorScheme of ["light", "dark"] as const) {
  test(`the playing row carries an accent marker - ${colorScheme}`, async ({
    page,
  }) => {
    await mockBackend(page);
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?tabs=Lemonade&grid=lemonade&tracks=track-a,track-b");
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await page.locator("canvas").dblclick({ position: { x: 200, y: 10 } });
    await expect(page.getByTestId("now-playing")).toBeVisible();

    // Sample the marker band on row 0 (`x` 0…4, the 5px width), just past it,
    // and the same column three rows down — against the theme's own accent.
    const read = () =>
      page.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const dpr = window.devicePixelRatio || 1;
        const ctx = canvas.getContext("2d")!;
        const at = (x: number, y: number) => {
          const d = ctx.getImageData(x * dpr, y * dpr, 1, 1).data;
          return `${d[0]},${d[1]},${d[2]}`;
        };
        // Resolve `--accent-soft` to rgb through a throwaway canvas, so the
        // expectation tracks the theme rather than a hard-coded hex.
        const probe = document.createElement("canvas").getContext("2d")!;
        probe.fillStyle = getComputedStyle(document.documentElement)
          .getPropertyValue("--accent-soft")
          .trim();
        probe.fillRect(0, 0, 1, 1);
        const a = probe.getImageData(0, 0, 1, 1).data;
        return {
          accent: `${a[0]},${a[1]},${a[2]}`,
          markerNear: at(2, 20),
          markerFar: at(4, 20),
          pastMarker: at(6, 20),
          otherRow: at(2, 120),
        };
      });

    await expect
      .poll(async () => (await read()).markerNear)
      .toBe((await read()).accent);
    const px = await read();
    expect(px.markerFar).toBe(px.accent); // the full 5px band is painted
    expect(px.pastMarker).not.toBe(px.accent); // and it stops there
    expect(px.otherRow).not.toBe(px.accent); // only the playing row is marked
  });
}

test("the bar's Locate action returns to the playing track's row", async ({
  page,
}) => {
  await mockBackend(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(
    "/?tabs=Lemonade,Deep%20Cuts&grid=lemonade&tracks=track-a,track-b&expose=1",
  );
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
  await page.locator("canvas").dblclick({ position: { x: 200, y: 10 } });
  await expect(page.getByTestId("now-playing")).toBeVisible();
  const playingTab = await page.evaluate(
    () => (window as unknown as AppWindow).__appStore.state.activeTabId,
  );

  // Move to the other tab, then Locate.
  await page.locator("[data-tab-id]").nth(1).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as AppWindow).__appStore.state.activeTabId,
      ),
    )
    .not.toBe(playingTab);
  await page
    .getByTestId("now-playing")
    .getByRole("button", { name: "Playback actions" })
    .click();
  await page.getByRole("menuitem", { name: "Locate" }).click();

  // Back on the track's own tab, with its row selected.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as AppWindow).__appStore.state.activeTabId,
      ),
    )
    .toBe(playingTab);
  const selected = await page.evaluate(() => {
    const store = (window as unknown as AppWindow).__appStore;
    return [...store.rowSelection(store.state.activeTabId!)];
  });
  expect(selected).toEqual([0]);
});

test("the bar's Close action dismisses playback", async ({ page }) => {
  await mockBackend(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?tabs=Lemonade&grid=lemonade&tracks=track-a,track-b");
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
  await page.locator("canvas").dblclick({ position: { x: 200, y: 10 } });
  await expect(page.getByTestId("now-playing")).toBeVisible();

  await page
    .getByTestId("now-playing")
    .getByRole("button", { name: "Playback actions" })
    .click();
  await page.getByRole("menuitem", { name: "Close" }).click();
  await expect(page.getByTestId("now-playing")).toBeHidden();
});
