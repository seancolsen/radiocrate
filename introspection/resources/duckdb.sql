-- RadioCrate schema introspection query for DuckDB.
--
-- Running this against a live database yields a single row with a single column containing the
-- schema JSON that both the Querydown compiler (front end) and the DML API (back end) consume.
--
-- This started as a copy of Querydown's own introspection query
-- (`compiler/resources/introspection/duckdb.sql`) and was then extended with the extra metadata the
-- DML API needs. It is kept in this repo — rather than pulled from Querydown at runtime — so that a
-- single query and post-processing serve both consumers. The `tables[].columns[]` and top-level
-- `links` shape must stay compatible with Querydown's `PrimitiveSchema`; extra keys (`nullable`,
-- `unique_constraints`) are ignored by that (non-`deny_unknown_fields`) deserializer.
--
-- Notes on what it captures:
--
--   * Only the `main` schema is introspected. Querydown's schema JSON is a flat namespace of table
--     names, so introspecting multiple DuckDB schemas could produce colliding names.
--   * Only the current database's own catalog is introspected (`table_catalog` / `database_name` must
--     equal `current_database()`). DuckDB puts `TEMP` tables in a separate catalog literally named
--     `temp`, but under the same `main` schema name as the real database, so a schema-only filter would
--     let session-scoped temp tables (e.g. the scanner's `staging_*` tables) leak into the schema
--     alongside the real tables of the same name.
--   * Column types are emitted as DuckDB's type names (e.g. `INTEGER`, `TIMESTAMP`, `VARCHAR[]`).
--   * `nullable` records whether each column permits NULL (`is_nullable = 'YES'`).
--   * `unique_constraints` lists every UNIQUE / PRIMARY KEY constraint on the table as an array of
--     the column-name arrays it covers (so multi-column constraints are represented faithfully).
--   * `links` is always emitted empty here. RadioCrate declares no foreign keys (DuckDB can't update
--     rows referenced by an FK constraint), so links are inferred by convention in Rust after this
--     query runs — see the `introspection` crate.
--
-- `COALESCE(..., [])` guards the empty-database case so each key is an empty array rather than null.
-- The whole document is cast to VARCHAR so callers reading a single text cell get JSON text.

SELECT (json_object(
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
            AND uc.database_name = current_database()
            AND uc.table_name = c.table_name
            AND uc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
        ), []) AS ucs
      FROM information_schema.columns c
      WHERE c.table_schema = 'main'
        AND c.table_catalog = current_database()
      GROUP BY c.table_name
    )
  ), [])),
  'links', to_json([]::json[])
))::VARCHAR AS schema;
