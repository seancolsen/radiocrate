// Schema introspection + convention-based link inference, ported from the shared
// `introspection` crate (`introspection/src/lib.rs`, `resources/duckdb.sql`).
//
// RadioCrate declares no foreign keys (DuckDB can't update FK-referenced rows),
// so the introspection SQL always emits an empty `links` array; `addInferredLinks`
// recovers links by convention — a `UUID` column named after a table links to
// that table's `id`. The enriched JSON is what the Querydown compiler consumes.
//
// NOTE (drift): this mirrors Rust logic that also backs the backend's DML
// validator. The FK-by-convention rule is stable and tiny; a unit test
// (schema.test.ts) guards this port against the Rust `SAMPLE` fixture.

/** The introspection SQL, copied verbatim from
 * `introspection/resources/duckdb.sql`. Returns a single row with a single JSON
 * text cell describing every table/column in the `main` schema. */
export const INTROSPECTION_SQL = `SELECT (json_object(
  'tables', to_json(COALESCE((
    SELECT list(struct_pack(
      name := table_name,
      columns := cols,
      unique_constraints := ucs
    ) ORDER BY table_name)
    FROM (
      SELECT
        c.table_name,
        list(
          struct_pack(
            name := c.column_name,
            "type" := c.data_type,
            nullable := (c.is_nullable = 'YES')
          )
          ORDER BY c.ordinal_position
        ) AS cols,
        COALESCE((
          SELECT list(uc.constraint_column_names
            ORDER BY array_to_string(uc.constraint_column_names, ','))
          FROM duckdb_constraints() uc
          WHERE uc.schema_name = 'main'
            AND uc.table_name = c.table_name
            AND uc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
        ), []) AS ucs
      FROM information_schema.columns c
      WHERE c.table_schema = 'main'
      GROUP BY c.table_name
    )
  ), [])),
  'links', to_json([]::json[])
))::VARCHAR AS schema;`;

/** The subset of the introspection document `addInferredLinks` reads. Extra
 * fields (nullability, unique_constraints, …) are preserved verbatim. */
interface RawColumn {
  name: string;
  type?: string;
}
interface RawTable {
  name: string;
  columns: RawColumn[];
}

/** Rewrites the `links` array of a raw introspection JSON document with
 * convention-inferred links, preserving every other field. Ports
 * `add_inferred_links` + `infer_links` (`introspection/src/lib.rs:147`): for
 * every `UUID` column (case-insensitive) whose name is also a table name, emit a
 * link from that column to `<name>.id`. Each link carries `"unique": false`,
 * matching Querydown's `PrimitiveLink`. Throws if the JSON has no `tables`. */
export function addInferredLinks(rawJson: string): string {
  const root = JSON.parse(rawJson) as Record<string, unknown>;
  const tables = root["tables"];
  if (!Array.isArray(tables)) {
    throw new Error(
      "Introspected schema JSON did not match the expected shape: missing `tables`.",
    );
  }
  const rawTables = tables as RawTable[];
  const tableNames = new Set(rawTables.map((t) => t.name));

  const links: unknown[] = [];
  for (const table of rawTables) {
    for (const col of table.columns) {
      const type = col.type ?? "";
      if (type.toUpperCase() === "UUID" && tableNames.has(col.name)) {
        links.push({
          from: { table: table.name, column: col.name },
          to: { table: col.name, column: "id" },
          unique: false,
        });
      }
    }
  }
  root["links"] = links;
  return JSON.stringify(root);
}
