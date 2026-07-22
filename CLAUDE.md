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
backend (e.g. `frontend-old-egui/Cargo.toml`), then go ahead and run cargo
yourself. These builds don't touch `duckdb-sys`, so they're fast. Run, fixing
any errors you notice:

1. `cargo check`
2. `cargo clippy`
3. `cargo fmt`

You may also run the **egui snapshot tests** (`cargo test -p frontend-old-egui`)
to generate and inspect widget snapshots — this is part of the front-end
self-validation workflow and only builds that crate.

**Do not ever run `cargo build`** (I run release/WASM builds myself), and don't
run the full `cargo test` across the workspace — scope test runs to the crate
you're working on (e.g. `-p frontend-old-egui`).

### The production frontend (`frontend/`) is pure JS — cargo rules don't apply

The production frontend in `frontend/` is a **SolidJS SPA with no `Cargo.toml`**,
built with [Bun](https://bun.sh)/Vite. The cargo build-cost rules above don't
apply to it — run its checks freely from `frontend/`:

- `bun run typecheck` (tsgo `--noEmit`)
- `bun run lint` (ESLint + `eslint-plugin-solid`)
- `bun run format:check` (Prettier)
- `bun run build` (Vite → `frontend/dist`)
- `bun run test:visual` (Playwright whole-app screenshots, light + dark)

The retired egui frontend lives in `frontend-old-egui/` (reference only).

## Inspecting widget snapshots

The egui snapshot tests render widgets to PNGs under `frontend-old-egui/tests/snapshots/`.

When I refer to one of these images in a prompt, analyze the image yourself to understand my prompt within the context of that UI before doing any work. Then, after you make your code changes, validate your work by generating new images and analyzing them. Use your best judgement to determine whether the resulting images fulfil the requirements set fort in the prompt.

When you need to *look at* or *measure* one, don't fumble with `convert txt:` dumps or assume Pillow is missing — the container has tooling for this (see DEVELOPMENT.md, "Inspecting & measuring a failure"):

- **What changed?** A failure leaves `<name>.diff.png` next to the baseline — open that first. `scripts/snapshot_composite.sh <baseline.png>` stitches `old | diff | new` into one strip.

- **Measure to the pixel** (margins, symmetry, boundaries): `scripts/measure_snapshot.py <png> [--row N] [--col N]`. It bakes in the conventions — **PPP = 2** (images are 2× logical size), an **8 logical-px harness margin** around the cropped content, resting border gray **`#C8C8C8`** — so you don't re-derive them, and classifies pixels as background/border/fill/content.

- `python3` has **Pillow + NumPy** preinstalled, so `from PIL import Image` works if you'd rather read pixels directly.

Regenerate _all_ visual snapshots, not just the ones pertaining to your work. This helps us identify regressions.

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

