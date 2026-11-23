-- Tables in schemas other than `main`: Querydown queries them as `#/lastfm/scrobble`,
-- and the app now lists them, takes them as a query's base table, and customizes
-- them as it does its own. A table is no longer named by its name alone, so each
-- table of the app's metadata about tables and their fields gains the schema the
-- table is in, by name, ahead of the table's own:
--
--   table_schema -> the schema of the table the row is about: `main` for the
--                   app's own tables, which every row before this migration is
--                   about
--
-- in `metadata."table"`, `metadata.field`, `metadata.computed_column` and
-- `metadata.custom_comparison`. Each table's key gains it too, so two tables of
-- the same name in different schemas are customized apart.
--
-- Only the table a row is about is named with its schema. A `multi_link` field
-- names the related table by its name alone, as it did: the record editor works
-- on `main`'s tables, and links only among them.
--
-- A primary key or an index stands in the way of `alter table` here (migration
-- 0014 says why), so each table is rebuilt around its new key, its rows carried
-- over into `main`.

-- metadata."table"

create table metadata.migration_0017_table as select * from metadata."table";

drop table metadata."table";

create table metadata."table" (
  table_schema text not null,
  table_name text not null,
  visible boolean not null default true,
  "order" double,
  default_text_search text,
  linked_record_comparison text,
  record_picker_sorting text,
  record_picker_display text,
  primary key (table_schema, table_name)
);

insert into metadata."table"
select
  'main', table_name, visible, "order", default_text_search,
  linked_record_comparison, record_picker_sorting, record_picker_display
from metadata.migration_0017_table;

drop table metadata.migration_0017_table;

-- metadata.field

create table metadata.migration_0017_field as select * from metadata.field;

drop table metadata.field;

create table metadata.field (
  table_schema text not null,
  table_name text not null,
  field union(
    column_name text,
    multi_link struct(
      related_table_name text,
      fk_column_name text
    ),
    contextual_query uuid,
    computed_column text
  ) not null,
  visible boolean not null default true,
  "order" double,
  display text,
  sorting text
);

create unique index field_key on metadata.field (
  table_schema,
  table_name,
  (union_tag(field)::text),
  (field::text)
);

insert into metadata.field
select 'main', table_name, field, visible, "order", display, sorting
from metadata.migration_0017_field;

drop table metadata.migration_0017_field;

-- metadata.computed_column

create table metadata.migration_0017_computed_column as
select * from metadata.computed_column;

drop table metadata.computed_column;

create table metadata.computed_column (
  table_schema text not null,
  table_name text not null,
  name text not null,
  expression text,
  primary key (table_schema, table_name, name)
);

insert into metadata.computed_column
select 'main', table_name, name, expression
from metadata.migration_0017_computed_column;

drop table metadata.migration_0017_computed_column;

-- metadata.custom_comparison

create table metadata.migration_0017_custom_comparison as
select * from metadata.custom_comparison;

drop table metadata.custom_comparison;

create table metadata.custom_comparison (
  table_schema text not null,
  table_name text not null,
  name text not null,
  expression text,
  primary key (table_schema, table_name, name)
);

insert into metadata.custom_comparison
select 'main', table_name, name, expression
from metadata.migration_0017_custom_comparison;

drop table metadata.migration_0017_custom_comparison;
