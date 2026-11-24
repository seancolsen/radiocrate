import { defineConfig } from "@playwright/test";

// The end-to-end suite: the production frontend build, served by a debug
// `radiocrate` binary on a fresh copy of a pinned sample library, one server
// per test. See `specs/2026-11-e2e-tests/spec.md`, and `CLAUDE.md` ("Writing
// E2E tests").
//
// Its own config rather than a project in `playwright.config.ts`: the two
// suites share no server, no snapshot layout and no defaults.

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results/e2e",
  globalSetup: "./tests/e2e/support/globalSetup.ts",
  // Pixel baselines under __screenshots__/<spec>/, text ones under
  // __snapshots__/<spec>/. The name passed to the matcher is the state.
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      pathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
    },
    toMatchAriaSnapshot: {
      pathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}",
    },
  },
  fullyParallel: true,
  // Each worker holds a DuckDB instance and a Chromium.
  workers: 4,
  // A flake here is a bug to find, as with the visual snapshots.
  retries: 0,
  reporter: [["list"]],
  use: {
    // A production build registers a service worker, and its precache would
    // outlive the server it came from.
    serviceWorkers: "block",
    timezoneId: "UTC",
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
