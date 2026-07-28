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

The production frontend in `frontend/` is a **SolidJS SPA with no `Cargo.toml`**,
built with [Bun](https://bun.sh)/Vite. The cargo build-cost rules above don't
apply to it — run its checks freely from `frontend/`:

- `bun run typecheck` (tsgo `--noEmit`)
- `bun run lint` (ESLint + `eslint-plugin-solid`)
- `bun run format:check` (Prettier)
- `bun run build` (Vite → `frontend/dist`)
- `bun run test:visual` (Playwright whole-app screenshots, light + dark)

### Writing visual snapshot tests

Avoid creating new snapshots which render the entire app unless you're building a feature that affects top-level behavior or layout. (An overabundance of full-viewport snapshots creates undue churn on these visual tests.) Instead, isolate the UI you're building into a component-specific snapshot test so that you capture a rendering of it without seeing unrelated features.

## Writing SolidJS (not React)

The `frontend/` app is **SolidJS**. Its JSX resembles React but the semantics
differ — violate these and reactivity silently breaks:

- **Components run once.** The function body is setup, not a render loop; don't
  put per-update logic in it or expect it to re-run.
- **Never destructure `props`** (or a store) — that reads the value once and
  loses reactivity. Access `props.foo` at the point of use; reach for
  `splitProps` / `mergeProps` when you must split or default props.
- **Signals are getter functions:** read them as `count()`, not `count`.
- **No dependency arrays.** `createEffect` / `createMemo` auto-track the signals
  they read. Use those plus `onMount` / `onCleanup` — never `useEffect` /
  `useState` / `useMemo`.
- **Use control-flow components in JSX** — `<For>`, `<Show>`, `<Switch>` /
  `<Match>`, `<Index>` — instead of `.map()` and ternaries, so updates stay
  keyed and fine-grained.
- **The attribute is `class`, not `className`;** use `classList={{…}}` for
  conditional classes. Styling is Tailwind utilities (Prettier sorts them).
- Keep signal reads inside a tracking scope (JSX, or an effect/memo); reading a
  signal in plain top-level code won't update.
- Prefer Solid primitives: `createSignal`, `createStore`, `createEffect`,
  `createMemo`, `createResource`.

`eslint-plugin-solid` enforces several of these — `bun run lint` catches
destructured props, uncalled signals, and lost-reactivity patterns.

