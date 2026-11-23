// Schema introspection + convention-based link inference, ported from the shared
// `introspection` crate (`introspection/src/lib.rs`, `resources/duckdb.sql`).
//
// RadioCrate declares no foreign keys (DuckDB can't update FK-referenced rows),
// so the introspection SQL always emits an empty `links` array; `addInferredLinks`
// recovers links by convention — a `UUID` column named after a table links to
// that table's `id`. The enriched JSON is what the Querydown compiler consumes.
//
// Schemas: the JSON lists the tables of every schema, so Querydown can query
// `#/metadata/field` as well as `#track`. A table outside the current schema
// (`main`) carries a `schema` path, and so does each end of a link to or from
// one. The rest of the app works with the current schema's tables alone, which
// it names alone, so `parseSchemaTables` returns only those.
//
// It also carries the record-identity convention (`primaryKey` /
// `identifyingColumns`), which decides what counts as "the primary key" of a
// table — the question the record editor and the results context menu both
// hang off.
//
// NOTE (drift): this mirrors Rust logic that also backs the backend's DML
// validator. The FK-by-convention rule is stable and tiny; a unit test
// (schema.test.ts) guards this port against the Rust `SAMPLE` fixture.

/** The introspection SQL, copied verbatim from
 * `introspection/resources/duckdb.sql` without its comments (schema.test.ts
 * holds the two together). Returns a single row with a single JSON text cell
 * describing every table/column of every schema in the database, but for the
 * system schemas and the `temp` database. A table outside the current schema
 * (`main`) carries its schema as a path, as in `"schema": ["metadata"]`. */
export const INTROSPECTION_SQL = `WITH
  -- Where each schema is, as Querydown writes it: the names before the table's.
  schemas AS (
    SELECT DISTINCT
      table_catalog,
      table_schema,
      CASE
        WHEN table_catalog = current_database() AND table_schema = current_schema() THEN []
        WHEN table_catalog = current_database() THEN [table_schema]
        ELSE [table_catalog, table_schema]
      END AS path
    FROM information_schema.tables
    WHERE table_catalog NOT IN ('system', 'temp')
      AND table_schema NOT IN ('information_schema', 'pg_catalog')
  ),
  tables AS (
    SELECT
      c.table_catalog,
      c.table_schema,
      c.table_name,
      s.path,
      list(
        struct_pack(
          name := c.column_name,
          "type" := c.data_type,
          nullable := (c.is_nullable = 'YES')
        )
        ORDER BY c.ordinal_position
      ) AS cols
    FROM information_schema.columns c
    JOIN schemas s USING (table_catalog, table_schema)
    GROUP BY c.table_catalog, c.table_schema, c.table_name, s.path
  ),
  uniques AS (
    SELECT
      database_name AS table_catalog,
      schema_name AS table_schema,
      table_name,
      list(constraint_column_names
        ORDER BY array_to_string(constraint_column_names, ',')) AS ucs
    FROM duckdb_constraints()
    WHERE constraint_type IN ('UNIQUE', 'PRIMARY KEY')
    GROUP BY ALL
  )
SELECT (json_object(
  'tables', COALESCE((
    SELECT to_json(list(
      CASE
        WHEN len(t.path) = 0 THEN json_object(
          'name', t.table_name,
          'columns', t.cols,
          'unique_constraints', COALESCE(u.ucs, [])
        )
        ELSE json_object(
          'name', t.table_name,
          'schema', t.path,
          'columns', t.cols,
          'unique_constraints', COALESCE(u.ucs, [])
        )
      END
      ORDER BY len(t.path) > 0, t.path, t.table_name
    ))
    FROM tables t
    LEFT JOIN uniques u USING (table_catalog, table_schema, table_name)
  ), '[]'),
  'links', '[]'::JSON
))::VARCHAR AS schema;`;

/** The subset of the introspection document `addInferredLinks` reads. Extra
 * fields (nullability, unique_constraints, …) are preserved verbatim. */
interface RawColumn {
  name: string;
  type?: string;
  nullable?: boolean;
}
interface RawTable {
  name: string;
  /** The schema's path, outermost first. Absent for the current schema. */
  schema?: string[];
  columns: RawColumn[];
  unique_constraints?: string[][];
}

/** One introspected column. */
export interface SchemaColumn {
  name: string;
  type: string | undefined;
  nullable: boolean;
}

/** One introspected table: its columns and its UNIQUE / PRIMARY KEY constraints
 * (each a list of column names). Ports `introspection::Table`. */
export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  uniqueConstraints: string[][];
}

/** Whether a raw table is in the current schema, where the app names it alone. */
const isCurrent = (table: RawTable): boolean =>
  (table.schema ?? []).length === 0;

/** Parses an introspection JSON document into the tables of its current schema:
 * the app's own, the ones it names alone, picks a query's base table from and
 * edits records of. The other schemas' tables are left to the compiler, so a
 * table of the same name in one of them is never mistaken for an app table.
 * Returns `[]` for a document without a `tables` array (the enriched JSON
 * always has one; this just keeps a malformed payload from throwing on the
 * results path). */
export function parseSchemaTables(json: string): SchemaTable[] {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return [];
  }
  const tables = root["tables"];
  if (!Array.isArray(tables)) return [];
  return (tables as RawTable[]).filter(isCurrent).map((t) => ({
    name: t.name,
    columns: (t.columns ?? []).map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable ?? true,
    })),
    uniqueConstraints: t.unique_constraints ?? [],
  }));
}

/** The column that identifies a single record in `table`, by RadioCrate's
 * convention: a non-null, single-column UNIQUE / PRIMARY KEY constraint,
 * preferring one named `id` when a table has several. `undefined` for a table
 * keyed only by a composite constraint (e.g. `credit (track, artist)`). */
export function primaryKey(table: SchemaTable): string | undefined {
  const singles = table.uniqueConstraints
    .filter((cols) => cols.length === 1)
    .map((cols) => cols[0])
    .filter((name) =>
      table.columns.some((c) => c.name === name && !c.nullable),
    );
  return singles.find((name) => name === "id") ?? singles[0];
}

/** The columns that identify one record in `table`: the single primary key when
 * there is one, otherwise the first unique constraint (e.g. the composite
 * `(track, artist)` of `credit`). Empty when the table has no unique constraint
 * at all — such a table has no editable record identity. */
export function identifyingColumns(table: SchemaTable): string[] {
  const pk = primaryKey(table);
  if (pk !== undefined) return [pk];
  return table.uniqueConstraints[0] ?? [];
}

/** RadioCrate's foreign-key convention, in one place: a `UUID` column
 * (case-insensitive) named after a table links to that table's `id`. Both link
 * derivations below — the JSON rewrite the compiler consumes, and the structured
 * one the record editor builds its form from — decide with this. */
function isLinkColumn(
  columnName: string,
  columnType: string | undefined,
  tableNames: ReadonlySet<string>,
): boolean {
  return (
    (columnType ?? "").toUpperCase() === "UUID" && tableNames.has(columnName)
  );
}

/** A convention-inferred foreign key: `fromTable.fromColumn` → `toTable.id`.
 * The structured form of the links {@link addInferredLinks} writes into the
 * compiler's schema JSON — what the record editor reads to decide which of a
 * table's columns are scalar linked record fields, and which *other* tables
 * reference it (its multi-record fields). */
export interface SchemaLink {
  fromTable: string;
  fromColumn: string;
  toTable: string;
}

/** Every convention-inferred link among `tables` (the current schema's, as
 * `parseSchemaTables` gives them), in table then column order. */
export function inferLinks(tables: readonly SchemaTable[]): SchemaLink[] {
  const tableNames = new Set(tables.map((t) => t.name));
  const links: SchemaLink[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      if (!isLinkColumn(column.name, column.type, tableNames)) continue;
      links.push({
        fromTable: table.name,
        fromColumn: column.name,
        toTable: column.name,
      });
    }
  }
  return links;
}

/** The columns of `table` that link to another table — each holding the `id` of
 * a record there. */
export function linkColumns(
  tables: readonly SchemaTable[],
  table: string,
): Set<string> {
  return new Set(
    inferLinks(tables)
      .filter((link) => link.fromTable === table)
      .map((link) => link.fromColumn),
  );
}

/** Rewrites the `links` array of a raw introspection JSON document with
 * convention-inferred links, preserving every other field. Ports
 * `add_inferred_links` + `infer_links` (`introspection/src/lib.rs`): for every
 * `UUID` column (case-insensitive) whose name is also a table name, emit a link
 * from that column to `<name>.id`. The table is looked for in the column's own
 * schema first, then in the current one, so a table in another schema can link
 * to the app's, and an end outside the current schema carries its `schema`.
 * Each link carries `"unique": false`, matching Querydown's `PrimitiveLink`.
 * Throws if the JSON has no `tables`. */
export function addInferredLinks(rawJson: string): string {
  const root = JSON.parse(rawJson) as Record<string, unknown>;
  const tables = root["tables"];
  if (!Array.isArray(tables)) {
    throw new Error(
      "Introspected schema JSON did not match the expected shape: missing `tables`.",
    );
  }
  const rawTables = tables as RawTable[];
  // Each schema's table names, keyed by the schema's path.
  const schemaKey = (schema: readonly string[]) => JSON.stringify(schema);
  const tableNames = new Map<string, Set<string>>();
  for (const table of rawTables) {
    const key = schemaKey(table.schema ?? []);
    const names = tableNames.get(key) ?? new Set<string>();
    names.add(table.name);
    tableNames.set(key, names);
  }
  const namesIn = (schema: readonly string[]) =>
    tableNames.get(schemaKey(schema)) ?? new Set<string>();
  const end = (schema: readonly string[], table: string, column: string) =>
    schema.length === 0 ? { table, column } : { table, schema, column };

  const links: unknown[] = [];
  for (const table of rawTables) {
    const schema = table.schema ?? [];
    for (const col of table.columns) {
      const toSchema = isLinkColumn(col.name, col.type, namesIn(schema))
        ? schema
        : isLinkColumn(col.name, col.type, namesIn([]))
          ? []
          : undefined;
      if (toSchema === undefined) continue;
      links.push({
        from: end(schema, table.name, col.name),
        to: end(toSchema, col.name, "id"),
        unique: false,
      });
    }
  }
  root["links"] = links;
  return JSON.stringify(root);
}
