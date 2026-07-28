// Schema introspection + convention-based link inference, ported from the shared
// `introspection` crate (`introspection/src/lib.rs`, `resources/duckdb.sql`).
//
// RadioCrate declares no foreign keys (DuckDB can't update FK-referenced rows),
// so the introspection SQL always emits an empty `links` array; `addInferredLinks`
// recovers links by convention — a `UUID` column named after a table links to
// that table's `id`. The enriched JSON is what the Querydown compiler consumes.
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
  nullable?: boolean;
}
interface RawTable {
  name: string;
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

/** Parses an introspection JSON document into its tables. Returns `[]` for a
 * document without a `tables` array (the enriched JSON always has one; this just
 * keeps a malformed payload from throwing on the results path). */
export function parseSchemaTables(json: string): SchemaTable[] {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return [];
  }
  const tables = root["tables"];
  if (!Array.isArray(tables)) return [];
  return (tables as RawTable[]).map((t) => ({
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

/** Every convention-inferred link among `tables`, in table then column order. */
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
      if (isLinkColumn(col.name, col.type, tableNames)) {
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
