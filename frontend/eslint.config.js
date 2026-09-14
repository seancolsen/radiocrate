import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

/** Framework-free modules: the domain logic the app is built on (see
 * `specs/2026-09-react-migration/plan.md`). They stay free of React so they
 * remain portable and testable in plain vitest. */
const FRAMEWORK_FREE = [
  "src/api/**",
  "src/audio/**",
  "src/commands/**",
  "src/grid/**",
  "src/query/**",
  "src/record/**",
  "src/state/**",
  "src/dev/{fixtures,gridFixture,recordFixture}.ts",
  "src/dev/harness/mockApi.ts",
];

const REACT = ["react", "react/*", "react-dom", "react-dom/*"];

const STORES_REACT_MESSAGE =
  "Stores never import React; bindings live in stores/react.tsx.";

export default tseslint.config(
  // `vendor/` holds the wasm-pack-generated querydown-js binding (a build
  // artifact, gitignored) — never lint it.
  { ignores: ["dist/", "dev-dist/", "node_modules/", "vendor/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ...reactHooks.configs.flat.recommended,
    files: ["src/**/*.{ts,tsx}"],
  },
  {
    files: FRAMEWORK_FREE,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: REACT,
              message: "Framework-free modules never import React.",
            },
          ],
        },
      ],
    },
  },
  {
    // Stores are plain vanilla Zustand, so code outside React (the audio
    // engine, the keydown pass, Playwright) can use them and plain vitest can
    // test them. `react.tsx` is the one binding file.
    //
    // The zustand entry points are listed under `paths` (exact match) rather
    // than folded into the `patterns` group below: a bare name in a `group`
    // glob matches gitignore-style, so it would also catch every subpath
    // (`zustand/vanilla`, `zustand/middleware`, …) — exactly the entry points
    // stores are supposed to use.
    files: ["src/app/stores/**"],
    ignores: ["src/app/stores/react.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "zustand", message: STORES_REACT_MESSAGE },
            { name: "zustand/react", message: STORES_REACT_MESSAGE },
            { name: "zustand/shallow", message: STORES_REACT_MESSAGE },
            { name: "zustand/traditional", message: STORES_REACT_MESSAGE },
          ],
          patterns: [
            {
              group: [...REACT, "zustand/react/*"],
              message: STORES_REACT_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  prettier, // must come last — turns off formatting-related rules
);
