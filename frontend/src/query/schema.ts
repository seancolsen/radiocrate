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
// one. The app names a table as Querydown does after the `#`: alone in the
// current schema (`track`), by its schema in another (`/lastfm/scrobble`) — see
// `qualifiedTableName`. The record editor works with the current schema's
// tables alone, so `parseSchemaTables` returns only those; the lists of tables
// (a query's base, the Data structure page) add the other schemas' from
// `parseOtherSchemaTables`.
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
  /** As the app names it: by its schema outside the current one
   * (`qualifiedTableName`). */
  name: string;
  columns: SchemaColumn[];
  uniqueConstraints: string[][];
}

// ── Naming tables across schemas ────────────────────────────────────────────

/** The schema the app's own tables are in: the one a table is named in alone. */
export const CURRENT_SCHEMA = "main";

/** How the app names a table: alone in the current schema (`track`), and by its
 * schema in another (`/lastfm/scrobble`), just as Querydown writes it after the
 * `#`. Whatever keeps a table by name keeps it so: a query's base, a preset's,
 * each table's customizations in the app store, the Data structure page's item
 * ids. */
export function qualifiedTableName(schema: string, table: string): string {
  return schema === CURRENT_SCHEMA ? table : `/${schema}/${table}`;
}

/** A table's name, as {@link qualifiedTableName} gives it, split back into its
 * schema and the table's own name. */
export function splitTableName(name: string): {
  schema: string;
  table: string;
} {
  if (!name.startsWith("/")) return { schema: CURRENT_SCHEMA, table: name };
  const slash = name.indexOf("/", 1);
  if (slash === -1) return { schema: CURRENT_SCHEMA, table: name };
  return { schema: name.slice(1, slash), table: name.slice(slash + 1) };
}

/** Whether a table's name names one in the current schema: one of the app's
 * own, whose records the record editor edits. */
export const isCurrentSchemaTable = (name: string): boolean =>
  splitTableName(name).schema === CURRENT_SCHEMA;

/** A table's own name, without its schema: what a list of tables shows under
 * its schema's heading. */
export const tableLabel = (name: string): string => splitTableName(name).table;

/** A table's name as the compiler takes a base table: alone in the current
 * schema, as its schema and name in another. */
export function querydownTableName(name: string): string | string[] {
  const { schema, table } = splitTableName(name);
  return schema === CURRENT_SCHEMA ? table : [schema, table];
}

/** A table's name split for the wire: the shape every `metadata.*` row and
 * call names a table with. */
export function tableRef(name: string): {
  tableSchema: string;
  tableName: string;
} {
  const { schema, table } = splitTableName(name);
  return { tableSchema: schema, tableName: table };
}

/** The name of the table a `metadata.*` row is about. */
export const rowTable = (row: {
  tableSchema: string;
  tableName: string;
}): string => qualifiedTableName(row.tableSchema, row.tableName);

// ── Parsing ─────────────────────────────────────────────────────────────────

/** The raw tables of an introspection document, or `[]` for one without a
 * `tables` array (the enriched JSON always has one; this just keeps a malformed
 * payload from throwing on the results path). */
function rawTables(json: string): RawTable[] {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return [];
  }
  const tables = root["tables"];
  return Array.isArray(tables) ? (tables as RawTable[]) : [];
}

function toSchemaTable(t: RawTable, name: string): SchemaTable {
  return {
    name,
    columns: (t.columns ?? []).map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable ?? true,
    })),
    uniqueConstraints: t.unique_constraints ?? [],
  };
}

/** Parses an introspection JSON document into the tables of its current schema:
 * the app's own, the ones it names alone and edits records of. The other
 * schemas' tables are left out, so a table of the same name in one of them is
 * never mistaken for an app table. */
export function parseSchemaTables(json: string): SchemaTable[] {
  return rawTables(json)
    .filter((t) => (t.schema ?? []).length === 0)
    .map((t) => toSchemaTable(t, t.name));
}

/** The tables of the database's other schemas (`metadata`, `settings`, the
 * user's own), each named by its schema (`/lastfm/scrobble`), in schema then
 * table order. What a query can be based on, and the Data structure page
 * lists, beside the current schema's. A table of another attached database is
 * left to the compiler. */
export function parseOtherSchemaTables(json: string): SchemaTable[] {
  return rawTables(json).flatMap((t) =>
    t.schema?.length === 1
      ? [toSchemaTable(t, qualifiedTableName(t.schema[0], t.name))]
      : [],
  );
}

/** Every table of an introspection document the app lists, as the app store
 * keeps them: the current schema's (`tables`), the other schemas'
 * (`otherTables`), and both together, the current schema's first
 * (`allTables`) — what a query can be based on, and what the app's
 * definitions are generated for. */
export function readSchemaTables(json: string): {
  tables: SchemaTable[];
  otherTables: SchemaTable[];
  allTables: SchemaTable[];
} {
  const tables = parseSchemaTables(json);
  const otherTables = parseOtherSchemaTables(json);
  return { tables, otherTables, allTables: [...tables, ...otherTables] };
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
