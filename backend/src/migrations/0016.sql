-- The app's own computed columns on tracks are renamed with their words apart,
-- as a name the user types comes out (`last play` is `last_play`):
--
--   firstplay -> first_play
--   lastplay  -> last_play
--   playcount -> play_count
--
-- What the user has made of one under its old name goes with it to the new: their
-- own expression for it in `metadata.computed_column`, and what's customized
-- about its field in `metadata.field`, as renaming a computed column of their own
-- does (`metadata.computed_column.rename`). Where a row on tracks already has
-- the new name, the old one stays as it is: a column of the user's own.
--
-- Querydown text that names the old columns (saved queries, presets, the
-- prelude, other expressions) is left alone, as it is when the user renames a
-- column of their own.

create temporary table migration_0016_rename (old_name text, new_name text);

insert into migration_0016_rename values
  ('firstplay', 'first_play'),
  ('lastplay', 'last_play'),
  ('playcount', 'play_count');

delete from migration_0016_rename as r
where exists (
    select 1 from metadata.computed_column as c
    where c.table_name = 'track' and c.name = r.new_name
  )
  or exists (
    select 1 from metadata.field as f
    where f.table_name = 'track'
      and union_tag(f.field) = 'computed_column'
      and union_extract(f.field, 'computed_column') = r.new_name
  );

update metadata.computed_column as c
set name = r.new_name
from migration_0016_rename as r
where c.table_name = 'track' and c.name = r.old_name;

update metadata.field as f
set field = union_value(computed_column := r.new_name)
from migration_0016_rename as r
where f.table_name = 'track'
  and union_tag(f.field) = 'computed_column'
  and union_extract(f.field, 'computed_column') = r.old_name;

drop table migration_0016_rename;
