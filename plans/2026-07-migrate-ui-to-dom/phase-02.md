# Phase 02 — The app frame: explorer sidebar + tab bar (DOM/SolidJS)

## Where this fits (read first)

We are migrating RadioCrate's frontend from an **egui/eframe WASM canvas** app to
a **web-native SolidJS DOM** app, rebuilding the UI **from the outside in** — the
outermost chrome first, then working inward toward the finer detail over later
phases.

- **Phase 01 (done — see [`phase-01.md`](phase-01.md)):** moved the egui app to
  `frontend-old-egui/` (kept as a read-only reference), and stood up a fresh
  SolidJS SPA in `frontend/` as the production frontend. It currently renders
  only the word "RadioCrate" centered in the viewport, but carries the full PWA
  fixings, Tailwind v4, ESLint + `eslint-plugin-solid`, Prettier, TypeScript
  (typecheck via `tsgo`), and a Playwright whole-app visual-snapshot test.
- **Phase 02 (this plan):** build the app **frame** — the explorer sidebar and
  the tab bar — with real query data loaded from the backend, plus the mobile
  swipe-to-close drawer and drag-to-reorder tabs. **No tab _content_ yet.**

The `frontend-old-egui/` crate is the **behavioral and visual source of truth**.
Port its look and interactions; do not port its Rust structure literally (egui is
immediate-mode; Solid is retained/reactive). Cited `file:line` references below
point into that crate.

### Stack recap (all already wired in phase 01)

| Concern | Tool |
|---|---|
| Framework | SolidJS (`solid-js`) — **not React**; see the "Writing SolidJS" block in [`CLAUDE.md`](../../CLAUDE.md) |
| Package manager / runtime | Bun (installed in the container; `~/.bun/bin` on PATH) |
| Bundler / dev server | Vite + `vite-plugin-solid`, client-only SPA |
| Styling | Tailwind CSS v4 (CSS-first, `@tailwindcss/vite`); theme tokens in `src/app.css` |
| Types / lint / format | `tsgo --noEmit` / ESLint + `eslint-plugin-solid` / Prettier |
| Visual tests | Playwright full-page screenshots, light + dark, committed under `frontend/tests/visual/__screenshots__/` |

The `frontend/` app is **pure JS — no `Cargo.toml`.** The cargo build-cost rules
do not apply; run `bun run typecheck | lint | format:check | build` and
`bun run test:visual` freely from `frontend/`. **This phase touches no Rust** (the
backend RPC API already exists and is unchanged).

---

## Goal & scope

Bring **some** of `frontend-old-egui/tests/snapshots/app/whole_app.png` (open it
and study it — light on top, dark on bottom) into the Solid app: specifically the
**left explorer sidebar** and the **top tab bar**. The results toolbar, the query
input, and the results grid inside a tab are **out of scope**.

### Do

1. **Explorer sidebar**, matching the reference:
   - An **"Opened"** collapsible section listing the currently-open queries (the
     open tabs), each row with the query icon, its name, and a close (×) button;
     the active one marked with a left accent bar.
   - A **"Queries"** collapsible section with a **refresh** button in its header,
     a **"Filter"** text input, and a list of every saved query (case-insensitive
     substring filter over the name).
   - A static **"Settings"** footer row (gear icon + "Settings" label) pinned to
     the bottom — **rendered only, no menu/behavior** (see "Do NOT").
   - **Swipe-to-close** on narrow viewports (the mobile drawer — see §7).
2. **Load query objects from the backend** (`query.list` RPC) and list them in
   the "Queries" section, as `frontend-old-egui` does.
3. **Tab bar** across the top: the sidebar-toggle button, then one handle per open
   tab (query icon, name, active indicator, close button), then a **"+"** new-tab
   button. Include **drag-to-reorder** tabs.
4. **Visual snapshot testing with mocked data** so tests run with **no backend**.
5. Generate these snapshots (each in **light and dark**, per the established
   dual-theme convention):
   - **`frame-empty`** — no tabs open, sidebar closed.
   - **`frame-populated`** — sidebar open, **two** tabs open.

### Do NOT

- Implement the **content inside a tab** (toolbar, query input, results grid).
  An open tab's content area is a **blank panel** this phase.
- Implement the **Settings** menu/dropdown or any of its actions (theme switch,
  keyboard-shortcuts editor). Render the static footer row only.
- Add any third-party runtime library **other than an icon library** (§2).
  Swipe and drag are **hand-rolled** with Pointer Events — no gesture/DnD library.
- Port presets, keybindings, playback, the now-playing bar, the command palette,
  or the query-builder — all later phases.

---

## 1. The backend API (already exists — do not modify)

Saved queries come from a **JSON-RPC 2.0** endpoint. In production the frontend is
same-origin, so the base is **`/api`**; the RPC route is **`POST /api/rpc`**.

Request envelope (see `frontend-old-egui/src/rpc.rs:252`):

```json
{ "jsonrpc": "2.0", "method": "query.list", "params": null, "id": 1 }
```

Response: `{ "jsonrpc": "2.0", "result": <value>, "id": 1 }`, or an `error`
object `{ code, message, data? }` instead of `result`.

**`query.list`** returns an array, ordered `created_at DESC`
(`backend/src/rpc.rs:289`):

```ts
interface Query {
  id: string;          // UUID
  name: string;
  created_at: number;  // epoch seconds
  modified_at: number; // epoch seconds
  last_play: number;   // epoch seconds
  definition: string;  // opaque JSON string — DO NOT parse this phase
}
```

This phase only needs `id` and `name`. Treat `definition` as opaque (it is the
structured query — a later phase decodes it). Other methods
(`query.add/rename/delete`, `preset.*`, `keybinding.*`, `dml`) exist but are **out
of scope**; do not call them.

> **Dev-server proxy (add this):** in dev, Vite serves the app on its own port
> while the backend API runs on `http://localhost:3000`. Add a proxy to
> `vite.config.ts` so `/api` reaches the backend:
> ```ts
> server: { proxy: { "/api": "http://localhost:3000" } },
> ```
> This keeps the client code origin-relative (`/api/...`) in every environment.
> Run the dev API with `cargo run -p backend -- /path/to/music` (see README).

---

## 2. Icon library (the one new dependency)

`frontend-old-egui` uses **Google Material Symbols**, the *filled* variant, via
`egui_material_icons` — with a **semantic vocabulary** in
`frontend-old-egui/src/icons.rs` (call sites name a concept like `QUERY`, never a
raw glyph). **Reproduce that indirection** in the Solid app.

**Recommended package:** the Iconify Material Symbols data set
(`@iconify-json/material-symbols`) loaded at build time via **`unplugin-icons`**,
which imports each glyph as an inlined Solid SVG component — tree-shakeable, no
runtime font fetch (CSP- and offline-safe), and `currentColor`-fillable so the
theme tokens style it. In Iconify's `material-symbols` set the **base name is the
filled variant** (e.g. `material-symbols:manage-search`), matching our usage;
`-outline` is the unfilled one.

```bash
bun add -d unplugin-icons @iconify-json/material-symbols
```

`unplugin-icons` is **build tooling** (like `vite-plugin-solid`), not shipped
runtime code, so this stays within "only an icon library."

- Add the Vite plugin (`unplugin-icons/vite`, `compiler: "solid"`), and the
  `~icons/*` type shim to `tsconfig.json`/an ambient `.d.ts`.
- Create **`src/icons.ts`** — the semantic map, mirroring
  `frontend-old-egui/src/icons.rs`. Only the concepts this phase needs:

  | Concept | Material Symbol (filled) | Used for |
  |---|---|---|
  | `Query` | `manage-search` | query rows + tab handle icon |
  | `ExplorerOpen` | `left-panel-open` | sidebar toggle when closed |
  | `ExplorerClose` | `left-panel-close` | sidebar toggle when open |
  | `Close` | `close` | tab close ×, opened-row × |
  | `Add` | `add` | new-tab (+) |
  | `Refresh` | `refresh` | Queries-section reload |
  | `ExpandOpen` | `expand-more` | expanded section chevron |
  | `ExpandClosed` | `chevron-right` | collapsed section chevron |
  | `Settings` | `settings` | static Settings footer |

- Wrap usage in one small `<Icon>` component (or export the mapped components
  directly) so size/color are set consistently and every call site names the
  concept. Icons render at `currentColor`; size via Tailwind (`size-*`)/font size.

Verify the chosen glyphs read the same as `whole_app.png` before committing.

---

## 3. App architecture

### 3.1 State model

Hold app state in a **Solid `createStore`** exposed through a **context provider**
(`src/state/store.tsx`), consumed via a `useAppState()` hook. Keep it small and
typed:

```ts
interface Tab {
  id: string;    // the query's UUID (tab id == query id this phase)
  name: string;
  // (future: pinned/preview, unsaved, page-kind. Not needed for these snapshots.)
}

interface AppState {
  sidebarOpen: boolean;      // explorer open/closed (persist to localStorage, like theme)
  tabs: Tab[];               // open tabs, in tab-bar order
  activeTabId: string | null;
  queryFilter: string;       // "Filter" input text in the Queries section
  openedCollapsed: boolean;  // "Opened" section disclosure
  queriesCollapsed: boolean; // "Queries" section disclosure
}
```

- **Saved-query list** loads via a **`createResource`** wrapping
  `listQueries()` (§4). The "Queries" section renders `resource()` filtered by
  `queryFilter`; the header refresh button calls `refetch()`.
- **Derived:** the "Opened" section is derived from `tabs`; the active row/tab is
  `activeTabId`. Prefer `createMemo`/`<For>` over manual recomputation.
- **Actions** (methods on the store): `toggleSidebar`, `openTab(query)`,
  `closeTab(id)`, `selectTab(id)`, `reorderTab(id, toIndex)`, `setQueryFilter`,
  toggles for the two section collapses. `openTab` appends if not already open,
  then selects; keep it simple — **no preview/pin semantics this phase** (every
  opened tab is a normal tab). Note the egui app has VS-Code-style preview tabs
  (`frontend-old-egui/src/page.rs:283`); we defer that.

> **Solid reactivity reminders** (violating these silently breaks updates — the
> full list is in [`CLAUDE.md`](../../CLAUDE.md)): never destructure `props` or the
> store; read signals as `value()`; use `<For>`/`<Show>` not `.map()`/ternaries;
> the attribute is `class`, not `className`. `bun run lint` catches most of these.

### 3.2 Component tree

```
<App>                         fixed inset-0 flex column; owns the layout + breakpoint
├─ <Sidebar>                  the explorer (persistent panel OR drawer — §7)
│  ├─ <CollapseHeader "Opened">
│  ├─ <OpenedList>            <For tabs> → <OpenedRow>
│  ├─ <CollapseHeader "Queries" withRefresh>
│  ├─ <QueryFilterInput>
│  ├─ <QueryList>             <For filtered queries> → <QueryRow>
│  └─ <SettingsFooter/>       static; no behavior
├─ <Scrim/>                   drawer backdrop (narrow + open only)
└─ <Main>                     flex column, fills remaining width
   ├─ <TabBar>
   │  ├─ <ExplorerToggle/>    left-panel-open/close
   │  ├─ <For tabs> → <TabHandle>
   │  └─ <NewTabButton/>      "+"
   └─ <TabContent/>           BLANK panel this phase (out of scope)
```

### 3.3 Files (suggested)

```
src/
  icons.ts                 semantic icon map (§2)
  state/store.tsx          createStore + context provider + useAppState()
  api/rpc.ts               rpcCall(), listQueries()
  components/
    Sidebar.tsx  OpenedRow.tsx  QueryRow.tsx  CollapseHeader.tsx  SettingsFooter.tsx
    TabBar.tsx   TabHandle.tsx
  gestures/                hand-rolled Pointer Events helpers
    useSwipeToClose.ts     drawer swipe (§7)
    useTabDragReorder.ts   tab drag (§5)
  dev/seed.ts              test/dev initial-state seeding (§8)
```

---

## 4. RPC client (`src/api/rpc.ts`)

A tiny, typed client — no RPC library.

```ts
export async function rpcCall<T>(method: string, params: unknown = null): Promise<T> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const env = await res.json();
  if (env.error) throw new Error(env.error.message ?? "rpc error");
  return env.result as T;
}

export const listQueries = () => rpcCall<Query[]>("query.list");
```

Route it through `createResource(listQueries)` in the store. This is the single
seam Playwright mocks (§8) — tests intercept `POST /api/rpc` and never hit a
backend.

---

## 5. Tab bar

Study `frontend-old-egui/src/tabs.rs` (constants at the top; `draw_one_tab` at
`:441`) and the reference image. Reproduce the **look and behavior**, not the code.

**Layout:** a horizontal bar, height ~**34px** (`TAB_BAR_HEIGHT`), spanning the
area right of the sidebar. Left-to-right: the **explorer toggle** button, the tab
handles, then the **"+"** button. The bar background is a shade darker than the
content panel (egui `bar_fill = shade(panel, 10)`); measure `whole_app.png`.

**A tab handle** (`TabHandle.tsx`):
- Only the **top corners** are rounded; it sits flush with the content below.
- **Active tab:** filled with the **content panel color** (so it "connects" to the
  content), plus a **4px accent-blue top edge** (`HOVER_BLUE`, `#77A5CE`); name at
  full-strength text, icon at the default icon gray.
- **Inactive tab:** bar-colored (darker on hover), icon+name dimmed to the weak
  text color.
- Contents: the **query icon** (`Query` → `manage-search`), the **name**
  (truncate with ellipsis when the bar is crowded), and a **close (×)** button on
  the right. A 1px separator on the right edge between handles.
- **Do not** implement the preview/pin control or the unsaved marker or the
  right-click options menu this phase (they exist in the egui source — skip them).

**Buttons:**
- **Explorer toggle:** `left-panel-close` when the sidebar is open, `left-panel-open`
  when closed; toggles `sidebarOpen`. Always present (`page.rs:274`).
- **New tab ("+"):** `Add`. For this phase it may open a placeholder/no-op tab, or
  be inert — the snapshots don't require it to create anything. Keep it visible.

**Drag-to-reorder** (`useTabDragReorder.ts`, hand-rolled Pointer Events):
- On `pointerdown` + move past a small threshold on a handle, begin a drag:
  capture the pointer, follow it horizontally (track pointer-x minus the grab
  offset so the handle doesn't jump — cf. `TabDrag.grab_offset`, `tabs.rs:52`).
- While dragging, lift the handle visually (a hairline accent outline, per
  `tabs.rs`), and when its center crosses a neighbor's midpoint, reorder in the
  store (`reorderTab`). Commit on `pointerup`.
- Distinguish a **click** (select/close) from a **drag** via the movement
  threshold. Not snapshot-verified; test by hand (optionally add an interaction
  spec later).

---

## 6. Explorer sidebar

Study `frontend-old-egui/src/organizer.rs` (`collapse_header` `:504`,
`settings_footer` `:585`, `section_hint` `:664`, the row widgets) and the
reference. Width is **`ORGANIZER_WIDTH` = 200px** (`lib.rs:57`).

**Collapse header** (`CollapseHeader.tsx`, ~28px tall): a disclosure chevron
(`expand-more` open / `chevron-right` collapsed) + the title; hover background;
clicking toggles the section. The **"Queries"** header additionally shows a
**refresh** button on the right that calls the resource's `refetch()`.

**"Opened" section:** `<For>` over `tabs` → **`OpenedRow`**: the query icon +
name, a hover background, and a **close (×)** on the right (calls `closeTab`). The
**active** row (its id === `activeTabId`) is marked with a **left accent bar**
(`HOVER_BLUE`) — the Opened list marks the active item this way rather than with a
fill (`organizer.rs:677`). Clicking a row selects that tab. When there are no open
tabs, show a muted section hint (e.g. "No open queries") in place of rows
(`section_hint`).

**"Queries" section:** a **"Filter"** text input (bound to `queryFilter`) followed
by `<For>` over the saved queries whose name contains `queryFilter`
(case-insensitive) → **`QueryRow`**: query icon + name, hover background. Clicking
a row **opens it as a tab** (`openTab`). (The egui rows also have a `⋮` options
menu and inline rename — **skip both** this phase.)

> The reference "Filter" input keeps the **`input { font-size: 16px }`** iOS-zoom
> guard already in `app.css`. Good.

**Settings footer** (`SettingsFooter.tsx`, ~30px, pinned to the sidebar bottom):
the gear icon + "Settings" in muted gray, with a hover background — **static, no
click handler / no menu** this phase.

---

## 7. Persistent panel vs. mobile drawer (+ swipe-to-close)

`frontend-old-egui` switches the sidebar between two modes at a viewport-width
breakpoint (`lib.rs:59`, `PERSISTENT_ORGANIZER_MIN_WIDTH` = **500px**):

- **Wide (≥ 500px): persistent left panel.** The sidebar reserves its own 200px
  column; `<Main>` sits beside it. No scrim. (This is the mode both required
  snapshots use, at 1280px wide — matching `whole_app.png`.)
- **Narrow (< 500px): modal drawer.** The sidebar overlays the content from the
  left, with a **dimming scrim** behind it; the content does not reflow. Opening
  slides it in; a short animation (`ORGANIZER_ANIM_TIME` = 0.1s) eases open/close.

**Swipe-to-close** (`useSwipeToClose.ts`, drawer mode only — hand-rolled Pointer
Events, port the feel from `lib.rs` + `organizer.rs:1009`):
- A horizontal drag on the drawer tracks the finger leftward to close, applying
  **static friction** so small movements barely move the drawer (so a vertical
  scroll inside the drawer isn't mistaken for a close-swipe). Port
  `static_friction(dx, friction)` (`organizer.rs:1009`) with `friction =
  ORGANIZER_DRAG_FRICTION` (**16**): `dx - friction * tanh(dx / friction)`.
- Release decides open/closed: a **leftward flick** faster than
  `ORGANIZER_SWIPE_VELOCITY` (**400 px/s**) closes even on a small distance;
  otherwise snap to whichever side the drawer is more than half-way toward.
- Tapping the **scrim** also closes.
- Respect `prefers-reduced-motion` (skip the slide animation), consistent with the
  reduced-motion handling already in the PWA shell.

Implement with CSS transforms (`translateX`) for the slide and a signal for the
drag offset; keep the drawer node mounted during an in-flight drag so the release
handler fires. The two required snapshots are wide-mode, so the drawer isn't in
them — **optionally** add a narrow-viewport snapshot (e.g. 390px) showing the open
drawer + scrim to visually verify this path.

---

## 8. Mocked data + deterministic snapshots

Tests must run with **no backend**. Two pieces:

**(a) Mock the RPC.** In the Playwright spec, intercept the RPC route and fulfill
`query.list` from a fixture:

```ts
await page.route("**/api/rpc", async (route) => {
  const body = route.request().postDataJSON();
  const result = body.method === "query.list" ? QUERIES_FIXTURE : null;
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ jsonrpc: "2.0", result, id: body.id }),
  });
});
```

Keep the fixture (a handful of named queries — reuse names from the egui snapshot
fixtures for familiarity, e.g. "Lemonade", "Deep Cuts", "Workout Mix";
`organizer.rs:1058`) in a shared `tests/visual/fixtures.ts`.

**(b) Seed deterministic initial UI state.** Because open tabs are session state
(not persisted to the backend yet), give the app a **prod-safe seeding seam**:
`src/dev/seed.ts` reads URL params on startup and applies them to the store —
e.g. `?sidebar=open&tabs=Lemonade,Deep%20Cuts` opens the sidebar and opens two
tabs. It is a no-op when the params are absent, so it never affects production.
The Playwright specs navigate to a seeded URL; the RPC mock supplies the matching
saved-query list. (Alternative: drive state by clicking rows — more fragile; the
seed approach is preferred for stable snapshots.)

**The two required snapshots** (viewport **1280×800**, `reducedMotion: "reduce"`,
`await document.fonts.ready`, `fullPage`), each in **light and dark** — mirror the
existing `app.spec.ts` loop and `snapshotPathTemplate`:

| Name | State | Setup |
|---|---|---|
| `frame-empty-{light,dark}` | no tabs, sidebar closed | default; RPC mock optional |
| `frame-populated-{light,dark}` | sidebar open, two tabs | seed `sidebar=open` + two tabs; RPC mock returns the query list |

For `frame-populated`, the tab **content area is blank** (out of scope) — the
snapshot shows the sidebar (Opened: 2 rows with the active one accent-barred;
Queries: the filtered list; Settings footer) and the tab bar (toggle, 2 handles
with the active one highlighted, "+"). This is the DOM analog of the top-left
region of `whole_app.png`.

Decide whether to keep or delete phase-01's `whole-app-{light,dark}.png`
baselines: they showed the hello-world shell, which this phase replaces. Removing
them (and the `whole app` test) in favor of the two new frame snapshots is
cleanest — call it out in the handoff so it's an intentional baseline change.

> **Agent self-validation (required):** after `bun run test:visual:update`, **open
> every generated PNG with the Read tool** and confirm, in both themes, that the
> sidebar sections, rows, active markers, and tab handles match
> `whole_app.png`'s frame — legible, aligned, correctly themed — before calling
> the phase done. This mirrors the snapshot workflow in `CLAUDE.md`.

---

## 9. Theme tokens & styling

Extend the `@theme`/`@layer base` tokens in `src/app.css` (phase 01 established
`--panel`/`--sheet`/`--ink` with light/dark + `data-theme` overrides). Add tokens
for the new chrome, measuring `whole_app.png` for exact values and cross-checking
`frontend-old-egui/src/theme.rs`:

- `--bar` — tab-bar background (egui `shade(panel, 10)`; a step darker than panel
  in light, a step lighter in dark).
- `--accent` — strong blue `#77A5CE` (`HOVER_BLUE`, same in both themes): active
  tab top edge, active opened-row bar, focused input border.
- `--ink-weak` — secondary/dim text (inactive tab + icon gray, section chrome).
- `--hover` — row/header/handle hover background (egui `HOVER_SHADE`).

Keep styling in **Tailwind utilities** (Prettier's Tailwind plugin sorts classes);
reach for small `@layer components`/arbitrary values only where a utility is
awkward (e.g. the drawer transform, the 4px active top-edge). Continue theming via
the tokens so **no `dark:` variants** are needed. Add **safe-area insets** now that
there's real chrome at the edges (the sidebar/tab bar should respect
`env(safe-area-inset-*)` — phase 01 deferred these).

---

## 10. Validation checklist

Run from `frontend/` (all cheap, all yours to run):

- [ ] `bun run typecheck` — clean (`tsgo`).
- [ ] `bun run lint` — clean; **no `eslint-plugin-solid` reactivity warnings**
      (destructured props, uncalled signals, lost reactivity).
- [ ] `bun run format:check` — clean.
- [ ] `bun run build` — Vite build succeeds; icons inlined (no external icon
      font/URL in `dist`); SW + manifest still emitted.
- [ ] `bun run test:visual` — the new `frame-empty` / `frame-populated` snapshots
      pass against committed baselines (generated via `test:visual:update`).
- [ ] Manually (dev server, wide window): sidebar toggles; opening a query from
      "Queries" adds it to "Opened" and the tab bar; the active tab/row track each
      other; the Queries filter narrows the list; refresh re-fetches; tabs
      drag-reorder.
- [ ] Manually (dev server, narrow window < 500px): the sidebar is a drawer with a
      scrim; it drags with friction, flick-closes, and scrim-tap-closes.
- [ ] Read every generated PNG (§8 self-validation).

The **user's** milestone (as in phase 01): `cargo xtask build-release` then run
`./target/release/radiocrate <collection-path>` against a real collection and
confirm the frame renders with their actual saved queries.

---

## 11. Gotchas & notes

- **SolidJS ≠ React.** The single most common failure mode here is applying React
  habits (destructured props, `count` instead of `count()`, `.map()` in JSX,
  `useEffect`). Read the "Writing SolidJS" block in `CLAUDE.md` before writing
  components; let `bun run lint` catch the rest.
- **Only one runtime dependency.** The icon set is the sole third-party runtime
  library. Swipe and drag are hand-rolled Pointer Events — do **not** add a
  gesture, DnD, router, or state-management library.
- **Icons inline, not fonts.** Keep icons build-time-inlined SVG at `currentColor`
  — a runtime icon **font** would break offline/CSP and drift from the committed
  snapshots.
- **`definition` is opaque.** Don't parse it; this phase only shows query names.
- **Snapshot determinism.** Screenshots are only reproducible in the container CI
  uses (font/GPU). Generate baselines there. Mock the RPC and seed state via URL
  params so nothing depends on a backend or timing.
- **egui source is reference, not a transcription target.** Match the pixels and
  the interactions; structure the Solid code idiomatically (reactive, retained),
  not as a port of immediate-mode draw calls.
- **Reference fixtures:** the egui snapshot tests seed queries named "Lemonade",
  "Deep Cuts", "Workout Mix" (`organizer.rs:1058`); reusing them keeps the new
  images visually comparable to the old ones.
```
