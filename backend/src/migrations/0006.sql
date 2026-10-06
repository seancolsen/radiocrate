-- Sources: saved queries and playlists side by side in the explorer.
--
-- A "source" is anything the explorer lists and the user can open and play: a
-- saved query, or a playlist (an explicit, ordered list of tracks). The columns
-- the two kinds share move out of `query` into a common `source` table, and
-- `query` and `playlist` keep only what is specific to each:
--
--   source.query / source.playlist -> the one row this source wraps
--   source.source_folder           -> the containing folder, or null at the top level
--   source.position                -> the sort key among its siblings, as in 0005
--
-- The schema enforces the polymorphism, so that writes made through the generic
-- `dml` method respect it too: the `check` makes every source wrap exactly one
-- query or playlist, and the `unique` constraints stop two sources from wrapping
-- the same one. (Nothing stops a `query` or `playlist` row from having no source
-- at all; such a row is harmless, since the explorer never shows it.)
--
-- A playlist's tracks are `playlist_track` rows. The same track may appear more
-- than once, each occurrence its own row. `position` is a double, so that moving
-- entries only rewrites the entries that move.
--
-- Each existing query's source reuses the query's id, purely so that open tabs
-- persisted in the browser (keyed by source id) survive the upgrade. Nothing
-- else assumes the two ids are equal.
--
-- Following `0003`'s rule, every read of `query` comes before the `alter`s:
-- DuckDB refuses to commit an `alter table` on a table the same transaction has
-- already updated.

-- The new tables, and every read of the old ones.
create table source (
  id uuid primary key,
  name text not null,
  created_at timestamp_s not null,
  modified_at timestamp_s not null,
  last_play timestamp_s not null,
  source_folder uuid,
  position integer not null default 0,
  query uuid unique,
  playlist uuid unique,
  check ((query is null) <> (playlist is null))
);

create table playlist (
  id uuid primary key,
  definition text -- Structured JSON like `query.definition`, minus the base table and full mode
);

create table playlist_track (
  id uuid primary key,
  playlist uuid not null,
  track uuid not null,
  position double not null default 0
);

-- `query.position` was nullable (0005).
insert into source (id, name, created_at, modified_at, last_play, source_folder, position, query)
select id, name, created_at, modified_at, last_play, parent, coalesce(position, 0), id from query;

-- Reshape.
alter table query drop column name;
alter table query drop column created_at;
alter table query drop column modified_at;
alter table query drop column last_play;
alter table query drop column parent;
alter table query drop column position;
alter table query_folder rename to source_folder;
