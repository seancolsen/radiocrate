import js from "@eslint/js";
import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid/configs/typescript";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // `vendor/` holds the wasm-pack-generated querydown-js binding (a build
  // artifact, gitignored) — never lint it.
  { ignores: ["dist/", "dev-dist/", "node_modules/", "vendor/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    ...solid,
    languageOptions: { parser: tseslint.parser },
  },
  prettier, // must come last — turns off formatting-related rules
);
