import { test, expect, type Page } from "@playwright/test";
import { QUERIES_FIXTURE } from "../../src/dev/fixtures";
import type { AppStoreFacade } from "../../src/dev/seed";

/** The store the app exposes under `?expose=1` (the same seam reload.spec uses). */
interface AppWindow {
  __appStore: AppStoreFacade;
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
  // The stream answers Range requests, as the server's `ServeFile` does: without
  // them the browser reports nothing seekable and ignores every seek.
  await page.route("**/api/tracks/*/stream", (route) => {
    const id = /tracks\/([^/]+)\/stream/.exec(route.request().url())?.[1];
    if (id) streamed.push(id);
    const body = silentWav();
    const range = /bytes=(\d+)-(\d*)/.exec(
      route.request().headers()["range"] ?? "",
    );
    if (!range) {
      void route.fulfill({
        contentType: "audio/wav",
        headers: { "Accept-Ranges": "bytes" },
        body,
      });
      return;
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : body.length - 1;
    void route.fulfill({
      status: 206,
      contentType: "audio/wav",
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
      },
      body: body.subarray(start, end + 1),
    });
  });
  return streamed;
}

// The engine keeps two hidden audio elements — the active player and a standby
// pre-buffering the next track — and swaps their roles at every boundary, so
// "the" audio element is whichever one is currently playing.

/** The `src` of the active (playing) audio element, or "" when none plays. */
async function audioSrc(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = [...document.querySelectorAll("audio")].filter(
      (el) => !el.paused,
    );
    return active.length === 1 ? (active[0].getAttribute("src") ?? "") : "";
  });
}

/** Fires `ended` on the active audio element, as if its track ran out. */
async function endActiveTrack(page: Page): Promise<void> {
  await page.evaluate(() =>
    [...document.querySelectorAll("audio")]
      .find((el) => !el.paused)
      ?.dispatchEvent(new Event("ended")),
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
  // Once the first track has downloaded, the next is fetched while it still
  // plays, so the boundary needs no network.
  await expect.poll(() => streamed).toContain("track-b");

  // The track ends: the audio layer advances on its own, with no UI involvement.
  await endActiveTrack(page);
  await expect.poll(() => audioSrc(page)).toContain("track-b");

  // And again, to the last queued row.
  await endActiveTrack(page);
  await expect.poll(() => audioSrc(page)).toContain("track-c");
  expect([...new Set(streamed)]).toEqual(["track-a", "track-b", "track-c"]);

  // The queue is now dry: ending the last track clears the bar.
  await endActiveTrack(page);
  await expect(page.getByTestId("now-playing")).toBeHidden();
});

// The blue rectangle around the playing row is canvas paint, asserted against
// the canvas pixels rather than a screenshot: `toHaveScreenshot` reproduces late
// canvas content in dark mode but not light (the marker is verifiably in the
// backing store either way — `page.screenshot` shows it in both).
for (const colorScheme of ["light", "dark"] as const) {
  test(`the playing row is ringed in blue - ${colorScheme}`, async ({
    page,
  }) => {
    await mockBackend(page);
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?tabs=Lemonade&grid=lemonade&tracks=track-a,track-b");
    await expect(page.locator("canvas[data-rows]")).toBeVisible();
    await page.locator("canvas").dblclick({ position: { x: 200, y: 10 } });
    await expect(page.getByTestId("now-playing")).toBeVisible();

    // Sample row 0's ring — its left band (inset 2px, 2px wide, so `x` 2…3) and
    // its top band (`y` 2…3, read away from the rounded corners) — then the row
    // inside it, just past the band, and the same column three rows down.
    const read = () =>
      page.evaluate(() => {
        const canvas = document.querySelector("canvas")!;
        const dpr = window.devicePixelRatio || 1;
        const ctx = canvas.getContext("2d")!;
        const at = (x: number, y: number) => {
          const d = ctx.getImageData(x * dpr, y * dpr, 1, 1).data;
          return `${d[0]},${d[1]},${d[2]}`;
        };
        // Resolve `--now-playing` to rgb through a throwaway canvas, so the
        // expectation tracks the theme rather than a hard-coded hex.
        const probe = document.createElement("canvas").getContext("2d")!;
        probe.fillStyle = getComputedStyle(document.documentElement)
          .getPropertyValue("--now-playing")
          .trim();
        probe.fillRect(0, 0, 1, 1);
        const a = probe.getImageData(0, 0, 1, 1).data;
        return {
          accent: `${a[0]},${a[1]},${a[2]}`,
          leftBand: at(2, 20),
          leftBandFar: at(3, 20),
          topBand: at(200, 3),
          insideRing: at(6, 20),
          otherRow: at(2, 120),
        };
      });

    await expect
      .poll(async () => (await read()).leftBand)
      .toBe((await read()).accent);
    const px = await read();
    expect(px.leftBandFar).toBe(px.accent); // the full 2px band is painted
    expect(px.topBand).toBe(px.accent); // and the ring closes across the top
    expect(px.insideRing).not.toBe(px.accent); // the band stops there
    expect(px.otherRow).not.toBe(px.accent); // only the playing row is ringed
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

test("the bar's Next button skips to the next queued track", async ({
  page,
}) => {
  await mockBackend(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?tabs=Lemonade&grid=lemonade&tracks=track-a,track-b");
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
  await page.locator("canvas").dblclick({ position: { x: 200, y: 10 } });
  await expect.poll(() => audioSrc(page)).toContain("track-a");

  const next = page
    .getByTestId("now-playing")
    .getByRole("button", { name: "Next" });
  await next.click();
  await expect.poll(() => audioSrc(page)).toContain("track-b");
  // Nothing is queued after the last row.
  await expect(next).toBeDisabled();
});

test("clicking the timeline seeks the playing track", async ({ page }) => {
  await mockBackend(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?tabs=Lemonade&grid=lemonade&tracks=track-a,track-b");
  await expect(page.locator("canvas[data-rows]")).toBeVisible();
  await page.locator("canvas").dblclick({ position: { x: 200, y: 10 } });

  // The silent track is 30s; the slider is live once its duration is known.
  const slider = page.getByTestId("now-playing").getByRole("slider");
  await expect(slider).toHaveAttribute("aria-valuemax", "30");
  const box = (await slider.boundingBox())!;
  await slider.click({ position: { x: box.width * 0.5, y: box.height / 2 } });

  const currentTime = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll("audio")].find((el) => !el.paused)
          ?.currentTime ?? -1,
    );
  await expect.poll(currentTime).toBeGreaterThanOrEqual(14);
  expect(await currentTime()).toBeLessThan(20);
});
