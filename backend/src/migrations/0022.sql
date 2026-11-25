-- Albums the user has decided against, so they know not to download one again.
--
-- An album is ignored as it's deleted, from the "Delete album" dialog: its
-- tracks, files and the rest go as the dialog's choices say, but the `album`
-- record itself stays, with its title and year, and an `ignored_album` record
-- refers to it:
--
--   album     -> the album ignored, one record each
--   timestamp -> when it was ignored (UTC, like every timestamp here)
--   reason    -> why, in the user's words, if they gave one
--
-- Once its tracks are gone, nothing ties the album to its artists any more (an
-- album's artists are its tracks' credits), so `artist_ignored_album` keeps
-- them: the artists credited on its tracks when it was ignored.
--
-- Deleting an ignored album for good (the dialog, with "Ignore" unchecked)
-- takes its `ignored_album` record along, and that its artist links, since
-- neither column can be emptied.

create table ignored_album (
  id uuid primary key,
  album uuid not null unique,
  timestamp timestamp_s not null,
  reason text
);

create table artist_ignored_album (
  artist uuid not null,
  ignored_album uuid not null,
  primary key (artist, ignored_album)
);

insert into metadata.relationship values
  ('main', 'ignored_album', 'album', 'main', 'album'),
  ('main', 'artist_ignored_album', 'artist', 'main', 'artist'),
  ('main', 'artist_ignored_album', 'ignored_album', 'main', 'ignored_album');
