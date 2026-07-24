# api-client

The generated TypeScript client for RadioCrate's backend API. A sibling of
`frontend/` and `backend/`, consumed by the frontend via the `"api-client"`
import alias (see `frontend/vite.config.ts` and `frontend/tsconfig.json`).

**Everything under `src/` is generated — do not edit by hand.** The single source
of truth is the [`api-schema`](../api-schema) Rust crate, which both the backend
(`backend/src/rpc.rs`) and this client are derived from, so they can't drift.

The Rust code is `snake_case`; the wire is `camelCase`. The server does the
translation via serde `#[serde(rename_all = "camelCase")]` on the DTOs, so this
client speaks the wire types directly and does **no** case conversion of its own.

## Regenerating

```sh
cargo xtask gen-api
```

Run this after changing any wire type or method in `api-schema`, then commit the
result. The command is idempotent — a second run produces no diff.

## What's here

- `types.ts` — the wire types as camelCase TS interfaces (from `ts-rs`), plus the
  `Dml*` / `JsonValue` types.
- `rpc.ts` — the JSON-RPC 2.0 transport (`rpcCall`).
- `client.ts` — one typed function per RPC method, plus the non-RPC transports
  `postQuery` (raw SQL → Arrow IPC bytes) and `trackStreamUrl`.
- `index.ts` — the public barrel; import everything from `"api-client"`.

The `dml` method's `values`/`where` maps are keyed by database column names and
cross the wire verbatim — serde's `rename_all` renames only declared struct
fields, so these free-form map keys are never touched.
