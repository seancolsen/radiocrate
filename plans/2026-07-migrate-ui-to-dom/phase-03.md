# Phase 03 — Run a saved query, end to end (crude) (DOM/SolidJS)

## Where this fits (read first)

We are migrating RadioCrate's frontend from an **egui/eframe WASM canvas** app to
a **web-native SolidJS DOM** app, rebuilding the UI **from the outside in** — the
outermost chrome first, then working inward. Prior phases:

- **Phase 01 (done — [`phase-01.md`](phase-01.md)):** moved the egui app to
  `frontend-old-egui/` (read-only reference) and stood up a fresh SolidJS SPA in
  `frontend/` (Bun/Vite/Tailwind v4/ESLint+solid/Prettier/tsgo/Playwright).
- **Phase 02 (done — [`phase-02.md`](phase-02.md)):** built the app **frame** —
  the explorer sidebar (Opened + Queries sections, saved queries from
  `query.list`) and the tab bar (drag-reorder, mobile drawer). An open tab's
  content area is a **blank panel**. State lives in a `createStore` behind
  `useAppState()` ([`src/state/store.tsx`](../../frontend/src/state/store.tsx));
  the RPC client is [`src/api/rpc.ts`](../../frontend/src/api/rpc.ts); icons are a
  semantic map in [`src/icons.ts`](../../frontend/src/icons.ts). Tabs carry only
  `{ id, name }`; `definition` was treated as **opaque**.
- **Phase 03 (this plan):** fill the blank tab with the crudest possible working
  **query run**: a toolbar holding **only a refresh button**, and a results pane
  that renders the returned rows as **unformatted plain text**. The point is to
  prove the whole `definition → SQL → results` pipeline works end to end in the
  DOM app. Nothing about it needs to be pretty.

The `frontend-old-egui/` crate remains the **behavioral/visual source of truth**;
port behavior, not its immediate-mode Rust structure. Cited `file:line`
references point into it (and, for Querydown, into the pinned `querydown` repo —
see §2).

### Stack recap (unchanged from phase 01/02)

SolidJS (**not React** — see the "Writing SolidJS" block in
[`CLAUDE.md`](../../CLAUDE.md)) · Bun · Vite + `vite-plugin-solid` · Tailwind v4 ·
`tsgo`/ESLint(+`eslint-plugin-solid`)/Prettier · Playwright full-page snapshots
(light + dark) under `frontend/tests/visual/__screenshots__/`.

The `frontend/` app is **pure JS — no `Cargo.toml`.** This phase keeps it that
way: **RadioCrate authors no Rust/WASM of its own** (see §2 for why). The one new
compiled dependency, the Querydown compiler, is consumed as a **prebuilt JS
package** — a normal `bun add`. So the Bun/Vite/lint/test commands remain yours to
run freely, and **no `duckdb-sys` / cargo build-cost rules apply to this phase.**

---

## Goal & scope

Fill an open tab with a working, deliberately crude query run.

### Do

1. **Run a saved query against the query API**, in the most crude way possible:
   flatten the tab's saved query `definition` to Querydown source, compile it to
   SQL (Querydown JS binding — §2), `POST` the SQL to the query API, decode the
   Arrow result, and show it.
2. **Query-page toolbar:** render **only a refresh button** that runs the query
   *as it was saved*. Do **not** build any other toolbar control (no wrench /
   Filter / Sort / Display / "N results" / options `⋮`).
3. **Results pane:** render the result set as **plain text, no formatting** —
   **join fields in a row with a single space**, **join rows with a newline**.
   That's the whole renderer. The point is only to prove data flows through.

### Do NOT

- Build any **query-editing** UI (query input, builder, sections, presets editor,
  inline rename, context menus). Only the refresh button runs the saved query.
- Reproduce the **old results view** (the columnar grid, artist pills, star
  ratings, selection, virtualization, the now-playing row marker). Plain text only.
- Add **error handling** or an error UI. If compile/fetch/decode fails, it's fine
  to render nothing and `console.error`. (See non-goals.)
- Add a **graceful empty state** for zero results. Zero rows → empty text is fine.
- Do any **SQL analysis to find primary-key columns** in the result set (the old
  app needed the PK to locate the now-playing row; we render dumb text, so skip it).
- Author a **RadioCrate-side WASM crate**, or use the `columnAnnotations` the
  compiler returns (we render text — the SQL is all we need).
- Touch playback, the now-playing bar, presets UI, keybindings, the command
  palette, Settings behavior, or the record editor — all later phases.

---

## The pipeline reality (why this phase has real depth)

The query API is **dumber than it looks** — it runs SQL, nothing more — which
pushes the interesting work into the frontend. One run, end to end:

1. **Saved query → structured definition.** `query.list` returns each query's
   `definition` as an **opaque JSON string** (phase 02 left it untouched). It
   deserializes to a small, plain struct (`QueryDefinition`,
   `frontend-old-egui/src/query_def.rs:136`): `base`, a `filter`
   (`{ custom, presets[] }`), a `sort` and `display` (each Custom text / a preset
   ref / a builtin), and an optional `full` hand-written override.
2. **Definition → sections (or source).** `assemble` (`query_def.rs:233`) resolves
   the struct into either **per-section Querydown fragments** (base + filter + sort
   + display — the builder default) or, for a `full`-mode query, a single source
   string. Preset references resolve against the saved presets and the one builtin
   (`Shuffle`) is expanded. **This is pure string manipulation — no compiler, no
   schema.**
3. **Sections/source → DuckDB SQL.** Run the **Querydown compiler** against a
   **schema JSON**, supplying a hard-coded **PRELUDE** of RadioCrate's
   computed-column definitions (`frontend-old-egui/src/compile.rs:22`) as the
   `definitions`. Sectioned queries go through the binding's `compile_sections`
   (section-isolated parsing); `full`-mode queries through `compile` with the
   PRELUDE prepended. *This is the only step that needs Querydown's compiler* —
   provided by its JS binding (§2).
4. **Schema JSON.** Run RadioCrate's introspection SQL
   (`introspection::introspection_sql()`, a static 60-line query in
   `introspection/resources/duckdb.sql`) through the *same* query API, take the
   single returned JSON cell, then apply RadioCrate's convention-based link
   inference (`introspection::add_inferred_links`, `introspection/src/lib.rs:147`).
   That enriched JSON is what step 3 feeds the compiler. **Why not the compiler's
   own `introspection_sql`?** RadioCrate declares **no foreign keys** (DuckDB
   can't update FK-referenced rows), so a stock introspection finds no links; the
   inference (a `UUID` column named after a table links to that table's `id`)
   recovers them. This logic is RadioCrate's, not Querydown's.
5. **SQL → rows.** `POST {BASE}/query` with the **raw SQL string as the request
   body** (not JSON). The backend (`backend/src/server.rs:123`, `async fn query`)
   does `conn.prepare(&body)` + `query_arrow` and streams **Arrow IPC**
   (`content-type: application/vnd.apache.arrow.stream`); a bad SQL string returns
   `400` with the DuckDB error as plain text.
6. **Arrow → text.** Decode the Arrow IPC into rows/columns and stringify cells.

The good news (see §2): steps **2 and 4 are tiny and portable to TypeScript**, and
step **3 is exactly what the Querydown JS binding already does**. So this phase
needs **no RadioCrate Rust** at all.

---

## 1. The query API (already exists — do not modify)

- **Saved queries / presets:** JSON-RPC at `POST /api/rpc` (phase 02's
  `rpcCall`). This phase also needs **`preset.list`** (`backend/src/rpc.rs:215`)
  so preset references in a definition can be resolved. Each preset is
  `{ id, name, base_table, section, definition, … }`; only `id` and `definition`
  matter here (the fragment text a `presets[]`/preset-ref resolves to).
- **Running SQL:** `POST /api/query`, **body = the raw SQL string**, response =
  **Arrow IPC stream** (or `400 text/plain` on a SQL error). Same-origin `/api`
  in prod; phase 02 already added the dev proxy to `:3000`.

Do not change the backend. (It would also edit `backend/Cargo.toml` and trip the
>20-min `duckdb-sys` rebuild rule in [`CLAUDE.md`](../../CLAUDE.md).)

---

## 2. The Querydown compiler: consume `querydown/bindings/js`

Querydown (the user owns it; repo `github.com/seancolsen/querydown`) **ships a JS
binding** at `bindings/js` (`querydown-js`, a `wasm-bindgen` `cdylib`). It was just
polished into a first-class JS dependency (commit **`aa4c06c`** on `main` — see its
[`bindings/js/README.md`](https://github.com/seancolsen/querydown/blob/main/bindings/js/README.md)).
Current surface — note `compile`/`compile_sections` return a **typed object**, and
errors **throw**:

```ts
introspection_sql(dialect: string): string
compile(schemaJson: string, dialect: string, input: string): CompileResult
compile_sections(schemaJson, dialect, baseTable, definitions, conditions, sorting, display): CompileResult
// interface CompileResult { sql: string; columnAnnotations: (AnnotationValue | null)[] }
```

- **`compile`** parses **whole-query Querydown source** and returns
  `CompileResult`. RadioCrate calls `compile(schemaJson, "duckdb", PRELUDE + "\n" +
  source)` and reads `result.sql` **directly** (it's a real object now — no
  `JSON.parse`). `columnAnnotations` is ignored (we render text).
- **`compile_sections`** parses each query section with its own parser (so filter/
  sort/display syntax can't leak across boundaries) and returns the same
  `CompileResult`. This is the faithful analog of what the egui app did for
  builder-authored (sectioned) queries — RadioCrate uses it for the common case
  (see §3.1/§3.3).
- RadioCrate does **not** use the binding's `introspection_sql` (it needs its own
  FK-inference — see step 4 / the FK note above).

So **RadioCrate builds no compiler WASM crate of its own.** It consumes
`querydown-js`, built from git.

### 2.1 How RadioCrate consumes the binding — build from git (npm publish deferred)

The maintainer is not publishing to npm yet. RadioCrate builds the binding from a
**pinned Querydown revision** — pin to **`aa4c06c`** (the commit carrying the
first-class-dependency polish), not the older `da0e7d0` the reference
`frontend-old-egui` crate uses. Follow the binding's README exactly:

- Build with **`wasm-pack build bindings/js --target web`** (emits an ES-module
  package to `bindings/js/pkg/`: `.js` entry, `querydown_js.d.ts` with full types,
  the `.wasm`, and a `package.json`). Point `frontend/`'s dependency at that `pkg/`
  directory (Bun can depend on a local path; or vendor/copy it under `frontend/`).
- **Import + init (Vite, per the README):**
  ```ts
  import init, { compile, compile_sections } from "querydown-js";
  import wasmUrl from "querydown-js/querydown_js_bg.wasm?url"; // Vite serves it same-origin
  await init(wasmUrl); // once at startup (or gate first use behind a `wasmReady` signal)
  ```
  Same-origin `.wasm` → **CSP/offline-safe, no external fetch**. (The `bundler`
  target is the alternative; it needs `vite-plugin-wasm` + `vite-plugin-top-level-await`.
  Prefer `web`.)
- **Dev loop:** `pkg/` is a build artifact — **gitignore it** wherever it lands
  under `frontend/` and (re)generate via `wasm-pack`. Building it needs the Rust +
  `wasm-pack` toolchain + network to fetch Querydown (one-time; unrelated to
  `duckdb-sys`, so safe for the agent to run — it is *not* a backend/duckdb build).
- **Production:** wire the `wasm-pack build` step into `cargo xtask build-release`
  **ahead of** `bun run build`, so Vite bundles the freshly-built package into
  `frontend/dist`. (Editing `xtask/src/*.rs` is cheap; do **not** run
  `build-release` yourself — that's the user's milestone.)

> The `querydown-changes.md` plan that requested this polish has been **implemented
> and removed**; this phase only *consumes* the result. Do not modify the Querydown
> repo from RadioCrate.

---

## 3. RadioCrate-side glue, ported to TypeScript (no Rust)

Three small pure-logic pieces move into `frontend/src/`. All are stringly-typed
and easy to unit-test.

### 3.1 Definition → sections/source (`src/query/definition.ts`)

Port from `frontend-old-egui/src/query_def.rs`. The stored definition has two
modes (sectioned — the builder default — and a `full` hand-written override);
resolve each into the shape the matching binding entry wants (§3.3).

- The `QueryDefinition` shape and the `SectionContent` union
  (`Custom(text) | Preset(id) | Builtin(Shuffle{seed})`), matching the stored
  JSON exactly (this is what `query.list`'s `definition` string deserializes to).
- `fromStored(raw)` — `JSON.parse` (the legacy raw-Querydown split at
  `query_def.rs:186` is a one-time migration nicety; **skip it** for crude — a
  parse failure just means no results).
- `assemble(def, presets)` — port `query_def.rs:233`, returning a discriminated
  result:
  - **full mode** (`full` set) → `{ kind: "full", text }`.
  - **sectioned mode** → `{ kind: "sections", base, filter, sort, display }`,
    where `filter` = `custom` + each referenced preset's `definition`
    (newline-joined), and `sort`/`display` each resolve their `SectionContent`
    (preset ref → the preset's `definition`; builtin `Shuffle{seed}` →
    `\\id|concat('<seed>')|md5`, `query_def.rs:99`).
- The **PRELUDE** constant — copy the string verbatim from `compile.rs:22`.

> Using `assemble` (not the flatter `to_full_query`) lets sectioned queries go
> through `compile_sections`, preserving the section-isolation the egui app had.
> If you want the *absolute crudest* single path instead, port `to_full_query`
> (`query_def.rs:270`, flattens both modes to one string) and always call
> `compile` — accept that filter/sort/display syntax is no longer isolated. The
> `assemble` + `compile_sections` path is recommended now that the binding
> provides it.

### 3.2 Introspection + link inference (`src/query/schema.ts`)

Port from `introspection/`:

- The introspection SQL — copy `introspection/resources/duckdb.sql` in as a string
  constant (it's static). *(Optional: import it at build time rather than pasting.)*
- `addInferredLinks(rawJson)` — the ~20-line inference (`introspection/src/lib.rs:147`
  + `infer_links`): parse JSON, collect table names, and for every column whose
  type is `UUID` (case-insensitive) **and** whose name is a table name, emit
  `{ from:{table,column}, to:{table:column, column:"id"}, unique:false }`; replace
  the document's `links` array; re-serialize. Preserve all other fields verbatim
  (the compiler ignores RadioCrate's extra nullability/unique metadata).

> **Drift note (flag for the user):** `add_inferred_links` deliberately lives in
> the shared `introspection` crate so the frontend and the backend's DML validator
> don't diverge. Porting it to TS reintroduces a second copy. It's tiny and the
> FK-by-convention rule is stable, so the risk is low — mitigate with a TS unit
> test mirroring the Rust test's `SAMPLE` fixture (`introspection/src/lib.rs`
> tests). **Alternative to eliminate the drift entirely:** keep one small
> `introspection`-only WASM shim (the crate is already WASM-clean — serde only, no
> DuckDB, no Querydown) exposing `introspection_sql()` + `enrich_schema()`, and
> skip the TS port. Recommend the TS port for this crude phase; note the shim as
> the drift-proof option.

### 3.3 Compile glue (`src/query/compile.ts`)

Tie it together: `compileSavedQuery(def, presets, schemaJson) → sql` branches on
the `assemble` result (§3.1) and reads `.sql` off the returned `CompileResult`
(a real object — no `JSON.parse`):

```ts
const a = assemble(def, presets);
const r =
  a.kind === "full"
    ? compile(schemaJson, "duckdb", `${PRELUDE}\n${a.text}`)
    : compile_sections(schemaJson, "duckdb", a.base, PRELUDE, a.filter, a.sort, a.display);
return r.sql; // compile* throw on failure — fine, no error UI this phase (§ non-goals)
```

---

## 4. Arrow decoding + the crudest fetch (`src/api/query.ts`)

Add **`apache-arrow`** (npm runtime dep) to decode the IPC stream. Crudest
possible: **don't stream** — buffer the whole response, then decode.

```ts
import { tableFromIPC } from "apache-arrow";

export async function runSql(sql: string) {
  const res = await fetch("/api/query", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: sql,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return tableFromIPC(new Uint8Array(await res.arrayBuffer()));
}
```

Render (the entire results view): iterate the table's rows; for each, read cell
values in column order, `String(value)` (null/undefined → `""`; Arrow list cells
stringify as their JS array — fine, crude), **join a row's fields with a single
space**, **join rows with `"\n"`**, drop into a `<pre>`. No headers, no column
metadata, no formatting.

> Runtime deps added this phase, both demanded by the goal: **`querydown-js`**
> (compile) and **`apache-arrow`** (decode). Add nothing else (no DnD/gesture/
> router/state libs).

---

## 5. State & data flow (`src/state/store.tsx`)

Extend the phase-02 store; keep it small and typed. Solid reactivity rules from
[`CLAUDE.md`](../../CLAUDE.md) still bind (never destructure the store; read
signals as `value()`; `<For>`/`<Show>` not `.map()`/ternaries).

- **Tabs carry the definition now.** Add `definition: string` to `Tab` (and the
  `openTab` argument). `QueryRow`'s `openTab` already has the full `Query` in scope
  — pass `definition` through. (Phase 02's URL seed opens tabs by *name*; a seeded
  name that matches a fixture query gets that query's `definition`; unmatched
  synthetic tabs get `""` and simply produce no results — acceptable.)
- **Schema resource (cached once).** A `createResource` that runs the introspection
  SQL through `runSql`, reads the single JSON cell, and passes it to
  `addInferredLinks`. Cache the enriched JSON for the session; every compile reuses
  it.
- **Presets resource.** A `createResource` over `rpcCall("preset.list")` for the
  flatten step. (Fine to be `[]` until it resolves; queries referencing presets
  just won't compile until then.)
- **Per-tab results.** Keyed by tab id — e.g. `resultsByTab: Record<string,
  string>` (+ optional `runningByTab`; errors are console-only per non-goals). A
  new action:

  ```
  runQuery(tabId): compileSavedQuery(def, presets, schema) → runSql
                   → stringify to text → store under resultsByTab[tabId].
  ```

  Wire it to the toolbar refresh button, and also call it **once when a tab is
  first viewed** (opening a query shows rows without a manual click); a simple
  "have I run this tab yet" guard suffices. Keep it crude — no polling, no
  streaming, no cancellation/debounce. Ensure the Querydown module is initialized
  before the first compile/schema use.

---

## 6. The query page (replaces the blank `TabContent`)

Phase 02's `TabContent` is a blank panel in `App.tsx`. Replace it with a
`QueryPage` for the active tab:

- **Toolbar** (`components/QueryToolbar.tsx`): a thin horizontal bar under the tab
  bar, styled on the results-toolbar surface (measure `whole_app.png`; reuse the
  phase-02 chrome tokens). It contains **exactly one control**: a **refresh
  button** (icon `Refresh` — already in `src/icons.ts`; egui uses the same glyph
  for "run") calling `store.runQuery(activeTabId)`. Leave the rest empty — no
  wrench, Filter/Sort/Display, `⋮`, or "N results".
- **Results** (`components/QueryResults.tsx`): a scrollable `<pre>` (monospace,
  `overflow-auto`) showing `resultsByTab[activeTabId] ?? ""`. Nothing else.

Render `QueryPage` only when there is an `activeTabId`; with no tab open, keep the
blank panel from phase 02.

---

## 7. Mocked data + deterministic snapshots

Tests still run with **no backend** and **no compile/Arrow work in the browser** —
mock at seams so snapshots stay deterministic.

- **Keep the phase-02 frame snapshots** (`frame-empty`, `frame-populated`,
  `frame-drawer`) — they still describe the chrome. `frame-populated`'s tab content
  is now a query page; empty results text under the RPC mock is fine (or seed it,
  below). Regenerate all baselines and re-inspect.
- **Add one results snapshot** (`query-results-{light,dark}`, 1280×800,
  `reducedMotion: "reduce"`, `fonts.ready`, `fullPage`) proving the plain-text
  renderer + refresh toolbar. **Prefer a results-injection seed** over exercising
  the real compile/Arrow path in Playwright: extend `src/dev/seed.ts` with a param
  (e.g. `?results=<encoded text>`) that drops canned text straight into the active
  tab's `resultsByTab`, bypassing Querydown/`/api/query` entirely. Fast,
  deterministic, and it still verifies the exact rendering rule (space-joined
  fields, newline-joined rows). Mock `/api/rpc` (query.list + preset.list) as in
  phase 02.
- Mirror the existing `app.spec.ts` light/dark loop and `snapshotPathTemplate`.

> **Agent self-validation (required):** after `bun run test:visual:update`, **open
> every generated PNG with the Read tool** and confirm the toolbar shows the single
> refresh button and the results text renders as expected, in both themes.

---

## 8. Validation checklist

Run from `frontend/` (JS side — all cheap, all yours):

- [ ] `bun run typecheck` / `bun run lint` (no `eslint-plugin-solid` reactivity
      warnings) / `bun run format:check` — clean.
- [ ] `bun run build` — Vite bundles `querydown-js` (its `.wasm`) + `apache-arrow`;
      no external fetches in `dist` (CSP/offline-safe); SW + manifest still emitted.
- [ ] `bun run test:visual` — `query-results` passes against fresh baselines; the
      frame snapshots still pass (regenerate them).
- [ ] `wasm-pack build bindings/js --target web` on Querydown at `aa4c06c`
      succeeds and the generated `pkg/` imports + `init()`s in the app. (Not a
      DuckDB build.)
- [ ] Read every generated PNG (§7 self-validation).
- [ ] *(recommended)* a TS unit test for `addInferredLinks` mirroring the Rust
      `SAMPLE` fixture, guarding the ported inference against drift.

Manual, against a **real backend** (`cargo run -p backend -- <music-path>`, dev
server, wide window) — the actual proof this phase exists to deliver:

- [ ] Open a real saved query from the sidebar → its rows appear as plain text
      (fields space-joined, rows newline-joined).
- [ ] The toolbar **refresh** button re-runs the query and refreshes the text.
- [ ] Introspection runs once and is reused across queries.

**User QA milestone** (as before): `cargo xtask build-release` (now also runs
`wasm-pack build bindings/js`) then `./target/release/radiocrate <collection-path>`
→ open a query and confirm real results render.

---

## 9. Gotchas & notes

- **The backend runs SQL, full stop.** All Querydown→SQL work is the frontend's;
  `/api/query`'s body is a **raw SQL string** and its response is **Arrow IPC**.
- **No RadioCrate Rust/WASM this phase.** The compiler comes from Querydown's
  `bindings/js` (built from git at `aa4c06c`) as a prebuilt JS package; the rest
  (assemble, link inference, decode, render) is TypeScript. So **no
  `duckdb-sys`/cargo build-cost rule applies**, and you never touch
  `backend/`/top-level `Cargo.toml`. Do not run `cargo xtask build-release`
  yourself — that's the user's milestone.
- **`compile`/`compile_sections` return an OBJECT and THROW.** Read `result.sql`
  directly (no `JSON.parse` — that was the pre-`aa4c06c` behavior). A compile
  failure throws; catch-and-`console.error` is fine (no error UI — non-goals).
- **Pin the Querydown rev deliberately.** RadioCrate builds the binding at
  `aa4c06c`; the reference `frontend-old-egui` crate still pins the older
  `da0e7d0`. Keep RadioCrate's compiler rev consistent with what its schema/PRELUDE
  expect so compiled SQL behavior stays stable.
- **Introspection inference — decide (§3.2).** TS port (recommended, tiny; add the
  drift-guard unit test) vs. a tiny `introspection`-only WASM shim (drift-proof).
  Everything else is settled.
- **Schema shape compatibility.** RadioCrate's enriched introspection JSON is what
  the compiler's `Compiler::new(schema_json, …)` consumes (RadioCrate's
  introspection began as a copy of Querydown's and preserves that shape). If
  Querydown's expected schema shape ever changes, the introspection crate **and**
  the TS port must track it.
- **Crude is the spec, not a shortcut to apologize for.** No error UI, no empty
  state, no PK analysis, no streaming, no formatting, no `columnAnnotations` — all
  explicit non-goals. Resist reintroducing the old results grid.
- **Presets matter for compilation.** `assemble` resolves preset references; fetch
  `preset.list` and pass it in, or queries that use presets won't compile.
- **`definition` is no longer opaque** — this is the phase that decodes it, in
  TypeScript (`fromStored` = `JSON.parse`), and resolves it to sections/source.
- **egui source is reference, not a transcription target.** Port `assemble` / the
  PRELUDE / `add_inferred_links` faithfully as small TS functions; ignore the rest
  of the immediate-mode machinery.
- **Reference fixtures:** saved-query names "Lemonade" / "Deep Cuts" /
  "Workout Mix" (phase 02's `frontend/tests/visual/fixtures.ts`;
  `organizer.rs:1058`) — reuse for continuity.
```
