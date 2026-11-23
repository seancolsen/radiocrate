-- The app's default customizations, so that a new library starts out set up
-- for its music rather than bare: the record editor's fields arranged, the
-- tables ordered with a record picker each, a few contextual queries, and
-- presets for every table, applied by default where it has one.
--
-- This migration only inserts rows, all of them into tables that are empty in
-- a database that has never been customized, and touches nothing else. A
-- database whose metadata was customized before this release can be left at
-- its own by skipping this migration (setting `meta.version` to 20 by hand).
--
-- Whatever the app can define in code is defined there instead, so that a
-- later release can change it without a migration: the computed columns
-- (`frontend/src/query/computedColumns.ts`), the custom comparisons
-- (`customComparisons.ts`), and each table's text search and linked record
-- comparison (`tableSettings.ts`). What's here is what has no such default.
--
-- Fields name the app's computed columns, and contextual queries are keyed by
-- the ids below, which `metadata.field` refers to. Presets are written against
-- the app's computed columns and table settings too.

insert into metadata."table"
  (schema_name, table_name, visible, "order", record_picker_sorting, record_picker_display)
values
  ('main', 'track', true, -1, '\\play_count \d \\id', '$title
$main_artists @{color:light}'),
  ('main', 'artist', true, 0, '\\track_count \d \\id', '$name
$#track @{suffix:['' track'' '' tracks''] size:small color:light width:55 align:right}'),
  ('main', 'album', true, 0.5, '\\#play \d \\title \\id', '$title
$year @{width:30 color:light size:small}
$main_artists @{color:light width:[100 200]}'),
  ('main', 'credit', true, 5, null, null),
  ('main', 'role', true, 5.25, '\\#credit \d \\id', '$name
$#credit @{size:small color:light suffix:['' credit'' '' credits''] width:55 align:right}'),
  ('main', 'tag', true, 5.5, '\\#track_tag \d \\id', '$name
$#track_tag @{size:small color:light suffix:['' track'' '' tracks''] width:55 align:right}'),
  ('main', 'track_tag', true, 5.75, null, null),
  ('main', 'file', true, 6, null, null),
  ('main', 'play', true, 7, null, null),
  ('main', 'rating', true, 7.5, null, null);

insert into metadata.contextual_query (id, table_name, name, query)
values
  ('bd2943ee-b7ed-482b-aa1a-5e189764e839', 'artist', 'albums', '{"base":"album","filter":{"custom":"++#track{++#credit{artist.id:@id}}","presets":[]},"sort":{"custom":"\\\\year \\d"},"display":{"custom":"$title $year @{width:35 color:light}"}}'),
  ('276954a9-0032-4786-97cd-d0a9cb297d0b', 'artist', 'tags', '{"base":"tag","filter":{"custom":"++#track_tag{track{++#credit{artist.id:@id}}}","presets":[]},"sort":{"custom":"\\\\#track{++#credit{artist.id:@id}} \\d\n\\\\name \\\\id"},"display":{"custom":"$name\n$#track{++#credit{artist.id:@id}} @{size:small color:light width:20 align:right}"}}'),
  ('c605f7f5-3f69-4a95-94d8-f71fe1ddf374', 'album', 'tags', '{"base":"tag","filter":{"custom":"++#track_tag{track.album.id:@id}","presets":[]},"sort":{"custom":"\\\\#track{album.id:@id} \\d\n\\\\name \\\\id"},"display":{"custom":"$name\n$#track{album.id:@id} @{size:small color:light width:20 align:right}"}}');

insert into metadata.field (schema_name, table_name, field, visible, "order", display, sorting)
select 'main', table_name, union_value(column_name := value), visible, "order", display, sorting
from (values
  ('album', 'id', false, 1, null, null),
  ('album', 'title', true, 2, null, null),
  ('album', 'year', true, 3, null, null),
  ('artist', 'id', false, 1, null, null),
  ('artist', 'name', true, 2, null, null),
  ('credit', 'track', true, null, '$title', null),
  ('file', 'id', false, null, null, null),
  ('file', 'hash', false, null, null, null),
  ('file', 'mtime', false, null, null, null),
  ('play', 'track', true, null, '$title', null),
  ('rating', 'id', false, null, null, null),
  ('role', 'id', false, null, null, null),
  ('tag', 'id', false, 1, null, null),
  ('tag', 'name', true, 2, null, null),
  ('track', 'id', false, 1, null, null),
  ('track', 'title', true, 2, null, null),
  ('track', 'start_position', false, 5, null, null),
  ('track', 'end_position', false, 6, null, null),
  ('track', 'album', true, 7, '$title', null),
  ('track', 'rating', true, 10, '$value $symbol $description', null),
  ('track', 'disc_number', true, 15, null, null),
  ('track', 'track_number', true, 16, null, null),
  ('track', 'file', true, 19, '$path @{truncate:start}', null),
  ('track_tag', 'track', true, null, '$title', null)
) as v (table_name, value, visible, "order", display, sorting);

insert into metadata.field (schema_name, table_name, field, visible, "order", display, sorting)
select 'main', table_name, union_value(multi_link := value), visible, "order", display, sorting
from (values
  ('album', {'related_table_name': 'track', 'fk_column_name': 'album'}, true, 4, '$track_number @{prefix:''#'' size:small color:light width:20 align:right}
$title', '\\disc_number
\\track_number
\\id'),
  ('artist', {'related_table_name': 'credit', 'fk_column_name': 'artist'}, true, 3, '$track.title
$role.name @{size:small align:right color:light width:[30 100]}', null),
  ('role', {'related_table_name': 'credit', 'fk_column_name': 'role'}, true, null, '$artist.name $track.title', null),
  ('tag', {'related_table_name': 'track_tag', 'fk_column_name': 'tag'}, true, 3, '$track.title
$track.main_artists @{size:small color:light}', '\\track.play_count \d
\\track.last_play \d
\\track.id'),
  ('track', {'related_table_name': 'credit', 'fk_column_name': 'track'}, true, 4, '$artist.name
$role.name @{color:light size:small width:60}', null),
  ('track', {'related_table_name': 'play', 'fk_column_name': 'track'}, true, 14, null, null),
  ('track', {'related_table_name': 'track_tag', 'fk_column_name': 'track'}, true, 18, null, '\\tag.#track \d')
) as v (table_name, value, visible, "order", display, sorting);

insert into metadata.field (schema_name, table_name, field, visible, "order", display, sorting)
select 'main', table_name, union_value(computed_column := value), visible, "order", display, sorting
from (values
  ('album', 'main_artists', true, 1.5, null, null),
  ('album', 'duration', true, 4.5, null, null),
  ('album', 'added', true, 6, null, null),
  ('album', 'first_play', true, 7, null, null),
  ('album', 'last_play', true, 8, null, null),
  ('album', 'play_count', true, 9, null, null),
  ('album', 'track_count', false, 10, null, null),
  ('album', 'avg_rating', true, 11, null, null),
  ('artist', 'added', true, 5, null, null),
  ('artist', 'first_play', true, 6, null, null),
  ('artist', 'last_play', true, 7, null, null),
  ('artist', 'play_count', true, 8, null, null),
  ('artist', 'album_count', false, 9, null, null),
  ('artist', 'track_count', false, 10, null, null),
  ('artist', 'avg_rating', true, 11, null, null),
  ('tag', 'track_count', true, 2.5, null, null),
  ('track', 'main_artists', true, 3, null, null),
  ('track', 'year', true, 8, null, null),
  ('track', 'duration', true, 9, null, null),
  ('track', 'added', true, 11, null, null),
  ('track', 'last_play', true, 12, null, null),
  ('track', 'play_count', false, 13, null, null),
  ('track', 'tags', true, 17, null, null),
  ('track', 'first_play', false, 21, null, null),
  ('track', 'artists', false, 22, null, null)
) as v (table_name, value, visible, "order", display, sorting);

insert into metadata.field (schema_name, table_name, field, visible, "order", display, sorting)
select 'main', table_name, union_value(contextual_query := value), visible, "order", display, sorting
from (values
  ('album', 'c605f7f5-3f69-4a95-94d8-f71fe1ddf374'::uuid, true, 5, null, null),
  ('artist', 'bd2943ee-b7ed-482b-aa1a-5e189764e839'::uuid, true, 4, null, null),
  ('artist', '276954a9-0032-4786-97cd-d0a9cb297d0b'::uuid, true, 12, null, null)
) as v (table_name, value, visible, "order", display, sorting);

insert into app.preset (id, name, base_table, section, definition, is_default, created_at, modified_at)
select id::uuid, name, base_table, section, definition, is_default, now()::timestamp_s, now()::timestamp_s
from (values
  ('e6c56c27-1c41-4b26-96a6-3b114ad2ba37', 'Basic', 'album', 'display', '$id @{hide:yes}
$title @{width:[150 200]}
$year @{width:35}
$main_artists @{width:[200 300]}
$track_count @{suffix:[" track" " tracks"] width:50 color:light size:small align:right}
$play_count @{suffix:['' play'' '' plays''] width:55 align:right color:light size:small}
$avg_rating @{suffix:'' avg rating'' size:small color:light formatter:{type:number decimalPlaces:1} width:70 align:right}
$added @{width:90 prefix:''added '' formatter:{type:relativeTime} color:light size:small}', true),
  ('33368d96-cbcf-4464-a8b8-42160b642d02', 'Added recently', 'album', 'filter', 'added:<6m', false),
  ('39265b89-7e0f-4663-b01d-965a87aefbcb', 'artist, year', 'album', 'sort', '\\main_artists \\year \d \\title \\id', true),
  ('fb900a96-9e8f-4bdf-9d6a-7647763ff035', 'year', 'album', 'sort', '\\year \d
\\id', false),
  ('e36ed370-671d-4b9b-af2e-d80cf4d38eac', 'Basic', 'artist', 'display', '$id @{hide:yes}
$name @{width:[200 300]}
$album_count @{suffix:[" album" " albums"] width:50 color:light size:small align:right}
$track_count @{suffix:[" track" " tracks"] width:50 color:light size:small align:right}
$play_count @{suffix:['' play'' '' plays''] width:55 align:right color:light size:small}
$avg_rating @{suffix:'' avg rating'' size:small color:light formatter:{type:number decimalPlaces:1} width:70 align:right}', true),
  ('538f4baa-9442-4528-8321-5ec86bdbadac', 'New', 'artist', 'filter', 'added:<6m', false),
  ('4256c6c8-1316-4a05-82c1-394b6e192e9a', 'name', 'artist', 'sort', '\\name', true),
  ('894533bf-bc90-4df4-8978-5d691bcd204e', 'Basic', 'credit', 'display', '$track @{hide:yes}
$artist @{hide:yes}
$artist.name @{width:[200 300]}
$track.title @{width:[200 400]}
$track.album.title @{size:small color:light width:[100 200]}
$role.name|if_null(''Main artist'') @{prefix:''('' suffix:'')'' size:small color:light width:70}
$order @{prefix:''#'' size:small color:light width:20}', true),
  ('fef0c7c9-51b6-4a2a-8f39-b204020c0ddd', 'artist, album', 'credit', 'sort', '\\artist.name
\\track.album.year
\\track.album.title
\\track.disc_number
\\track.track_number
\\track.id', true),
  ('d85ed9b5-ba1c-4c2c-8504-bf492e717ead', 'Path', 'file', 'display', '$id @{hide:yes}
$path @{truncate:start}', true),
  ('0b02102a-5b21-4f32-88d7-9c0deffbfb9d', 'Path', 'file', 'sort', '\\path', true),
  ('840c808e-8bbd-4cd9-bdc9-e24a905686f8', 'Basic', 'play', 'display', '$track @{hide:yes}
$track.id @{hide:yes}
$timestamp \sd @{width:150 formatter:{type:relativeTime} prefix:"played " color:light}
$track.title @{width:[200 300]}
$track.artists @{width:[200 400]}
$track.rating.symbol @{width:20 align:center}', true),
  ('3cd9cf37-c527-4714-94d1-84110ce5af91', 'recent first', 'play', 'sort', '\\timestamp \d \\track.id', true),
  ('bf1c49e7-e474-4de0-ac29-8aedc7370dff', 'Basic', 'rating', 'display', '$id @{hide:yes}
$value $symbol
$description
$#track @{suffix:'' tracks'' color:light size:small}', true),
  ('fd861e2c-bcd1-4739-8787-ae496a0cf7ce', 'value', 'rating', 'sort', '\\value', true),
  ('d9d8effa-db90-44df-b05e-a437783812fa', 'Basic', 'role', 'display', '$id @{hide:yes}
$name
$#credit @{color:light suffix:['' credit'' '' credits'']}', true),
  ('703c3274-7563-4f35-a13e-97f658de3e87', 'Name', 'role', 'sort', '\\name', true),
  ('b7b6bd87-6bd8-47ec-9726-a0d4d9ad4c35', 'Basic', 'tag', 'display', '$id @{hide:yes}
$name
$track_count @{suffix:['' track'' '' tracks''] color:light}', true),
  ('9e183b70-0bf4-4d6f-81a1-61b6ae230e8b', 'Most tracks', 'tag', 'sort', '\\track_count \d', false),
  ('50314136-f8d9-4257-be79-6aab2e3a489c', 'Name', 'tag', 'sort', '\\name', true),
  ('664c00e4-5d71-4c05-bfda-fe106f0701e5', 'Basic', 'track', 'display', '$id @{hide:yes}
$artists @{width:[120 400]}
$title @{width:[100 400]}
$year @{width:35}
$duration @{width:30 align:right size:small formatter:{type:duration}}
$rating.symbol @{width:20 align:center}
$play_count @{suffix:''𝅘𝅥𝅮'' width:25 align:right}
$last_play @{width:[80 150] formatter:{type:relativeTime}}', true),
  ('84c4fda4-6a74-4089-b387-e14222fb82c1', 'Good', 'track', 'filter', '!rating:<0', true),
  ('bf14d5ab-af20-4650-ae80-19fbc67aae34', 'Great', 'track', 'filter', 'rating:>0', false),
  ('1cd6e574-1713-45a1-b7a4-14b6ddaca5ea', 'Not played', 'track', 'filter', 'play_count:0', false),
  ('2fc3a8ca-6c23-4351-8c90-19e2c03c712e', 'Not played recently', 'track', 'filter', '!last_play:<1m', false),
  ('3203d50f-42c1-468c-b604-5673356e872c', 'Added recently', 'track', 'sort', '\\added \d
\\album.year
\\album.title
\\album.id
\\disc_number
\\track_number
\\id', false),
  ('a3f60c66-b4b3-4473-b327-ce58fac140f1', 'Artist, album, year', 'track', 'sort', '\\album.main_artists
\\album.year \d
\\album.title
\\disc_number
\\track_number', false),
  ('34d394c5-7a7b-4ca4-8589-09a7b3a2fc36', 'Basic', 'track_tag', 'display', '$track @{hide:yes}
$tag @{hide:yes}
$track.main_artists @{size:small width:[100 200]}
$track.title
$tag.name @{width:[150 300]}', true),
  ('e22b3dfa-b4c9-4bd5-b9e7-614d49e5d963', 'Most popular', 'track_tag', 'sort', '\\track.#play \d
\\track.id
\\tag.track_count \d
\\tag.id', true)
) as v (id, name, base_table, section, definition, is_default);
