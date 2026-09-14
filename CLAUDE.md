## Validation

Check your uncommitted changes to see whether you've modified any `Cargo.toml`
or `Cargo.lock` files, and if so, *which* ones.

### When a build is expensive (don't run cargo yourself)

If you've modified the **top-level `Cargo.toml`** or **`backend/Cargo.toml`**,
do not run any cargo commands yourself — not even `cargo check`. Changing
dependencies at these levels can force a rebuild of `duckdb-sys`, which can take
over 20 minutes. Stop your work and prompt me to run the cargo commands myself.

### Otherwise (builds are cheap — run cargo yourself)

If you've made no Cargo changes, or only changed Cargo files *outside* the
backend (e.g. `xtask/Cargo.toml`), then go ahead and run cargo yourself. These
builds don't touch `duckdb-sys`, so they're fast. Run, fixing any errors you
notice:

1. `cargo check`
2. `cargo clippy`
3. `cargo fmt`

**Do not ever run `cargo build`** (I run release/WASM builds myself), and don't
run the full `cargo test` across the workspace — scope test runs to the crate
you're working on.

### The production frontend (`frontend/`) is pure JS — cargo rules don't apply

The production frontend in `frontend/` is a **React SPA with no `Cargo.toml`**,
built with [Bun](https://bun.sh)/Vite. The cargo build-cost rules above don't
apply to it — run its checks freely from `frontend/`:

- `bun run typecheck` (tsgo `--noEmit`)
- `bun run lint` (ESLint + `eslint-plugin-react-hooks`, React Compiler rules included)
- `bun run format:check` (Prettier)
- `bun run test:unit` (Vitest)
- `bun run build` (Vite → `frontend/dist`)
- `bun run test:visual` (Playwright component screenshots, light + dark)

### Writing visual snapshot tests

Snapshots render **one component at a time**, through the component harness at
`frontend/src/dev/harness/`. To add one:

1. Add a story to `src/dev/harness/stories.tsx` — the component, the props
   or store state it's about, and the size of the stage it sits on. The harness
   serves it at `/harness.html?story=<id>` over a stubbed backend
   (`src/dev/harness/mockApi.ts`), so a story needs no route mocking.
2. Add a test to the matching spec (`shell` / `query` / `record`) that calls
   `openStory(page, id, colorScheme)` and shoots the returned stage — or the
   dialog/menu, for a component that renders through a portal.

Baselines live under `tests/visual/__screenshots__/<light|dark>/<story>.png`, so
the story id *is* the snapshot path. Keep it hierarchical
(`filter-builder/preset-expanded`).

Avoid whole-app snapshots: `app.spec.ts` holds the only two, and they're about
the frame itself. An overabundance of full-viewport snapshots creates undue
churn. If a story can only reach its state by chaining interactions against a
stand-in backend, that's a sign it wants an end-to-end test against a real one
instead — don't force it into a snapshot.

Behavioral (non-screenshot) Playwright specs still drive the assembled app
through the URL-param seam in `src/dev/seed.ts` (`?expose=1` puts a store
facade on `window.__appStore`).

## Writing React

The `frontend/` app is **React 19** under `StrictMode`, with the React Compiler
enabled for `src/`. State lives in **vanilla Zustand stores with Immer**
(`src/stores/`), built once outside React by `createStores()` and handed down
by `<StoresProvider>`. The design is in
`specs/2026-09-react-migration/plan.md` ("State management"); these are its
rules.

### Stores

- **Actions are stable and live outside state.** Never put functions in state
  and never select them. Get them from `useAppActions()` (and
  `useCommandActions` / `useFormsActions` / `useUpdateActions`).
- **A selector returns a primitive, a reference already in state, or a shared
  constant** (`EMPTY_SELECTION`, …). A selector that builds a new array or object
  must be wrapped in `useShallow`, or computed in the component with `useMemo`
  over narrower selections — otherwise it re-renders on every store write.
  Selectors are pure functions in `selectors.ts`; call them inside
  `useApp((s) => selectX(s, …))`.
- **Never subscribe to whole state** (`useApp((s) => s)`). When a list's rows
  each need their own reads, give the row its own component so one row's change
  doesn't re-render the list.
- **Actions read `get()` after every `await`,** never a value captured before it.
  Keep the existing run/load tokens.
- **Gesture actions run synchronously in the event handler.** Never route "play"
  through "set state → effect": iOS ties audio permission to the gesture's call
  stack.
- **`stores/` never imports React** except `stores/react.tsx` (lint-enforced),
  and the framework-free modules (`query/`, `commands/`, `api/`, `audio/`,
  `grid/`, `record/`, `state/`) import neither React nor a store.
- **Environment access is injected** through `AppEnv` (`stores/env.ts`) so store
  tests run in plain vitest with fakes.
- Immer makes every write a new reference along its path, so "replace, don't
  merge" is the default. `QueryResult` is a class instance and passes through
  undrafted; selection `Set`s are replaced wholesale, never mutated. Use
  `castDraft` when assigning a `readonly` array into a draft.
- Cross-store rules ("when a tab closes, drop its forms") are subscriptions in
  `createStores()`, not effects in components.

### Components and effects

- **Effects are for synchronizing with something outside React** (a canvas, a
  DOM listener, an observer, focus). State → state consistency belongs in an
  action or a `createStores()` subscription.
- **Imperative objects are fed by `store.subscribe`, not by renders.**
  `QueryResults` is the model: one layout effect creates the `CanvasGrid`, and a
  tab-keyed effect subscribes it to state with `fireImmediately`.
- **StrictMode double-invokes** renders, initializers and effects in dev. No
  fetch, timer or subscription starts in render or a `useState` initializer;
  every `addEventListener` / `subscribe` returns its cleanup; registrations use
  sets or per-entry counts, never a bare `++`/`--`.
- **Use `useLayoutEffect` when focus or measurement must happen before paint**
  (an input focusing on mount, a width read for first layout).
- **"Read once for this instance's life"** is a `useState(() => …)` initializer,
  with the parent supplying a `key` so a new subject gets a new instance. A
  conditionally shown dialog with mount-time behavior (autofocus, a one-time
  seed) needs its own body component, not an early return.
- **Lists use `.map` with a stable `key`** (an id, never the index when rows can
  move).
- **Lint idioms** (`react-hooks` recommended, React Compiler rules):
  - Don't write `ref.current = x` in render. Sync a "latest value" ref from its
    own `useEffect`.
  - Don't `setState` synchronously in an effect body. Seed the state instead, or
    set it from a later callback.
  - A component that hands its DOM node to a caller uses `forwardRef`, not a
    custom ref-shaped prop.
- **`className`, not `class`.** Conditional classes go through `cx()`
  (`components/ui/cx.ts`). Styling is Tailwind utilities (Prettier sorts them).
  A custom "extend my classes" prop is also named `className`.
- **Icons are components:** `<Icons.Edit className="…" />` from `src/icons.tsx`.
- **Portals** are `createPortal(…, document.body)`. React focus events bubble
  through portals, so a form that must ignore focus moving into its own portaled
  menu listens with a native `focusout` listener.
