-- A filter preset remembers how its definition is read: as Querydown, or as
-- basic text, words the frontend turns into Querydown search terms (quoting any
-- that isn't a bare word) before it compiles them.
--
--   filter_strategy -> 'querydown' | 'basic_text'
--
-- Every existing preset was written as Querydown, so that's the default. A sort
-- or display preset has no use for the column and keeps the default. A query's
-- or playlist's own filter keeps its strategy in its stored definition JSON
-- (`filter.strategy`, absent for Querydown), which needs no migration.
--
-- DuckDB won't add a NOT NULL column to a table an index depends on
-- ("Cannot alter entry"), so `preset_single_default` (migrations 0007, 0018) is
-- dropped around the change and made anew.

drop index app.preset_single_default;

alter table app.preset add column filter_strategy text not null default 'querydown';

create unique index preset_single_default on app.preset (
  base_table,
  section,
  (case when is_default and section in ('sort', 'display') then true end)
);
