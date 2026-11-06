import { test, expect } from "@playwright/test";
import { SCHEMES, snapshot } from "./harness";

// The whole kitchen sink, one theme at a time (`?theme=` is the page on its
// own, not the side-by-side frame). It's the one full-page snapshot besides
// the app's own: the page is a catalogue of every colored element, so a
// palette change anywhere shows up here. The mockup page is deliberately not
// snapshotted.

for (const colorScheme of SCHEMES) {
  test(`kitchen-sink - ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/kitchen-sink.html?theme=${colorScheme}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(snapshot("kitchen-sink", colorScheme), {
      fullPage: true,
    });
  });
}
