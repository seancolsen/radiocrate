import { defineConfig } from "vitest/config";

// Unit tests only (pure-logic ports). Scoped to `src/**/*.test.ts` so Vitest
// never picks up the Playwright specs under `tests/visual/`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
