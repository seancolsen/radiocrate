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
- Use the same "Sort" and "Filter" UI present for queries in order to apply additional sorting and filtering conditions on top of the list of tracks as stored in the playlist.
- Commit the sorting and/or filtering conditions to modify the defined list of tracks as stored in a playlist (thus removing the sorting and/or filtering conditions).

## Data model changes

Currently in the database we have a table named "query". Most of the fields in this table are relevant for both queries and playlists. As such, there is some polymorphism between "query" and "playlist", which is reflected in the schema with the introduction of a common "source" table.

```sql
create table query (
  id uuid primary key,
  definition text
);

create table playlist (
  id uuid primary key,
  definition text
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

The `playlist.definition` column is a JSON column with a similar structure to `query.definition` except for the fact that it will not have a field for the base table.

## No ephemeral playlists

Unlike queries, playlists will need to be saved before they can become usable by the user. This is due to the requirement that `playlist_track` records be present in the database.

## Converting a query into a playlist

- Add a new Command-palette command labeled "Query: Convert to playlist". Do not assign a keyboard shortcut.
- Also make the "convert to playlist" command available from the query actions menu (the wrench/build icon within the query page toolbar).
- A new playlist should be created with the same name as its originating query.
- When creating a new playlist, we should add `playlist_track` records for all the tracks in the playlist, and we should initialize the `order` value with sequential integers. (This is a `double` so that we can easily re-sort entries by modifying only the entries being rearranged.)

## Listing playlists and queries in the explorer

- The Explorer sidebar has a section labeled "Queries". Change the terminology for this section to "Sources". Make the change in the code and the UI.
- Display queries and playlists alongside one another, as different kinds of "source" items within the same tree of sources.
- Use different icons to distinguish visually between the different kinds of sources.

## Creating a new playlist from scratch

- In the explorer, in the dropdown menu as well as the context menu for folders, add a "Add playlist" option.
- In the application tab bar, modify the new tab button Such that it opens a drop down allowing the user to select a new query or new playlist.
- When the user creates a new playlist,the playlist should be immediately saved using a timestamp as its name, and it should be placed at the top of the sources list. The playlist should become open as a tab.

## Other CRUD on playlists from the explorer

- As with queries, the user should be able to rename, delete, and duplicate playlists from the explorer sidebar. Follow the same UX that we already have for queries.

## Adding tracks to a playlist

The user should be able to add one or multiple track(s) to a specific playlist from any query or playlist result set. After selecting the track(s) within the results, the user should be able to perform either of the following actions:

- Drag selected tracks into the playlist entry in the sources tree.

- Choose "Add to playlist" from the context menu.

    This opens a modal with a sources tree that only shows playlists. The tree omits the display of any folders which don't have a playlist as a descendant. The tree expansion state is identical to that within the explorer. The user is free to expand and collapse tree items, but those expansion visibility changes do not persist outside the playlist selection modal.

    Single-clicking a playlist selects the playlist, adds the tracks to it, and closes the modal.

Note that the overall playlist feature design currently lacks a flow for adding new tracks to a playlist from directly within the playlist page itself. This is okay. (Basically the user needs to open a new query tab and drag tracks between tabs.)

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

Filtering a playlist should work much in the same way as filtering a query of tracks. Some differences are noted below...

- No filtering presets should be applied by default initially.
- All filtering presets defined for queries of tracks should be available for playlists.
- When no filters are applied, the user should see all of the tracks as stored in the playlist via the `playlist_track` entries.
- After the user has modified the filter conditions, immediately re-run the query (with debouncing). Then queue a lazy network request to auto-save the playlist record (just like we do for queries).
- When any filter is applied, render the following buttons at the bottom of the filter builder UI:
    - "Delete these tracks" (with a `delete` icon)
    - "Keep only these tracks" (with a `check` icon)

### Sorting a playlist via sorting conditions

Sorting a playlist should work much in the same way as sorting a query of tracks. Some differences are noted below...

- No sorting preset should be applied by default initially.
- All sorting presets defined for queries of tracks should be available for playlists.
- When no sorting conditions are applied, the user should see all of the tracks in the playlist, in the order in which they are stored in the playlist.
- In the sort strategy drop down menu, display a new radio button at the top labeled "Playlist order". Make this the default sorting strategy.
- After the user has modified the sorting conditions, immediately re-run the query (with debouncing). Then queue a lazy network request to auto-save the playlist record (just like we do for queries).
- When any sorting conditions are applied, render the following button at the bottom of the sort builder UI:
    - "Commit this track order to playlist" (with a `check` icon)

### Customizing the display of track fields within a playlist

The "Display" builder should function identically to a query of `track` records.

### Manually removing tracks from a playlist

When one or more tracks are selected, the user should be able to remove them from the playlist using any of the following actions:

- A command pallette action "Playlist: remove selected tracks". By default this should be bound to the `Delete` key when the results have focus (but that should be configurable through our keyboard shortcut system).

- A "Remove from playlist" entry on the result row context menu (with a `delete` icon).

### Manually rearranging tracks in a playlist

- The user should be able to drag to re-arrange tracks within a playlist.
- The drag-and-drop UX should be as similar as possible to the UX we already have for rearranging source items within the explorer.
- When tracks are rearranged, the frontend should do the following:
    1. Immediately mutate the saved query result set to commit the order as the user intended. This will update the UI optimistically and instantaneously.
    2. Use the API to immediately update the `playlist_track.order` values for all the tracks being dragged. We should look at the order value for the tracks before and after the drop position and update the order values for the tracks being dragged such that they fit in between the values. For example, if we're dragging three tracks in between two tracks that have orders `6` and `7` then the three tracks should get updated such that their orders become `6.25`, `6.5`, and `6.75`. Do this with a single API request. Wait until it's complete before proceeding.
    3. Reload the playlist results.
- To avoid race conditions, the frontend should block re-ordering operations while a re-ordering operation is currently in progress (i.e. if any of the steps above are still running.)
- If the user manually reorders tracks when the playlist query has sorting conditions applied, then the sorting conditions should be committed to the playlist first and then the user's desired manual rearrangement change should be applied thereafter.

### Undo/redo within playlists

- Within the playlist page, a single undo stack should store all of the changes to the playlist as state transformations which can be applied and un-applied. This should include all DML on the `playlist` and `playlist_track` tables that the user performs from within the playlist page. For example, if the user deletes tracks from the playlist, we'll need to store the state of those `playlist_track` records in the undo stack so that the track entries can be restored.

- Note that it's possible (perhaps even likely) that the undo/redo mechanics within the query builder is built upon a snapshot-based state sequence. If that's the case, then it likely won't be the optimal approach here due to the fact that we'll be mutating `playlist_track` entries in addition to `playlist` and `source` entries. Consider ways of refactoring the undo/redo system as necessary to reuse code in a clean way across the "playlist" and "query" abstractions.

### The record editor within the playlist page

Because the playlist query is listing `playlist_track` records, editing one of these records in the query page would show a tree of fields with `id`, `playlist`, `track`, and `order` at the top level. Within the playlist page, we'd like to make it more intuitive for the user to edit the related `track` record without the additional indirection of expanding that field within the record editor. There is no need for the user to edit any of the other `playlist_track` fields from the record editor. So within the playlist page, the record editor should "begin" at the related `track` record, not the `playlist_track` record. Make sure to find a clean way to implement this so that we share as much code as possible across the query page and the playlist page.

## Changes to touch interactions for query record rows

We need to support the new capability of dragging tracks from the result view into playlist source entries — and into other positions within the results (in the case of a playlist). As such, we need to adjust the touch interaction of query record rows.

Currently, touch-hold opens the context menu for the selected records.

We need to adjust this to behave as it currently does in the explorer.

- Touch-drag should scroll.
- Touch-hold should initiate a drag operation.
- Touch-hold-release should open the context menu.



