-- Contextual queries: queries the user writes to run in the context of one record,
-- shown as fields of the record editor on every record of `table_name`.
--
--   id         -> the query's identity, and what its field's metadata is keyed by
--   table_name -> the table whose records the query shows on; the query reaches
--                 the record it's shown on through the `@id` variable, which the
--                 frontend defines as that record's primary key
--   name       -> the field's label
--   query      -> JSON of the same shape as `query.definition` (its base table is
--                 the table the query lists, not `table_name`)
--
-- Tables are named here as text, as in `metadata.field`, so a query left behind by
-- a dropped table is simply never shown.
--
-- `metadata.field` gains a third kind of field, `contextual_query`, so these fields
-- are ordered and hidden like any other. DuckDB won't alter a column of a table
-- with an index on it, so the table is rebuilt; its rows carry over, the old union
-- casting into the wider one.

create table contextual_query (
  id uuid primary key,
  table_name text not null,
  name text not null,
  query text
);

create table metadata.migration_0012_field as select * from metadata.field;

drop table metadata.field;

create table metadata.field (
  table_name text not null,
  field union(
    column_name text,
    multi_link struct(
      related_table_name text,
      fk_column_name text
    ),
    contextual_query uuid
  ) not null,
  visible boolean not null default true,
  "order" double,
  display text,
  sorting text
);

create unique index field_key on metadata.field (
  table_name,
  (union_tag(field)::text),
  (field::text)
);

insert into metadata.field
select table_name, field, visible, "order", display, sorting
from metadata.migration_0012_field;

drop table metadata.migration_0012_field;
