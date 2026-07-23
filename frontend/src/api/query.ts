// The crudest possible SQL runner: POST the raw SQL string to `/api/query`,
// buffer the whole Arrow IPC response (no streaming), decode it, and stringify
// the rows to plain text. The backend runs SQL and streams Arrow, full stop —
// all Querydown→SQL work happens upstream (see plan §4).

import { tableFromIPC, type Table } from "apache-arrow";

/** Runs a SQL string against the query API and returns the decoded Arrow table.
 * Throws on a non-2xx response (a bad SQL string returns 400 + a plain-text
 * DuckDB error). */
export async function runSql(sql: string) {
  const res = await fetch("/api/query", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: sql,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return tableFromIPC(new Uint8Array(await res.arrayBuffer()));
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

/** The entire results renderer: join each row's cell values (in column order)
 * with a single space, join rows with a newline. Null/undefined → "". No
 * headers, no column metadata, no formatting (plain text is the spec, §4). */
export function tableToText(table: Table): string {
  const names = table.schema.fields.map((f) => f.name);
  const rows: string[] = [];
  for (const row of table) {
    if (row === null) continue;
    const cells = names.map((n) => {
      const v = (row as Record<string, unknown>)[n];
      return v == null ? "" : String(v);
    });
    rows.push(cells.join(" "));
  }
  return rows.join("\n");
}
