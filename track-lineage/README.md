# track-lineage

A tiny WASM binding over [`polyglot-sql`](https://crates.io/crates/polyglot-sql)
that answers one question the query-results grid needs: **which base-table
columns does each output column of a compiled query trace back to?**

The frontend interprets that mapping against the introspected schema to decide
what a result row *is* — a row carrying `track.id` is a track (double-click to
play), and a row carrying some table's whole primary key is a record of that
table (right-click to edit). See `frontend/src/query/lineage.ts`.

The analysis is the one the egui frontend ran in
`frontend-old-egui/src/lineage.rs`; only the question asked of it moved out here
(the name predates the generalization).

## Why this crate exists

The published npm bindings, `@polyglot-sql/sdk`, ship **one full WASM build with
all 30+ SQL dialects and every feature** (~22 MB). We use a sliver of that: the
`semantic` lineage analysis for a single dialect. Building the crate ourselves
with `default-features = false` — matching the egui build's feature set — drops
the wasm to **~1.9 MB (≈560 KB gzipped)**, in the same ballpark as the vendored
`querydown-js`.

## Building

```sh
rustup target add wasm32-unknown-unknown   # once
./build.sh
```

`build.sh` runs `wasm-pack build --target web` and copies the output into
`frontend/vendor/track-lineage/`, which the frontend imports as the
`track-lineage` package (see `frontend/src/query/lineage.ts`). That output is a
build artifact, not source — it's gitignored, so re-run `build.sh` after any
change here (and on a fresh checkout, before building the frontend).

This crate is a **standalone cargo workspace** (note the empty `[workspace]`
table in `Cargo.toml`): it is intentionally not a member of the app's root
workspace, so it never participates in — or triggers a rebuild of — the backend's
DuckDB toolchain, and only ever compiles for wasm.
