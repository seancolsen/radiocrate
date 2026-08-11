import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests only (pure-logic ports). Scoped to `src/**/*.test.ts` so Vitest
// never picks up the Playwright specs under `tests/visual/`.
export default defineConfig({
  // Mirrors the app's `api-client` alias (vite.config.ts). Without it any module
  // that transitively imports the generated client fails to resolve here, even
  // when the test itself never calls it.
  //
  // The vendored `querydown-js` needs one too: its wasm-pack package.json
  // declares only `module`, which the browser build resolves and Vitest's Node
  // resolution doesn't — so a module that merely *imports* the compiler (nothing
  // here instantiates the WASM) fails to load without it.
  resolve: {
    alias: {
      "api-client": fileURLToPath(
        new URL("../api-client/src/index.ts", import.meta.url),
      ),
      "querydown-js": fileURLToPath(
        new URL("./vendor/querydown-js/querydown_js.js", import.meta.url),
      ),
    },
  },
  // The app's build id (vite.config.ts) is derived from git and changes between
  // builds, so tests get a fixed stand-in instead — a module that reads it stays
  // importable here, and nothing asserts against a moving value.
  define: { __BUILD_ID__: JSON.stringify("test") },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
