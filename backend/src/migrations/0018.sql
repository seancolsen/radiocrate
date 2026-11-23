-- The app's own records, as opposed to the user's music, move out of `main` into a
-- schema of their own, `app`: the saved queries and playlists, the explorer's
-- folders, the presets, and the contextual queries.
--
--   main.contextual_query -> app.contextual_query
--   main.playlist         -> app.playlist
--   main.playlist_track   -> app.playlist_track
--   main.preset           -> app.preset
--   main.query            -> app.query
--   main.source           -> app.source
--   main.source_folder    -> app.source_folder
--
-- `main` is left to the music (tracks, albums, artists, plays, …) and what the
-- user adds beside it, which is what a query is usually about; these tables are
-- still there to query, as `#/app/playlist_track`, and the Data structure page
-- lists them in a folder of their own.
--
-- Links still follow from column names: a column named after a table finds it in
-- its own schema first, then in `main`. So `app.source.query` links to
-- `app.query`, and `app.playlist_track.track` to `main.track`, as before.
--
-- Querydown the user has written that names one of these tables bare
-- (`#playlist_track`) now names nothing: it has to say `#/app/playlist_track`.
-- Rows of `metadata.*` customizing them stay with `main`, naming tables that are
-- no longer there, and are never read.
--
-- DuckDB moves no table between schemas, so each is made anew in `app`, with the
-- same columns and constraints, and its rows copied over before the old one goes.
-- The unique index on `preset` (migration 0007) is made anew with it.

create schema app;

create table app.source_folder (
  id uuid primary key,
  name text not null,
  parent uuid,
  position integer not null default 0
);

insert into app.source_folder
select id, name, parent, position from main.source_folder;

drop table main.source_folder;

create table app.query (
  id uuid primary key,
  definition text
);

insert into app.query select id, definition from main.query;

drop table main.query;

create table app.playlist (
  id uuid primary key,
  definition text
);

insert into app.playlist select id, definition from main.playlist;

drop table main.playlist;

create table app.playlist_track (
  id uuid primary key,
  playlist uuid not null,
  track uuid not null,
  position double not null default 0
);

insert into app.playlist_track
select id, playlist, track, position from main.playlist_track;

drop table main.playlist_track;

create table app.source (
  id uuid primary key,
  name text not null,
  created_at timestamp_s not null,
  modified_at timestamp_s not null,
  last_play timestamp_s not null,
  source_folder uuid,
  position integer not null default 0,
  query uuid unique,
  playlist uuid unique,
  check ((query is null) != (playlist is null))
);

insert into app.source
select
  id, name, created_at, modified_at, last_play, source_folder, position,
  query, playlist
from main.source;

drop table main.source;

create table app.preset (
  id uuid primary key,
  name text not null,
  base_table text not null,
  section text not null,
  definition text not null,
  is_default boolean not null default false,
  created_at timestamp_s not null,
  modified_at timestamp_s not null
);

insert into app.preset
select
  id, name, base_table, section, definition, is_default, created_at,
  modified_at
from main.preset;

drop table main.preset;

create unique index preset_single_default on app.preset (
  base_table,
  section,
  (case when is_default and section in ('sort', 'display') then true end)
);

create table app.contextual_query (
  id uuid primary key,
  table_name text not null,
  name text not null,
  query text
);

insert into app.contextual_query
select id, table_name, name, query from main.contextual_query;

drop table main.contextual_query;
