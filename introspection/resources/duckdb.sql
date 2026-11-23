-- RadioCrate schema introspection query for DuckDB.
--
-- Running this against a live database yields a single row with a single column containing the
-- schema JSON that both the Querydown compiler (front end) and the DML API (back end) consume.
--
-- This started as a copy of Querydown's own introspection query
-- (`compiler/resources/introspection/duckdb.sql`) and was then extended with the extra metadata the
-- DML API needs. It is kept in this repo — rather than pulled from Querydown at runtime — so that a
-- single query and post-processing serve both consumers. The `tables[]` and top-level `links` shape
-- must stay compatible with Querydown's `PrimitiveSchema`; extra keys (`nullable`,
-- `unique_constraints`) are ignored by that (non-`deny_unknown_fields`) deserializer.
--
-- Notes on what it captures:
--
--   * Every schema of every attached database is introspected, as Querydown's own query does, except
--     the `system` database and the `information_schema` and `pg_catalog` schemas. A table in the
--     current schema of the current database (`main`) has no `schema` key, and is written `#table` in
--     Querydown. A table in another schema of the current database (`metadata`, `settings`, …) has a
--     `schema` key listing that schema's name, and is written `#/schema/table`; a table in another
--     attached database lists the database's name and then the schema's (`#/database/schema/table`).
--   * The `temp` database is left out too. DuckDB puts `TEMP` tables there, under a `main` schema of
--     its own, so the session-scoped temp tables (e.g. the scanner's `staging_*` tables) would
--     otherwise show up as `#/temp/main/…`, or, filtered by schema name alone, alongside the real
--     tables of the same name.
--   * Tables are ordered with the current schema's first, then by schema, then by name.
--   * Column types are emitted as DuckDB's type names (e.g. `INTEGER`, `TIMESTAMP`, `VARCHAR[]`).
--   * `nullable` records whether each column permits NULL (`is_nullable = 'YES'`).
--   * `unique_constraints` lists every UNIQUE / PRIMARY KEY constraint on the table as an array of
--     the column-name arrays it covers (so multi-column constraints are represented faithfully).
--   * `links` lists the relationships declared in `metadata.relationship` (migration 0019), each from
--     a column to the primary key of the table it names. RadioCrate declares no foreign keys (DuckDB
--     can't update rows referenced by an FK constraint), so this table stands in for them. A row is
--     left out unless its column is there and its target table has a single-column primary key, the
--     column it links to. Each end names its table as the tables do, with a `schema` outside the
--     current one, and every link carries `"unique": false`, matching Querydown's `PrimitiveLink`.
--     Links are ordered as their tables are, then by the column's position.
--
-- `COALESCE(..., '[]')` guards the empty-database case so each key is an empty array rather than
-- null. The whole document is cast to VARCHAR so callers reading a single text cell get JSON text.

WITH
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
))::VARCHAR AS schema;
