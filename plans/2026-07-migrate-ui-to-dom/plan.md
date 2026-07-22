# Plan: Replace the egui frontend with a SolidJS DOM shell

## Purpose & context

RadioCrate's frontend is currently an **egui/eframe app compiled to WASM and
rendered to a canvas** (crate `frontend`, binary `radiocrate-ui`). It performs
beautifully but has show-stopper mobile usability issues. We are migrating to a
**web-native DOM frontend built with SolidJS**. We are pre-release with no
production deployments to protect, so we commit fully to the new stack on a git
branch (the egui code is retained as a reference in case we reverse course).

This first session does **not port any application logic**. It:

1. Moves the existing egui frontend to `frontend-old-egui/` (kept only as a
   read-only code reference) and makes the **Solid app the production
   frontend**: the `radiocrate` binary embeds the Solid build output and
   `cargo xtask build-release` builds it.
2. Scaffolds a fresh `frontend/` as a SolidJS SPA — a "hello world" shell that
   renders only the text **"RadioCrate"** centered in the viewport, but carries
   **all the PWA fixings** (manifest, icons, service worker, theming, safe-area
   insets) and a **whole-app visual snapshot test** that commits a PNG for both
   agent inspection and regression guarding.

The first QA milestone (performed by the user, not this session) is
`cargo xtask build-release` followed by running the binary and confirming it
serves the Solid shell.

### Agreed toolchain (decided in prior discussion — do not re-litigate)

| Concern | Choice |
|---|---|
| Framework | **SolidJS** (`solid-js`) |
| Package manager / runtime | **Bun** (no npm) |
| Bundler / dev server | **Vite** + `vite-plugin-solid`, client-only SPA |
| Types | **TypeScript 7** (native Go compiler; GA'd 2026-07-08) — type-check only |
| Lint | **ESLint** (flat config) + `typescript-eslint` + **`eslint-plugin-solid`** — the full Solid reactivity ruleset |
| Format | **Prettier** (+ `prettier-plugin-tailwindcss` for class sorting) |
| Styling | **Tailwind CSS v4** (via `@tailwindcss/vite`; CSS-first config) |
| PWA service worker | **`vite-plugin-pwa`** (Workbox), configured to mirror the existing SW's shell-only behavior |
| Visual snapshot test | **Playwright** (`@playwright/test`) full-page screenshots, light + dark |
| Component/unit tests (future) | Vitest + `@solidjs/testing-library` (config scaffolded, not exercised yet) |

Rationale lives in the chat that produced this plan; the short version: the new
frontend is plain TS/JSX, so it is a first-class citizen of the modern JS
toolchain (TS7 / Vite), whereas `.svelte` is not. We deliberately choose
**ESLint over Biome** despite ESLint's slower runtime and heavier config: the
full `eslint-plugin-solid` ruleset catches Solid's reactivity footguns (lost
reactivity from destructured props, uncalled signals, etc.) that Biome/oxlint
don't yet cover — and those are exactly the silent mistakes an agent trained
mostly on React makes, so the ruleset earns its keep under agentic coding. A
separate formatter (Prettier) fills the role Biome's integrated formatter would
have played.

---

## Key decisions baked into this plan

1. **The Solid app is the production frontend.** `radiocrate` embeds
   `frontend/dist` (the Vite output) and `cargo xtask build-release` builds the
   Solid app via Bun/Vite. The egui-specific trunk build and service-worker
   stamping are removed.
2. **`frontend-old-egui/` is a code reference only.** Nothing in the production
   build depends on it. It stays a buildable workspace member so it can still be
   run and inspected (`cargo run -p frontend-old-egui`, its snapshot tests).
3. **The old crate's package is renamed** `frontend` → `frontend-old-egui`, so
   `-p frontend-old-egui` addresses it everywhere.
4. **PWA:** reuse the existing `manifest.webmanifest` and icon set **verbatim**;
   `vite-plugin-pwa` generates the service worker (`manifest: false`),
   preserving the hand-tuned manifest and its `crossorigin="use-credentials"`
   link.

---

## Out of scope this session (do NOT do these)

- Porting any egui UI, state, RPC, or formatting logic into Solid.
- The virtualized results-grid performance prototype (a later session).
- Removing or gutting `frontend-old-egui` — it stays intact as reference.
- Regenerating the PWA icon set (we reuse the existing PNGs; `xtask icons` is
  repointed for coherence but does not need to be re-run).

---

## ⚠️ Build-cost rule (from `CLAUDE.md`) — read before touching Rust

Part 1 edits the **top-level `Cargo.toml`**. Per `CLAUDE.md`, once you modify
the top-level `Cargo.toml` you **must not run any cargo command yourself** (it
can trigger a >20-min `duckdb-sys` rebuild). So:

- Make all Rust-side edits in Part 1, then **stop**. The user runs the
  production build (`cargo xtask build-release`) as their QA milestone.
- The **new `frontend/` is pure JS** — it has no `Cargo.toml`, so the Bun /
  Vite / ESLint / Prettier / Playwright commands in Part 2 are yours to run freely.

---

## Part 1 — Move egui to `frontend-old-egui/`, make Solid the production frontend

### 1.1 Move the directory (preserve tracked + untracked)

`frontend/dist/` build artifacts are gitignored (only `.gitkeep` is tracked), so
use a filesystem move, then let git detect the renames:

```bash
mv frontend frontend-old-egui
git add -A
```

### 1.2 Rename the crate package

In `frontend-old-egui/Cargo.toml`: `name = "frontend"` → `name = "frontend-old-egui"`.
(Leave the `[[bin]] name = "radiocrate-ui"` and lib settings unchanged.)

### 1.3 Root `Cargo.toml`

- `members`: replace `"frontend"` with `"frontend-old-egui"`.
- `default-members`: change `["backend", "frontend"]` → `["backend"]`
  (the production frontend is no longer a cargo crate; the egui crate is still
  reachable via `-p frontend-old-egui`).
- Leave the `[profile.dev.package.libduckdb-sys]` override untouched.

### 1.4 Production binary embed — `radiocrate/src/main.rs`

**No change needed.** `#[folder = "../frontend/dist/"]` now points at the Solid
app's Vite output (Vite's `outDir` is also `frontend/dist`). The SPA fallback,
the `sw.js` `Service-Worker-Allowed` header special-case, and the
`.webmanifest` content-type handling all continue to apply to the Solid build
(`vite-plugin-pwa` emits `sw.js` at the dist root; the manifest ships from
`public/`). Ensure `frontend/dist/.gitkeep` exists so `rust-embed` compiles on a
fresh checkout before the first build (see 2.11).

> Follow-up note (not this session): the `CACHE_CONTROL = "no-cache"` rationale
> in this file assumes unhashed filenames (an egui/trunk trait). Vite emits
> content-hashed asset names, so those could later be served `immutable`. The
> current `no-cache` remains correct, just conservative.

### 1.5 `xtask` — build the Solid app instead of the egui app

**`xtask/src/main.rs` — `build_release()`:** replace the trunk pipeline with the
Bun/Vite one:

- Drop the `trunk --version` check; instead verify `bun` is available.
- Replace `trunk build --release` (run in `frontend`) with, run in
  `root.join("frontend")`:
  - `bun install` (or `bun install --frozen-lockfile`)
  - `bun run build`   → emits `frontend/dist`
- **Remove** the `service_worker::stamp(&frontend.join("dist"))?` step — Workbox
  (via `vite-plugin-pwa`) handles precache revisioning.
- Keep the final `cargo build --release -p radiocrate`.
- Update the usage/help text: *"build-release — Build the Solid frontend with
  Bun/Vite and the production binary"*.

**`xtask/src/main.rs` — `clean_web()`:** `frontend/dist` path is unchanged (still
the production dist) — no edit required.

**`xtask/src/main.rs` — top:** remove `mod service_worker;`.

**Delete `xtask/src/service_worker.rs`** — it stamped the hand-rolled egui
`sw.js`, which no longer exists in the build.

**`xtask/src/icons.rs`** (repoint for coherence; not re-run this session):
- output dir `root.join("frontend/assets/icons")` → `frontend/public/icons`.
- `write_launch_links(&root.join("frontend/index.html"))` stays
  `frontend/index.html` (the new entry HTML retains the generated marker block —
  see 2.7), so launch-image regeneration continues to work.

### 1.6 `.gitignore`

- Keep `/frontend/dist/*` and `!/frontend/dist/.gitkeep` — these now guard the
  **Solid** build output that `rust-embed` embeds.
- **Add** `/frontend-old-egui/dist/` (reference egui builds, embedded by
  nothing).
- **Add** the new-frontend ignores (see 2.11).
- The transient `*.new.png` / `*.diff.png` / `*.old.png` / `*.composite.png`
  rules stay (they also cover Playwright's `*-diff.png`; add `*-actual.png` in
  2.11).

### 1.7 `.cargo/config.toml`

The `web_sys_unstable_apis` rustflag now only matters for `frontend-old-egui`
reference builds. Keep it; update the trailing comment to say the flag is picked
up by builds of `frontend-old-egui`.

### 1.8 `.claude/settings.local.json`

Permission entry `Bash(UPDATE_SNAPSHOTS=1 cargo test -p frontend)` →
`... -p frontend-old-egui`.

### 1.9 Hand-off

Do **not** run cargo (see the build-cost rule). Summarize the Rust-side edits
and hand off to the user, whose QA milestone is:

```bash
cargo xtask build-release
./target/release/radiocrate <collection-path>   # confirm it serves the Solid shell
```

---

## Part 2 — Scaffold the new SolidJS `frontend/`

Work inside a fresh `frontend/` directory. Prefer `bun add` (let Bun resolve
current versions) over pinning exact versions in this document.

### 2.1 Initialize with Bun

```bash
cd frontend
bun init -y     # then replace the generated files as below
```

Create `package.json` with these scripts (adjust the typecheck binary per 2.4):

```jsonc
{
  "name": "radiocrate-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsgo --noEmit",        // see 2.4 re: tsgo vs tsc
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test:visual": "playwright test",
    "test:visual:update": "playwright test --update-snapshots"
  }
}
```

Dependencies to add:

```bash
bun add solid-js
bun add -d vite vite-plugin-solid vite-plugin-pwa @playwright/test typescript
# ESLint (flat config) + Solid rules + Prettier
bun add -d eslint @eslint/js typescript-eslint eslint-plugin-solid \
          eslint-config-prettier prettier
# Styling: Tailwind CSS v4 + official Prettier class sorter
bun add -d tailwindcss @tailwindcss/vite prettier-plugin-tailwindcss
# TS7: if `typescript@7` stable's CLI is `tsc` (native), the above is enough.
# If using the preview channel instead, add: bun add -d @typescript/native-preview
# Future component tests (config only this session):
bun add -d vitest @solidjs/testing-library @testing-library/jest-dom jsdom
```

Commit `bun.lock` (text lockfile). Do **not** commit `node_modules/`.

### 2.2 `vite.config.ts`

```ts
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    solid(),
    tailwindcss(),                // Tailwind v4 — no PostCSS/config file needed
    VitePWA({
      strategies: "generateSW",
      registerType: "prompt",       // mirror old SW: wait, don't auto-activate
      manifest: false,              // keep the hand-tuned static manifest (2.6)
      workbox: {
        navigateFallback: "/index.html",
        // Never let the SW answer API calls — mirror the egui SW's /api passthrough.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          { urlPattern: /^\/api\//, handler: "NetworkOnly" },
        ],
      },
    }),
  ],
  build: { outDir: "dist", target: "esnext" },
});
```

### 2.3 `tsconfig.json`

Solid needs its JSX transform (done by `vite-plugin-solid` via Babel), so
TypeScript only preserves JSX and type-checks:

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "types": ["vite/client", "vite-plugin-pwa/client"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src", "vite.config.ts", "tests"]
}
```

### 2.4 TypeScript 7 note

TS7 GA'd 2026-07-08. Confirm the installed compiler's CLI at scaffold time:
- `typescript@^7` stable → the native compiler; try `bunx tsc --noEmit`.
- `@typescript/native-preview` → binary is `tsgo`; use `bunx tsgo --noEmit`.

Set the `typecheck` script to whichever resolves. Optionally add
`.vscode/settings.json` (or extend the repo's) to enable the native TS server
for this folder, enable the ESLint extension, and set Prettier as the default
formatter.

### 2.5 ESLint (flat config) + Prettier

ESLint provides the full Solid reactivity ruleset; Prettier handles formatting
(we don't care about conventions). `eslint-config-prettier` disables ESLint's
stylistic rules so the two never fight.

`eslint.config.js` (ESLint 9 flat config):

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid/configs/typescript";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/", "dev-dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    ...solid,
    languageOptions: { parser: tseslint.parser },
  },
  prettier, // must come last — turns off formatting-related rules
);
```

Notes:
- `eslint-plugin-solid/configs/typescript` is its flat-config recommended set —
  the reactivity rules (`solid/reactivity`, `solid/no-destructure`, etc.) are
  the whole reason we're on ESLint rather than Biome.
- This uses the non-type-checked `typescript-eslint` preset to keep lint fast.
  For type-aware rules later, swap `tseslint.configs.recommended` for
  `recommendedTypeChecked` and add `parserOptions: { projectService: true }`.

`.prettierrc.json` — defaults are fine; load the Tailwind plugin so class lists
are auto-sorted into canonical order (it must be the last plugin):

```json
{ "plugins": ["prettier-plugin-tailwindcss"] }
```

`.prettierignore`:

```
dist
dev-dist
node_modules
public/icons
```

(Ignore `public/icons` so Prettier never rewrites the committed SVG logo.)

### 2.6 PWA assets (reuse the egui app's, verbatim)

Vite serves `public/` at the site root.

- Copy `frontend-old-egui/assets/manifest.webmanifest` → `frontend/public/manifest.webmanifest` (unchanged).
- Copy `frontend-old-egui/assets/icons/` → `frontend/public/icons/` (all icons + `logo.svg` + the `launch-*` images).

### 2.7 `index.html` (Vite entry, at `frontend/index.html`)

Port the **PWA-relevant** head from `frontend-old-egui/index.html`, dropping all
egui/canvas/trunk specifics. Keep:

- `<meta name="viewport" ... viewport-fit=cover>`, title, description.
- `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">`
  (the `use-credentials` comment explains why — keep it).
- All icon / `apple-touch-icon` links, the generated `apple-touch-startup-image`
  block **including its `<!-- BEGIN generated: ios-launch-images ... -->` /
  `<!-- END ... -->` markers** (so `xtask icons`' `write_launch_links` can still
  rewrite it), the `mobile-web-app-capable` / `apple-mobile-web-app-*` metas,
  `color-scheme`, and the two `theme-color` media metas.
- The **pre-paint theme bootstrap `<script>`** (reads `localStorage.theme`, sets
  `data-theme` + a `theme-color` meta) — it's framework-agnostic, keep it.

Remove:

- `<link data-trunk ...>` lines, the `<canvas>`, the `#safe-top`/`#safe-bottom`
  wrappers' canvas-specific rationale, the `touch-action`/canvas CSS, the WASM
  splash screen + its error handler, and the **hand-rolled SW registration
  script** (`vite-plugin-pwa` injects registration instead — see 2.9).

Body becomes:

```html
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
```

Move the shared surface CSS (the `--panel` / `--sheet` vars, light/dark +
`data-theme` overrides, `overscroll-behavior: none`, and the
`input { font-size: 16px }` iOS-zoom guard) into `src/app.css`'s Tailwind
`@layer base` (2.8) rather than inline, except whatever must run before first
paint.

### 2.8 App source

`src/main.tsx`:

```tsx
import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./app.css";

// Mirror the old SW update flow: prompt, don't auto-activate.
const updateSW = registerSW({ onNeedRefresh() {}, onOfflineReady() {} });
// Optional: expose a manual apply, matching window.radiocrate.applyUpdate.
(window as any).radiocrate = { applyUpdate: () => updateSW(true) };

render(() => <App />, document.getElementById("root")!);
```

`src/App.tsx` — the entire shell for this session. **The Tailwind utility
classes here are deliberate: they double as proof the Tailwind pipeline works**
(layout + typography utilities, a responsive `sm:` variant, and the
theme-backed `bg-panel`/`text-ink` colors defined in `app.css`). Note Solid uses
`class`, not `className`:

```tsx
export default function App() {
  return (
    <main class="fixed inset-0 flex items-center justify-center bg-panel text-ink text-4xl font-semibold tracking-tight sm:text-6xl">
      RadioCrate
    </main>
  );
}
```

> After scaffolding, run `bun run format` and confirm
> `prettier-plugin-tailwindcss` reorders the class list into canonical order —
> that (plus the styled screenshot) confirms the Tailwind + Prettier wiring end
> to end.

`src/app.css` — imports Tailwind, then exposes the app's `light-dark()` surface
colors to Tailwind as theme tokens so utilities like `bg-panel` / `text-ink`
theme themselves with **no `dark:` variants needed**, and finally ports the
reset / theme-override / iOS-zoom-guard rules from the old `index.html` into a
Tailwind `@layer base`:

```css
@import "tailwindcss";

/* Map Tailwind color tokens onto the CSS vars below (v4 CSS-first config). */
@theme inline {
  --color-panel: var(--panel);
  --color-sheet: var(--sheet);
  --color-ink:   var(--ink);
}

@layer base {
  :root {
    --panel: #f8f8f8; --sheet: #f0f0f0; --ink: #1b1b1b;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root { --panel: #1b1b1b; --sheet: #232323; --ink: #f8f8f8; }
  }
  /* An explicit stored choice (set pre-paint in index.html) wins over system. */
  :root[data-theme="light"] { --panel:#f8f8f8; --sheet:#f0f0f0; --ink:#1b1b1b; color-scheme:light; }
  :root[data-theme="dark"]  { --panel:#1b1b1b; --sheet:#232323; --ink:#f8f8f8; color-scheme:dark; }

  html, body {
    margin: 0; height: 100%; background: var(--panel);
    overscroll-behavior: none; -webkit-tap-highlight-color: transparent;
  }
  input { font-size: 16px; }  /* keep the iOS auto-zoom guard for future forms */
}
```

> Safe-area insets (`env(safe-area-inset-*)`) are omitted from this centered
> shell; add them with the real layout later (Tailwind arbitrary values like
> `pt-[env(safe-area-inset-top)]`, or plain CSS).

### 2.9 Service worker

`vite-plugin-pwa` (2.2) generates and injects the SW; `registerSW` (2.8) wires
it up. This **replaces** the hand-rolled `assets/sw.js` + the `xtask`
`service_worker::stamp` machinery — Workbox handles precache revisioning. Do
**not** copy the old `sw.js`. The old SW's two invariants are preserved by
config: shell precache (Workbox default globs) and `/api` never intercepted
(`navigateFallbackDenylist` + `NetworkOnly`). The output filename is `sw.js` at
the dist root, matching the `radiocrate` static handler's special-case.

### 2.10 Whole-app visual snapshot test (Playwright)

`playwright.config.ts`:

```ts
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
```

`tests/visual/app.spec.ts` — capture the whole app in **both light and dark**
(mirroring the egui dual-theme convention), deterministically:

```ts
import { test, expect } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  test(`whole app - ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`whole-app-${colorScheme}.png`, {
      fullPage: true,
    });
  });
}
```

Baselines land in `tests/visual/__screenshots__/` and **are committed**. Generate
them with `bun run test:visual:update`.

> **Agent self-validation (mirrors `CLAUDE.md`'s snapshot workflow):** after
> generating the PNGs, **open them with the Read tool** and confirm the text
> "RadioCrate" is centered and legible in both themes before considering the
> task done.

### 2.11 `.gitignore` for the new frontend

Add (repo root `.gitignore`):

```
/frontend/node_modules/
/frontend/test-results/
/frontend/playwright-report/
# Playwright transient screenshot artifact (baselines are committed; diffs
# are already covered by the existing *-diff.png rule)
*-actual.png
```

`/frontend/dist/*` (+ `!/frontend/dist/.gitkeep`) is already handled in 1.6.
Create `frontend/dist/.gitkeep` so `rust-embed` in `radiocrate` compiles before
the first `bun run build`.

Commit: `bun.lock`, all config files, `src/`, `public/`, `index.html`,
`tests/visual/app.spec.ts`, and the baseline PNGs under `__screenshots__/`.

### 2.12 JS-side validation (run these yourself)

```bash
cd frontend
bun install
bun run typecheck      # tsgo/tsc --noEmit — clean
bun run lint           # ESLint (+ eslint-plugin-solid) — clean
bun run format:check   # Prettier — clean
bun run build          # Vite → frontend/dist, SW + manifest present
bunx playwright install chromium   # may need network — see gotchas
bun run test:visual:update         # generate + commit baselines
```

Then Read the generated `__screenshots__/whole-app-*.png` and confirm the shell.

---

## Part 3 — Docs & housekeeping

Update prose references so future sessions aren't misled:

- **`README.md`**: crate table — `frontend-old-egui` is the retired egui crate
  (reference only); the production frontend is now the SolidJS SPA in
  `frontend/` (not a cargo crate). Rewrite the build steps: `cargo xtask
  build-release` now runs `bun run build` and embeds `frontend/dist`; there is
  no more `trunk build` in the production path. Point icon-regeneration text at
  `frontend/public/icons` + `frontend/index.html`.
- **`DEVELOPMENT.md`**: the egui snapshot section now lives under
  `frontend-old-egui/tests/snapshots/` (reference); add a subsection for the new
  frontend's Playwright visual snapshots and the Bun/Vite/ESLint/Prettier/tsgo workflow.
- **`CLAUDE.md`** (governs agent behavior — flag these edits for user review):
  - Repoint egui snapshot paths/commands to `frontend-old-egui` (`-p frontend`
    → `-p frontend-old-egui`).
  - Add a note that the new `frontend/` is **pure JS/Bun** with **no
    `Cargo.toml`**, so the cargo build-cost rules don't apply to it; its checks
    are `bun run typecheck | lint | format:check | build` and
    `bun run test:visual`.
  - Add a **SolidJS authoring rules** block so agents don't apply React
    semantics (Solid's JSX looks like React's but isn't — these are the silent
    reactivity traps). Insert this into `CLAUDE.md` roughly verbatim:

    > ### Writing SolidJS (not React)
    > The `frontend/` app is **SolidJS**. Its JSX resembles React but the
    > semantics differ — violate these and reactivity silently breaks:
    > - **Components run once.** The function body is setup, not a render loop;
    >   don't put per-update logic in it or expect it to re-run.
    > - **Never destructure `props`** (or a store) — that reads the value once
    >   and loses reactivity. Access `props.foo` at the point of use; reach for
    >   `splitProps` / `mergeProps` when you must split or default props.
    > - **Signals are getter functions:** read them as `count()`, not `count`.
    > - **No dependency arrays.** `createEffect` / `createMemo` auto-track the
    >   signals they read. Use those plus `onMount` / `onCleanup` — never
    >   `useEffect` / `useState` / `useMemo`.
    > - **Use control-flow components in JSX** — `<For>`, `<Show>`, `<Switch>` /
    >   `<Match>`, `<Index>` — instead of `.map()` and ternaries, so updates
    >   stay keyed and fine-grained.
    > - **The attribute is `class`, not `className`;** use `classList={{…}}` for
    >   conditional classes. Styling is Tailwind utilities (Prettier sorts them).
    > - Keep signal reads inside a tracking scope (JSX, or an effect/memo);
    >   reading a signal in plain top-level code won't update.
    > - Prefer Solid primitives: `createSignal`, `createStore`, `createEffect`,
    >   `createMemo`, `createResource`.
    >
    > `eslint-plugin-solid` enforces several of these — `bun run lint` catches
    > destructured props, uncalled signals, and lost-reactivity patterns.

---

## Final checklist

- [ ] `frontend-old-egui/` remains a buildable reference workspace member.
- [ ] `radiocrate` embeds `../frontend/dist/` (now the Solid build output).
- [ ] `cargo xtask build-release` builds the Solid app via Bun/Vite; no trunk /
      service-worker-stamp steps remain; `xtask/src/service_worker.rs` deleted.
- [ ] New `frontend/`: `bun run typecheck`, `lint`, `build` all clean.
- [ ] App shows only "RadioCrate", centered, light + dark — verified by reading the PNGs.
- [ ] Tailwind is wired (`@tailwindcss/vite`): the RadioCrate text uses Tailwind
      utility classes and `prettier-plugin-tailwindcss` sorts them.
- [ ] Manifest, icons, and a generated `sw.js` are present in `frontend/dist`.
- [ ] Committed baseline PNGs exist under `frontend/tests/visual/__screenshots__/`.
- [ ] `frontend/dist/.gitkeep` present for `rust-embed`.
- [ ] Docs (`README`, `DEVELOPMENT`, `CLAUDE.md`) updated; no stale egui `frontend` refs.
- [ ] **User QA:** `cargo xtask build-release` + run the binary → serves the Solid shell.

## Gotchas & notes

- **Cargo build-cost rule**: after editing the root `Cargo.toml`, do not run
  cargo — the user runs `cargo xtask build-release` (Part 1.9).
- **Playwright browsers**: `bunx playwright install chromium` downloads a
  browser and may need network access the sandbox lacks. If it fails, surface it
  to the user rather than working around it. Screenshots are only reproducible
  when generated in the same (container) environment that CI uses.
- **Font determinism**: the shell uses `system-ui`. Baselines generated in the
  dev container are stable there; if cross-machine drift appears later, bundle a
  webfont (the old app shipped Noto Sans in `frontend-old-egui/fonts/`).
- **TS7 CLI**: verify `tsc` vs `tsgo` at scaffold time (Part 2.4) and set the
  `typecheck` script accordingly.
- **Don't mix SW registrations**: use only `vite-plugin-pwa`'s `registerSW`; the
  old hand-rolled registration + `sw.js` are intentionally dropped.
- **Vite hashed filenames**: `radiocrate`'s `no-cache` header + comment assume
  unhashed names; still correct with Vite, just conservative (Part 1.4 note).
</content>
