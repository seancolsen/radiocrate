// Schema introspection, ported from the shared `introspection` crate
// (`introspection/src/lib.rs`, `resources/duckdb.sql`).
//
// RadioCrate declares no foreign keys (DuckDB can't update FK-referenced rows),
// so its links are declared in `metadata.relationship` instead, each from one
// column to the primary key of the table it names. The introspection SQL reads
// them into the document's `links`, in the shape the Querydown compiler takes,
// so the document goes to the compiler as it is; parsing it puts each link on
// the column it starts from (`SchemaColumn.link`), for the record editor.
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

/** The introspection SQL, copied verbatim from
 * `introspection/resources/duckdb.sql` without its comments (schema.test.ts
 * holds the two together). Returns a single row with a single JSON text cell
 * describing every table/column of every schema in the database, but for the
 * system schemas and the `temp` database, and every link declared in
 * `metadata.relationship`. A table outside the current schema (`main`) carries
 * its schema as a path, as in `"schema": ["metadata"]`, and so does each end of
 * a link to or from one. */
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
  ),
  -- The column each table with a single-column primary key is keyed by: what a link points at.
  primary_keys AS (
    SELECT
      database_name AS table_catalog,
      schema_name AS table_schema,
      table_name,
      constraint_column_names[1] AS column_name
    FROM duckdb_constraints()
    WHERE constraint_type = 'PRIMARY KEY' AND len(constraint_column_names) = 1
  ),
  -- Each declared relationship whose column and target are there, with both ends' schema paths.
  links AS (
    SELECT
      r.table_name AS from_table,
      r.column_name AS from_column,
      fs.path AS from_path,
      r.target_table_name AS to_table,
      pk.column_name AS to_column,
      ts.path AS to_path,
      c.ordinal_position
    FROM metadata.relationship r
    JOIN information_schema.columns c
      ON c.table_catalog = current_database()
      AND c.table_schema = r.schema_name
      AND c.table_name = r.table_name
      AND c.column_name = r.column_name
    JOIN schemas fs
      ON fs.table_catalog = current_database() AND fs.table_schema = r.schema_name
    JOIN primary_keys pk
      ON pk.table_catalog = current_database()
      AND pk.table_schema = r.target_schema_name
      AND pk.table_name = r.target_table_name
    JOIN schemas ts
      ON ts.table_catalog = current_database() AND ts.table_schema = r.target_schema_name
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
  'links', COALESCE((
    SELECT to_json(list(
      json_object(
        'from', CASE
          WHEN len(l.from_path) = 0 THEN json_object('table', l.from_table, 'column', l.from_column)
          ELSE json_object('table', l.from_table, 'schema', l.from_path, 'column', l.from_column)
        END,
        'to', CASE
          WHEN len(l.to_path) = 0 THEN json_object('table', l.to_table, 'column', l.to_column)
          ELSE json_object('table', l.to_table, 'schema', l.to_path, 'column', l.to_column)
        END,
        'unique', false
      )
      ORDER BY len(l.from_path) > 0, l.from_path, l.from_table, l.ordinal_position, l.to_path,
        l.to_table
    ))
    FROM links l
  ), '[]')
))::VARCHAR AS schema;`;

/** The subset of the introspection document the app reads. */
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
interface RawLinkEnd {
  table: string;
  /** The schema's path, outermost first. Absent for the current schema. */
  schema?: string[];
  column: string;
}
interface RawLink {
  from: RawLinkEnd;
  to: RawLinkEnd;
}

/** One introspected column. */
export interface SchemaColumn {
  name: string;
  type: string | undefined;
  nullable: boolean;
  /** The table this column links to (a row of `metadata.relationship`), named
   * as the app names tables: the column holds the primary key of a record
   * there. Absent for a column that links nowhere. */
  link?: string;
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
  schemaName: string;
  tableName: string;
} {
  const { schema, table } = splitTableName(name);
  return { schemaName: schema, tableName: table };
}

/** A table's name split for a DML operation: the table alone in the current
 * schema, with its `schema` in another, which the backend writes it in. */
export function dmlTable(name: string): { schema?: string; table: string } {
  const { schema, table } = splitTableName(name);
  return schema === CURRENT_SCHEMA ? { table } : { schema, table };
}

/** The name of the table a `metadata.*` row is about. */
export const rowTable = (row: {
  schemaName: string;
  tableName: string;
}): string => qualifiedTableName(row.schemaName, row.tableName);

// ── Parsing ─────────────────────────────────────────────────────────────────

/** The raw tables and links of an introspection document, or none for one
 * without them (the introspection SQL always gives both; this just keeps a
 * malformed payload from throwing on the results path). */
function rawDocument(json: string): { tables: RawTable[]; links: RawLink[] } {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { tables: [], links: [] };
  }
  const tables = root["tables"];
  const links = root["links"];
  return {
    tables: Array.isArray(tables) ? (tables as RawTable[]) : [],
    links: Array.isArray(links) ? (links as RawLink[]) : [],
  };
}

/** How the app names a table at a path: alone in the current schema, by its
 * schema in another of the database. `undefined` in another database's. */
function appTableName(
  schema: readonly string[] | undefined,
  table: string,
): string | undefined {
  if (schema === undefined || schema.length === 0) return table;
  return schema.length === 1 ? qualifiedTableName(schema[0], table) : undefined;
}

/** The tables of an introspection document the app names, each with its name,
 * and its columns with the tables they link to. */
function namedTables(json: string): { raw: RawTable; table: SchemaTable }[] {
  const { tables, links } = rawDocument(json);
  const key = (table: string | undefined, column: string) =>
    JSON.stringify([table, column]);
  const targets = new Map<string, string>();
  for (const { from, to } of links) {
    const target = appTableName(to.schema, to.table);
    const fromKey = key(appTableName(from.schema, from.table), from.column);
    if (target !== undefined && !targets.has(fromKey)) {
      targets.set(fromKey, target);
    }
  }
  return tables.flatMap((raw) => {
    const name = appTableName(raw.schema, raw.name);
    if (name === undefined) return [];
    const table: SchemaTable = {
      name,
      columns: (raw.columns ?? []).map((c) => {
        const link = targets.get(key(name, c.name));
        return {
          name: c.name,
          type: c.type,
          nullable: c.nullable ?? true,
          ...(link === undefined ? {} : { link }),
        };
      }),
      uniqueConstraints: raw.unique_constraints ?? [],
    };
    return [{ raw, table }];
  });
}

/** Parses an introspection JSON document into the tables of its current schema:
 * the app's own, the ones it names alone and edits records of. The other
 * schemas' tables are left out, so a table of the same name in one of them is
 * never mistaken for an app table. */
export function parseSchemaTables(json: string): SchemaTable[] {
  return namedTables(json)
    .filter(({ raw }) => (raw.schema ?? []).length === 0)
    .map(({ table }) => table);
}

/** The tables of the database's other schemas (`metadata`, `settings`, the
 * user's own), each named by its schema (`/lastfm/scrobble`), in schema then
 * table order. What a query can be based on, and the Data structure page
 * lists, beside the current schema's. A table of another attached database is
 * left to the compiler. */
export function parseOtherSchemaTables(json: string): SchemaTable[] {
  return namedTables(json)
    .filter(({ raw }) => raw.schema?.length === 1)
    .map(({ table }) => table);
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

/** A declared link: `fromTable.fromColumn` holds the primary key of a record
 * of `toTable`. What the record editor reads to decide which of a table's
 * columns are scalar linked record fields, and which *other* tables reference
 * it (its multi-record fields). */
export interface SchemaLink {
  fromTable: string;
  fromColumn: string;
  toTable: string;
}

/** Every link among `tables` (the current schema's, as `parseSchemaTables`
 * gives them), in table then column order. A link to a table that isn't among
 * them is left out. */
export function schemaLinks(tables: readonly SchemaTable[]): SchemaLink[] {
  const tableNames = new Set(tables.map((t) => t.name));
  const links: SchemaLink[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.link === undefined || !tableNames.has(column.link)) continue;
      links.push({
        fromTable: table.name,
        fromColumn: column.name,
        toTable: column.link,
      });
    }
  }
  return links;
}

/** The columns of `table` that link to another of `tables` — each holding the
 * primary key of a record there. */
export function linkColumns(
  tables: readonly SchemaTable[],
  table: string,
): Set<string> {
  return new Set(
    schemaLinks(tables)
      .filter((link) => link.fromTable === table)
      .map((link) => link.fromColumn),
  );
}
