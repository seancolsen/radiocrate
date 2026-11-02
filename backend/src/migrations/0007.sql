-- At most one default sort preset and one default display preset per table.
--
-- A default preset is applied automatically when a query's base is set to the
-- preset's `base_table`. A query's filter combines any number of presets, so a
-- table may have several default filter presets. Its sort and its display each
-- hold exactly one thing, though, so a second default for either has nothing to
-- apply to. Until now the schema allowed one anyway, and the frontend applied
-- whichever came first by name.
--
-- The unique index enforces the rule. Its last key is `true` for a default sort
-- or display preset and null for every other row, and since nulls never collide
-- in a unique index, only two defaults for the same table and section conflict.
-- (DuckDB has no partial indexes, so the condition lives in the key.)
--
-- Where a table already has several defaults for one section, the first by name
-- keeps it, matching what the frontend has been applying.
--
-- DuckDB refuses to build an index on a table the same transaction has already
-- updated ("Cannot create index with outstanding updates"), so rather than
-- clearing the extra defaults in place, the table is rebuilt around the index.
-- The index also makes DuckDB refuse `alter table preset`: a later migration that
-- reshapes this table must drop the index first and recreate it afterwards.

create table migration_0007_preset as
select * replace (
  is_default and (
    section not in ('sort', 'display')
    or row_number() over (partition by base_table, section, is_default order by name, id) = 1
  ) as is_default
)
from preset;

drop table preset;

create table preset (
  id uuid primary key,
  name text not null,
  base_table text not null,
  section text not null, -- 'filter' | 'sort' | 'display'
  definition text not null, -- Raw Querydown fragment for the section
  is_default boolean not null default false, -- Indicates that the preset will be applied automatically when a query's base is set to base_table
  created_at timestamp_s not null,
  modified_at timestamp_s not null
);

create unique index preset_single_default on preset (
  base_table,
  section,
  (case when is_default and section in ('sort', 'display') then true end)
);

insert into preset
select id, name, base_table, section, definition, is_default, created_at, modified_at
from migration_0007_preset;

drop table migration_0007_preset;
