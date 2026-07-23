// A tiny, typed JSON-RPC 2.0 client — no RPC library. Same-origin in production
// (`POST /api/rpc`); in dev Vite proxies `/api` to the backend (see vite.config).

/** A saved query, as returned by `query.list` (ordered `created_at DESC`).
 * `definition` is a JSON string decoded by `src/query/definition.ts`. */
export interface Query {
  id: string; // UUID
  name: string;
  created_at: number; // epoch seconds
  modified_at: number; // epoch seconds
  last_play: number; // epoch seconds
  definition: string; // JSON string — see fromStored()
}

/** A saved query-section preset, as returned by `preset.list`. Only `id` and
 * `definition` matter here — the fragment a preset reference resolves to. */
export interface Preset {
  id: string; // UUID
  name: string;
  base_table: string;
  section: string;
  definition: string;
  is_default: boolean;
  created_at: number;
  modified_at: number;
}

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
  id: number;
}

export async function rpcCall<T>(
  method: string,
  params: unknown = null,
): Promise<T> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const env = (await res.json()) as RpcResponse<T>;
  if (env.error) throw new Error(env.error.message ?? "rpc error");
  return env.result as T;
}

export const listQueries = () => rpcCall<Query[]>("query.list");
export const listPresets = () => rpcCall<Preset[]>("preset.list");
