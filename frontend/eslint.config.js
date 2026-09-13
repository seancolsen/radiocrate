import js from "@eslint/js";
import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid/configs/typescript";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

// Until the cutover, the React port (`src/app/`) is built alongside the Solid
// app and shares its framework-free modules in place (see
// `specs/2026-09-react-migration/plan.md`). Each framework's rules apply to its
// own tree only.
const REACT_TREE = "src/app/**";

/** Framework-free modules both trees import. They must stay that way, or the
 * cutover's deletion of the Solid tree would take part of the React app with
 * it. */
const SHARED = [
  "src/api/**",
  "src/audio/**",
  "src/commands/**",
  "src/grid/**",
  "src/query/**",
  "src/record/**",
  "src/state/{settings,updatePolicy}{,.test}.ts",
  "src/dev/{fixtures,gridFixture,recordFixture}.ts",
  "src/dev/harness/mockApi.ts",
];

const FRAMEWORKS = ["solid-js", "solid-js/*", "react", "react/*", "react-dom"];

export default tseslint.config(
  // `vendor/` holds the wasm-pack-generated querydown-js binding (a build
  // artifact, gitignored) — never lint it.
  { ignores: ["dist/", "dev-dist/", "node_modules/", "vendor/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ...solid,
    files: ["**/*.{ts,tsx}"],
    ignores: [REACT_TREE],
    languageOptions: { parser: tseslint.parser },
  },
  {
    ...reactHooks.configs.flat.recommended,
    files: [`${REACT_TREE}/*.{ts,tsx}`],
  },
  {
    files: SHARED,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...FRAMEWORKS, "react-dom/*"],
              message: "Shared modules stay framework-free.",
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
    files: ["src/app/stores/**"],
    ignores: ["src/app/stores/react.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                ...FRAMEWORKS,
                "react-dom/*",
                "zustand",
                "zustand/react",
                "zustand/react/*",
                "zustand/shallow",
                "zustand/traditional",
              ],
              message:
                "Stores never import React; bindings live in stores/react.tsx.",
            },
          ],
        },
      ],
    },
  },
  prettier, // must come last — turns off formatting-related rules
);
