# Playlists

Currently the app has a feature for the user to create and save queries. This document specifies the design and implementation for a new feature that allows the user to create and save playlists alongside the saved queries.

## Terminology and iconography

- We will use the term "source" to encapsulate both playlists and queries. Each playlist is a "source". Each query is a source too. Users will be able to add, remove and rename their sources.
- Use the `queue_music` icon to represent a playlist.

## High-level product goals

These are the features we need to support:

- Add an empty playlist
- Delete a playlist
- Rename a playlist
- View saved playlists within the tree of sources
- Visually distinguish a saved playlist from a saved query within the tree of sources
- Re-arrange saved playlists within the tree of sources
- Manually add tracks to a playlist after selecting them from within a query or playlist
- Convert a query into a playlist
- Select and remove tracks from a playlist
- Manually re-arrange tracks within a playlist
- Modify the display fields of a playlist, as with a query
- Sort/filter the tracks in a playlist (as done within a query) with the sorting/filtering applied ephemerally and easy to restore to the saved order/set as defined within the playlist.
- Commit the ephemeral track sorting/filtering to the defined track order/set as stored in a playlist (thus removing all ephemeral sorting/filtering).

## Data model changes

Currently in the database we have a table named "query". Most of the fields in this table are relevant for both queries and playlists. As such, there is some polymorphism between "query" and "playlist", which is reflected in the schema with the introduction of a common "source" table.

```sql
create table query (
  id uuid primary key,
  definition text -- Structured JSON holding Querydown DSL code, authored by the user
);

create table playlist (
  id uuid primary key,
  display text, -- Structured JSON holding Querydown display definition, for tracks
);

create table playlist_track (
  id uuid primary key,
  playlist uuid not null,
  track uuid not null,
  order double default 0 not null
);

create table source (
  id uuid primary key,
  name text not null,
  created_at timestamp_s not null,
  modified_at timestamp_s not null,
  last_play timestamp_s not null,
  query uuid,
  playlist uuid,
  CHECK ((query IS NULL) <> (playlist IS NULL))
);
```

## CRUD on playlists

TODO

## Converting a query into a playlist

- Add a new Command-palette command labeled "Query: Convert to playlist". Do not assign a keyboard shortcut.
- Also make the "convert to playlist" command available from the query actions menu (the wrench/build icon within the query page toolbar).
- A new playlist should be created with the same name as its originating query.
- When creating a new playlist, we should add `playlist_track` records for all the tracks in the playlist, and we should initialize the `order` value with sequential integers. (This is a `double` so that we can easily re-sort entries by modifying only the entries being rearranged.)

## Changes within the explorer

- The Explorer sidebar has a section labeled "Queries". Change the terminology for this section to "Sources". Make the change in the code and the UI.
- In the dropdown menu, add a "Add playlist" option.
- Display queries and playlists alongside one another, as different kinds of "source" items within the same tree of sources.
- Use different icons to distinguish visually between the different kinds of sources.

## Changes within the tab bar

- Modify the new tab button Such that it opens a drop down allowing the user to select a new query or new playlist.

## Adding tracks to a playlist

After selecting tracks within a playlist or query, the user can do either:

- Drag selected tracks into the playlist entry in the sources tree.

- Choose "Add to playlist" from the context menu.

    This opens a modal with a sources tree that only shows playlists. The tree omits the display of any folders which don't have a playlist as a descendant. The tree expansion state is identical to that within the explorer. The user is free to expand and collapse tree items, but those expansion visibility changes do not persist outside the playlist selection modal.

    Single-clicking a playlist selects the playlist, adds the tracks to it, and closes the modal.

When adding tracks to a playlist, they are added with `order` values computed as follows:

1. The application first reads the `playlist_track` entries for the playlist to determine the max.
1. New `playlist_track` records are inserted with integer values set to increment from the integer ceiling of the maximum preexisting `order` value for the playlist. (This effectively adds tracks at the _end_ of the playlist.)
1. When multiple tracks are added, they get distinct `order` values, incremented by sequential integers, with their respective order as defined relative to one another where they were originally selected.


## The playlist page

The playlist page will actually be nearly identical to the query page! Specific differences are described below.

### The playlist _query_

Just like the query page, the playlist page will use user input to formulate a query in Querydown, convert that querydown to SQL, and run it via the query API. But the way we get gather the user input and transform it into a querydown query is different.

The querydown query that we generate for a playlist should look like this:

```
#playlist_track

playlist.id:'d55b955b-6416-440d-bc12-9369c39806d0'; // id from the playlist we're viewing

track{
  // put any user-authored filter definition here, as defined for tracks
}

\\track.(
  // put any user-authored sort definition here, as defined for tracks
)
\\order
\\track.id

$id @{hide:yes}
$order @{hide:yes}
$track.(
  // put any user-authored display definition here, as defined for tracks
)
```

As you can see we have slots in this query template for filter, sort and display. These strings should come from the user, from the filter, sort and display UI. 

### Filtering a playlist

- Filtering a playlist should work much in the same way as filtering a query of tracks. Some differences are noted below...
- No filtering presets should be applied by default initially.
- All filtering presets defined for queries of tracks should be available for playlists.
- When no filters are applied, the user should see all of the tracks in the playlist. 
- Any filters the user configures for a playlist should be stored ephemerally only in the playlist tab. The filters should not be saved to the playlist record stored in the database.

### Sorting a playlist

- Sorting a playlist should work much in the same way as sorting a query of tracks. Some differences are noted below...
- No sorting preset should be applied by default initially.
- All sorting presets defined for queries of tracks should be available for playlists.
- When no sorting conditions are applied, the user should see all of the tracks in the playlist, in the order in which they are stored in the playlist.
- Any sorting conditions the user configures for a playlist should be stored ephemerally only in the playlist tab. The sorting conditions should not be saved to the playlist record stored in the database.
- In the sort strategy drop down menu, display a new radio button at the top labeled "Playlist order". Make this the default sorting strategy.

### Customizing the display of track fields within a playlist

- Unlike filtering and sorting, we do actually want to store the user's customized display options for playlists. That is why we have a field for this in the playlist data model. Thus, the display UI and UX should function identically for playlists to that of track queries. When a user modifies the display configuration for a playlist, the playlist should become unsaved, giving the user the option to save it.

TODO: revisit "save"

### Modifying and saving a playlist

TODO


## Changes to touch interactions for query record rows

We need to support the new capability of dragging tracks from the result view into playlist source entries — and into other positions within the results (in the case of a playlist). As such, we need to adjust the touch interaction of query record rows.

Currently, touch-hold opens the context menu for the selected records.

We need to adjust this to behave as it currently does in the explorer.

- Touch-drag should scroll.
- Touch-hold should initiate a drag operation.
- Touch-hold-release should open the context menu.



