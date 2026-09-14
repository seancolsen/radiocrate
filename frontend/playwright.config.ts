import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "bun run dev -- --port 4173",
    url: "http://localhost:4173",
    reuseExistingServer: true,
  },
});
