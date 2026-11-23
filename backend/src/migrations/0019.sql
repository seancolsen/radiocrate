-- Relationships between tables are declared rather than inferred. Until now a
-- `UUID` column named after a table linked to that table's `id` (`track.album`
-- to `album`), found in the column's own schema first, then in `main`. From here
-- on a link exists only where a row of `metadata.relationship` says so:
--
--   schema_name        -> the schema of the table the link is from
--   table_name         -> that table
--   column_name        -> the column of it that holds the linked record's key
--   target_schema_name -> the schema of the table the link is to
--   target_table_name  -> that table, whose primary key the column holds
--
-- A link is one column, and goes to the primary key of the table it names, a
-- single column (the introspection query looks it up; see the `introspection`
-- crate). Nothing is enforced: DuckDB can't update a row a foreign key refers
-- to, so there are none, and a row naming a column or table that isn't there
-- is simply never read.
--
-- The rows below are the links the old convention found among the app's
-- tables, and one it couldn't: a folder's `parent`, which is named for what it
-- is rather than for the table it points into.
--
-- The rest of this migration tidies the `metadata` schema:
--
--   * `contextual_query` moves there from `app` (migration 0018). DuckDB moves
--     no table between schemas, so it's made anew and its rows copied over.
--   * Every `table_schema` column there is renamed `schema_name`, to match
--     `metadata.relationship`: in `metadata."table"`, `metadata.field`,
--     `metadata.computed_column` and `metadata.custom_comparison`. DuckDB won't
--     rename a column an index depends on, so `metadata.field`'s index is made
--     anew around it.

create table metadata.relationship (
  schema_name text not null,
  table_name text not null,
  column_name text not null,
  target_schema_name text not null,
  target_table_name text not null,
  primary key (
    schema_name,
    table_name,
    column_name,
    target_schema_name,
    target_table_name
  )
);

insert into metadata.relationship values
  ('main', 'credit', 'artist', 'main', 'artist'),
  ('main', 'credit', 'role', 'main', 'role'),
  ('main', 'credit', 'track', 'main', 'track'),
  ('main', 'play', 'track', 'main', 'track'),
  ('main', 'track', 'album', 'main', 'album'),
  ('main', 'track', 'file', 'main', 'file'),
  ('main', 'track', 'rating', 'main', 'rating'),
  ('main', 'track_tag', 'tag', 'main', 'tag'),
  ('main', 'track_tag', 'track', 'main', 'track'),
  ('app', 'playlist_track', 'playlist', 'app', 'playlist'),
  ('app', 'playlist_track', 'track', 'main', 'track'),
  ('app', 'source', 'playlist', 'app', 'playlist'),
  ('app', 'source', 'query', 'app', 'query'),
  ('app', 'source', 'source_folder', 'app', 'source_folder'),
  ('app', 'source_folder', 'parent', 'app', 'source_folder');

-- metadata.contextual_query

create table metadata.contextual_query (
  id uuid primary key,
  table_name text not null,
  name text not null,
  query text
);

insert into metadata.contextual_query
select id, table_name, name, query from app.contextual_query;

drop table app.contextual_query;

-- table_schema -> schema_name

alter table metadata."table" rename column table_schema to schema_name;

alter table metadata.computed_column rename column table_schema to schema_name;

alter table metadata.custom_comparison rename column table_schema to schema_name;

drop index metadata.field_key;

alter table metadata.field rename column table_schema to schema_name;

create unique index field_key on metadata.field (
  schema_name,
  table_name,
  (union_tag(field)::text),
  (field::text)
);
