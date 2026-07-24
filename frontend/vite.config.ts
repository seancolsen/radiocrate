import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import devtools from "solid-devtools/vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import Icons from "unplugin-icons/vite";

export default defineConfig({
  plugins: [
    // Must come before `solid()`. `autoname` labels components in the
    // Solid DevTools browser extension. This plugin is a dev-only no-op in
    // production builds.
    devtools({ autoname: true }),
    solid(),
    tailwindcss(), // Tailwind v4 — no PostCSS/config file needed
    // Build-time icon inlining: each `~icons/*` import becomes a Solid SVG
    // component filled with `currentColor`. No runtime font fetch (CSP/offline safe).
    Icons({ compiler: "solid" }),
    VitePWA({
      strategies: "generateSW",
      registerType: "prompt", // mirror old SW: wait, don't auto-activate
      manifest: false, // keep the hand-tuned static manifest (public/)
      workbox: {
        navigateFallback: "/index.html",
        // Never let the SW answer API calls — mirror the egui SW's /api passthrough.
        navigateFallbackDenylist: [/^\/api\//],
        // The polyglot-sql WASM is ~22 MB and only needed for double-click track
        // detection, so keep it out of the install-time precache (which would make
        // every user download it up front). It's cached on first use by the
        // runtime rule below instead — the small querydown WASM stays precached.
        globIgnores: ["**/polyglot_sql-*.wasm"],
        runtimeCaching: [
          { urlPattern: /^\/api\//, handler: "NetworkOnly" },
          {
            urlPattern: /\/assets\/polyglot_sql-.*\.wasm$/,
            handler: "CacheFirst",
            options: {
              cacheName: "polyglot-wasm",
              expiration: { maxEntries: 2 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  // The generated API client is a sibling directory (raw TS, no build step),
  // consumed through this alias. Regenerate it with `cargo xtask gen-api`.
  resolve: {
    alias: {
      "api-client": fileURLToPath(
        new URL("../api-client/src/index.ts", import.meta.url),
      ),
    },
  },
  // The polyglot-sql SDK is a WASM module that loads its own `.wasm` via
  // `new URL("…", import.meta.url)` and top-level await. Excluding it from
  // esbuild's dep pre-bundle keeps that self-locating asset URL intact (a
  // pre-bundled copy would relocate the module and break the wasm fetch); Vite's
  // own asset pipeline then emits and serves the `.wasm` correctly.
  optimizeDeps: { exclude: ["@polyglot-sql/sdk"] },
  build: { outDir: "dist", target: "esnext" },
  // In dev, Vite serves the app on its own port while the backend API runs on
  // :3000. Proxy /api so client code stays origin-relative in every environment.
  server: { proxy: { "/api": "http://localhost:3000" } },
});
