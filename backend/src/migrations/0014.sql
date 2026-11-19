-- Computed columns: Querydown expressions the user names as columns of a table
-- (`#track.lastplay = #play.timestamp%max`), each shown as a field of the record
-- editor on every record of `table_name`. The frontend builds their definitions
-- into the prelude (see `frontend/src/query/computedColumns.ts`).
--
--   table_name -> the table the column is computed for
--   name       -> the column's name, as queries refer to it, and what its
--                 field's metadata is keyed by
--   expression -> Querydown: what the column computes, as the user wrote it
--
-- The app defines some computed columns of its own, in code. A row here naming
-- one of those holds the user's expression for it, in place of the app's, and
-- is null once the user goes back to the app's. Tables are named here as text,
-- as in `metadata.field`, so a column left behind by a dropped table is simply
-- never defined.
--
-- `metadata.field` gains a fourth kind of field, `computed_column`, named rather
-- than referenced: renaming a computed column renames its row there too, in the
-- same transaction (`metadata.computed_column.rename`). DuckDB won't alter a
-- column of a table with an index on it, so the table is rebuilt, as in
-- migration 0012.
--
-- The app's computed columns used to be the default of the `querydown_prelude`
-- setting, so a prelude the user customized carries a copy of them, which would
-- now define each a second time, over whatever the user makes of it from here
-- on. The lines of that default still standing in it, exactly as they were, are
-- taken out — nothing changes about what any query means — and a prelude left
-- with nothing else in it is no customization at all. (`#track.artist:@x`, the
-- last of them, is now a custom comparison the app defines in code too.)

create table metadata.computed_column (
  table_name text not null,
  name text not null,
  expression text,
  primary key (table_name, name)
);

create table metadata.migration_0014_field as select * from metadata.field;

drop table metadata.field;

create table metadata.field (
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
  table_name,
  (union_tag(field)::text),
  (field::text)
);

insert into metadata.field
select table_name, field, visible, "order", display, sorting
from metadata.migration_0014_field;

drop table metadata.migration_0014_field;

update settings.settings
set "value" = array_to_string(
  list_filter(
    string_split("value", chr(10)),
    lambda line: not list_contains(
      [
        '#track.firstplay = #play.timestamp%min',
        '#track.lastplay = #play.timestamp%max',
        '#track.artists = #credit.artist.name%list_all(\\order \\artist.name)',
        '#track.year = album.year',
        '#track.added = file.added',
        '#track.duration = file.duration',
        '#track.playcount = #play',
        '#track.number = track_number',
        '#track.artist:@x = ++#artist{name:@x}'
      ],
      rtrim(line, chr(13))
    )
  ),
  chr(10)
)
where "key" = 'querydown_prelude';

delete from settings.settings
where "key" = 'querydown_prelude' and trim("value", chr(10) || chr(13) || ' ') = '';
