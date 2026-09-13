import { defineConfig } from "@playwright/test";

/** The pages a project drives: the component harness `openStory` opens, and
 * the assembled app the behavioral specs open (`appUrl`, `tests/visual/harness.ts`). */
export interface Entries {
  harness: string;
  app: string;
}

export default defineConfig({
  testDir: "./tests/visual",
  // Shared by both projects: the React port is held to the Solid app's
  // baselines, byte for byte.
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "bun run dev -- --port 4173",
    url: "http://localhost:4173",
    reuseExistingServer: true,
  },
  // Until the cutover the same specs run against both apps. The React project
  // only passes for what has been ported so far, so run it with `--grep`
  // scoped to the ported stories and specs (see the plan's Definition of done).
  projects: [
    {
      name: "solid",
      metadata: { harness: "/harness.html", app: "/" } satisfies Entries,
    },
    {
      name: "react",
      metadata: {
        harness: "/react-harness.html",
        app: "/react.html",
      } satisfies Entries,
    },
  ],
});
