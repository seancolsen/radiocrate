// The SQL runner: POST the raw SQL string to `/api/query`, buffer the whole
// Arrow IPC response (no streaming), and decode it. The backend runs SQL and
// streams Arrow, full stop — all Querydown→SQL work happens upstream (see plan
// §4). Cell extraction (list detection + stringification) lives here too; the
// structured result is assembled in `query/result.ts`.

import {
  DataType,
  tableFromIPC,
  type DataType as ArrowType,
} from "apache-arrow";
import { postQuery } from "api-client";

/** Runs a SQL string against the query API and returns the decoded Arrow table.
 * The transport lives in the generated client (`postQuery`); Arrow decoding
 * stays here. Throws on a non-2xx response (a bad SQL string returns 400 + a
 * plain-text DuckDB error). */
export async function runSql(sql: string) {
  return tableFromIPC(new Uint8Array(await postQuery(sql)));
}

/** Reads the single JSON text cell from a one-row/one-column result — how the
 * introspection SQL returns the schema document. */
export async function runSqlScalar(sql: string): Promise<string> {
  const table = await runSql(sql);
  const first = table.get(0);
  if (!first) throw new Error("Query returned no rows.");
  const value = first[table.schema.fields[0].name];
  return String(value);
}

/** Whether an Arrow column type is a list (renders as pills). Mirrors
 * `ResultRows::is_list_column`.
 *
 * NOTE: apache-arrow JS (18.x) has no public `LargeList` support and its
 * `Type` enum omits it, yet DuckDB emits list columns that decode with a typeId
 * the public `DataType.isList` guard misses. So this is only a *fast path*; when
 * it returns false the caller must still fall back to {@link isListLikeValue}. */
export function isListType(type: ArrowType): boolean {
  return DataType.isList(type);
}

/** Whether a decoded cell value is list-like (an Arrow sub-vector / array), used
 * as the value-level fallback when {@link isListType} can't classify a column
 * (see its note). Strings are iterable too, so they're excluded; scalars, dates,
 * and struct rows aren't iterable. */
export function isListLikeValue(v: unknown): boolean {
  return (
    v != null &&
    typeof v !== "string" &&
    typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      "function"
  );
}

/** Stringifies one scalar Arrow cell value (null/undefined → ""). Mirrors
 * `format_cell` / Arrow's `ArrayFormatter` for the common types.
 *
 * `type` is the column's Arrow field type, when known — required to render
 * `Timestamp*` cells correctly (see {@link formatNaiveTimestamp}); every other
 * type falls through to the crude `String(value)` default (dates and decimals
 * should still be verified against a real backend, per plan §3.4).
 *
 * DEVIATION: Arrow's JS `.get()` already returns display-ready primitives for
 * strings/numbers/bools. */
export function stringifyArrowValue(value: unknown, type?: ArrowType): string {
  if (value == null) return "";
  if (type && DataType.isTimestamp(type) && typeof value === "number") {
    return formatNaiveTimestamp(value);
  }
  return String(value);
}

/** Formats an Arrow `Timestamp*` cell as a naive `YYYY-MM-DD HH:MM:SS` string.
 *
 * apache-arrow's `.get()` normalizes every `Timestamp*` unit (s/ms/us/ns) to
 * milliseconds since the epoch, so `ms` here is always milliseconds regardless
 * of the column's stored resolution (`timestamp_s` included). DuckDB's `TIMESTAMP`
 * columns are timezone-naive: it computes that epoch by treating the stored
 * civil fields as UTC (no real timezone conversion), so reading them back with
 * the UTC getters recovers exactly the civil fields DuckDB has — the string this
 * returns round-trips through a DuckDB text-to-timestamp cast unchanged. */
function formatNaiveTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}
