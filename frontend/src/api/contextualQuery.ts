// Reading and writing the `contextual_query` table. Like a playlist's entries
// (`api/playlist.ts`), its rows are read as raw SQL and written through `dml`:
// one table's rows need no Querydown, and the writes no RPC methods of their own.

import { dml, type DmlResult, type JsonValue } from "api-client";
import type { ContextualQuery } from "../query/contextualQuery";
import { definitionFromStored, definitionToStored } from "../query/definition";
import { runSql } from "./query";

const TABLE = "contextual_query";

/** Every contextual query, of every table. */
export async function fetchContextualQueries(): Promise<ContextualQuery[]> {
  const table = await runSql(
    `select id::text as id, table_name, name, query ` +
      `from ${TABLE} order by table_name, name, id;`,
  );
  const column = (name: string) => table.getChild(name);
  const queries: ContextualQuery[] = [];
  for (let row = 0; row < table.numRows; row++) {
    const query: unknown = column("query")?.get(row);
    queries.push({
      id: String(column("id")?.get(row)),
      tableName: String(column("table_name")?.get(row)),
      name: String(column("name")?.get(row)),
      definition: definitionFromStored(typeof query === "string" ? query : ""),
    });
  }
  return queries;
}

/** One write to one contextual query, as a `dml` request of its own. */
function write(
  operation:
    | { operation: "insert"; values: Record<string, JsonValue> }
    | { operation: "update"; id: string; values: Record<string, JsonValue> }
    | { operation: "delete"; id: string },
): Promise<DmlResult> {
  const op =
    operation.operation === "insert"
      ? { operation: "insert" as const, values: operation.values }
      : operation.operation === "update"
        ? {
            operation: "update" as const,
            where: { id: operation.id },
            values: operation.values,
          }
        : { operation: "delete" as const, where: { id: operation.id } };
  return dml({ operations: [{ ...op, id: "op1", table: TABLE }] });
}

export function insertContextualQuery(
  query: ContextualQuery,
): Promise<DmlResult> {
  return write({
    operation: "insert",
    values: {
      id: query.id,
      table_name: query.tableName,
      name: query.name,
      query: definitionToStored(query.definition),
    },
  });
}

export function renameContextualQuery(
  id: string,
  name: string,
): Promise<DmlResult> {
  return write({ operation: "update", id, values: { name } });
}

export function writeContextualQueryDefinition(
  query: ContextualQuery,
): Promise<DmlResult> {
  return write({
    operation: "update",
    id: query.id,
    values: { query: definitionToStored(query.definition) },
  });
}

export function deleteContextualQuery(id: string): Promise<DmlResult> {
  return write({ operation: "delete", id });
}
