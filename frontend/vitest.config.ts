import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests only (pure-logic ports). Scoped to `src/**/*.test.ts` so Vitest
// never picks up the Playwright specs under `tests/visual/`.
export default defineConfig({
  // Mirrors the app's `api-client` alias (vite.config.ts). Without it any module
  // that transitively imports the generated client fails to resolve here, even
  // when the test itself never calls it.
  resolve: {
    alias: {
      "api-client": fileURLToPath(
        new URL("../api-client/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
