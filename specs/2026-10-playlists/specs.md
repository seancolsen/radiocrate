# Playlists

The app currently lets the user create and save queries. This document specifies a new feature that lets the user create and save playlists alongside their saved queries.

A query's tracks are whatever its conditions select, in whatever order its sorting produces. A playlist's tracks are an explicit, stored list in a manually maintained order. The user can still view that list through filtering and sorting conditions, and can commit those conditions into the list itself.

## Terminology and iconography

- A "source" is either a playlist or a query. Every playlist is a source, and so is every saved query. Users can add, remove, rename and rearrange their sources.
- Use the `queue_music` icon to represent a playlist everywhere a playlist appears: the sources tree, the explorer's "Opened" list, tab handles, and the "Add to playlist" modal.

## High-level product goals

These are the features we need to support:

- Add an empty playlist
- Delete a playlist
- Rename a playlist
- Duplicate a playlist
- View saved playlists within the tree of sources
- Visually distinguish a saved playlist from a saved query within the tree of sources
- Rearrange saved playlists within the tree of sources
- Manually add tracks to a playlist after selecting them from within a query or playlist
- Convert a query into a playlist
- Select and remove tracks from a playlist
- Manually rearrange tracks within a playlist
- Play tracks from a playlist, as from a query
- Modify the display fields of a playlist, as with a query
- Use the same "Sort" and "Filter" UI present for queries to apply additional sorting and filtering conditions on top of the list of tracks stored in the playlist
- Commit the sorting and/or filtering conditions to modify the list of tracks stored in a playlist (which then removes the sorting and/or filtering conditions)
- Undo and redo every change made from within the playlist page

## Data model changes

Currently the database has a table named `query`, and most of its columns are relevant to both queries and playlists. The schema expresses this polymorphism with a new common `source` table that holds the shared columns, while `query` and `playlist` hold only what is specific to each.

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
  position double not null default 0
);

create table source (
  id uuid primary key,
  name text not null,
  created_at timestamp_s not null,
  modified_at timestamp_s not null,
  last_play timestamp_s not null,
  source_folder uuid,                -- the containing folder, or null at the top level
  position integer not null default 0, -- the sort key among siblings, as today
  query uuid unique,
  playlist uuid unique,
  CHECK ((query IS NULL) <> (playlist IS NULL))
);
```

Notes:

- **Identity.** The frontend identifies a source by `source.id` everywhere (tabs, tree items, ordering, `last_play`), and reaches the query or playlist through `source.query` / `source.playlist`. No code assumes that these ids are equal. The migration reuses each existing query's id as its source's id, purely so that open tabs persisted in `localStorage` survive the upgrade.
- **Folders.** Rename `query_folder` to `source_folder`. Folders and sources share one sibling order, just as folders and queries do today. A source names its folder in `source.source_folder`, a folder names its parent folder in `source_folder.parent`, and both carry a `position`.
- **Migration.** Create a `source` row for every existing `query` row, carrying over `name`, the three timestamps, `position`, and `parent` (into `source_folder`). Then drop those columns from `query`. Following the established rule for our migrations, do every read and schema change before any backfill (DuckDB refuses to commit an `ALTER TABLE` on a table that the same transaction has already updated).
- **Links.** Under the existing naming convention (a UUID column named after a table references that table's `id`), `playlist_track.playlist`, `playlist_track.track`, `source.query`, `source.playlist` and `source.source_folder` are all inferred links. Querydown and the record editor rely on this.
- **Invariants.** The schema, not application code, enforces the polymorphism, so that writes made through the record editor's generic DML respect it too. The `CHECK` makes every source wrap exactly one query or playlist, and the `unique` constraints stop two sources from wrapping the same one (DuckDB allows any number of NULLs in a unique column). The schema can't stop a `query` or `playlist` row from having no source at all. Such a row is harmless (it just never appears in the explorer), so we accept the gap.
- **Duplicates.** A playlist may contain the same track more than once. Each occurrence is its own `playlist_track` record.
- **Playlist definition.** The `playlist.definition` column holds JSON with the same structure as `query.definition`, except that it has no base table (the base is always `track`). It also has no "full Querydown" mode: a playlist's definition is always sectioned into filter, sort and display.

## No ephemeral playlists

Unlike queries, a playlist is saved before the user can use it, because its tracks only exist as `playlist_track` records in the database. Every operation that creates a playlist (adding one, duplicating one, converting a query) therefore persists it immediately, and a playlist tab never shows the "unsaved" state that a new query does.

## Writing playlist entries

Each operation that creates, deletes, or changes a playlist's tracks is sent as a single API request that applies all of its writes in one transaction. Examples are creating the `source`, `playlist` and `playlist_track` records together, or rewriting every `position` value at once.

The frontend works out these writes and sends them through the existing generic `dml` method. We don't add playlist-specific endpoints. The frontend already has what it needs: to commit a sort, for example, it runs the sorted query anyway, so it holds every entry's id along with its old and new position. Undo needs those old values too.

Each operation that can touch many entries lives behind a single frontend function, so that how its writes are sent can change later in one place. These operations are: converting a query, duplicating a playlist, committing a sort, "Remove these tracks", "Keep only these tracks", and undoing or redoing any of them.

Scale:

- We support playlists of up to about 5,000 tracks for now. At that size, every operation fits in one request under the server's default 2 MB request limit: an update is about 140 bytes and an insert about 230 bytes. We don't split operations across requests, and we don't raise the limit.
- Larger playlists are out of scope. An operation whose request goes over the limit (for example, converting a query of 10,000 tracks) fails without writing anything, and the error is reported as any other failed request is.
- `dml` runs one statement per row, about 0.6–0.75 ms each in a release build, and it holds the shared database connection for the whole transaction. Rewriting 5,000 positions therefore blocks other requests for a few seconds. We accept that for now. If it becomes a problem, the first fix is generic bulk operations in `dml` (a multi-row update run as one `UPDATE … FROM (VALUES …)`, and a bulk insert). Those stay driven by introspection, and the frontend functions above switch to them.

## Listing playlists and queries in the explorer

- The Explorer sidebar has a section labeled "Queries". Rename this section to "Sources", in both the code and the UI. This includes the section's filter input ("Filter sources"), which matches playlists by name just as it does queries.
- Display queries and playlists alongside one another, as different kinds of source within the same tree.
- Use a different icon for each kind of source so that the user can tell them apart.
- The user rearranges playlists within the tree (and moves them between folders) with the same drag-and-drop UX that queries already have.

## Creating a new playlist from scratch

- In the explorer, add an "Add playlist" option to the section's dropdown menu and to the context menu for folders.
- In the application tab bar, change the new tab button so that it opens a dropdown where the user chooses "New query" or "New playlist".
- When the user creates a new playlist, it is saved immediately. Its name is the current timestamp, in the same `YYYY-MM-DD HH:MM` format used to name new queries. It is placed at the top of its folder: the folder whose context menu created it, or the top level of the sources tree otherwise. The playlist opens in a new tab, which becomes active.
- A new playlist has no filter conditions, sorting set to "Playlist order", and the default `track` display preset (the same display a new query of tracks starts with).

## Other CRUD on playlists from the explorer

As with queries, the user can rename, delete, and duplicate playlists from the explorer sidebar. Follow the same UX that we already have for queries, with these differences:

- **Delete** removes the playlist's `playlist_track` records, its `source` record and its `playlist` record, all in one request. If the playlist is open in a tab, that tab closes.
- **Duplicate** cannot open an unsaved copy the way it does for queries. It immediately saves a new playlist with the same name, definition and tracks (new `playlist_track` records with the same `track` and `position` values). The copy goes at the top of the original's folder and opens in a new tab.
- **Rename** works as it does for queries, from the explorer as well as from the tab handle and the page's wrench menu.

## Converting a query into a playlist

- Add a new command-palette command labeled "Query: Convert to playlist". Do not assign it a keyboard shortcut.
- Also make the command available from the query actions menu (the wrench/build icon in the query page toolbar).
- The command is only available when the query's current results are tracks, meaning they carry a track id column (the same condition that makes rows playable). It is unavailable while the query is running or after it has failed.
- The command creates a new playlist with the same name as the query, at the top of the query's folder (or the top level, for an unsaved query). It opens in a new tab next to the query's tab. The original query is left unchanged.
- The new playlist gets one `playlist_track` record for each row of the query's current results, in the order they are displayed. Initialize the `position` values with sequential integers starting at 1. The column is a `double` so that rearranging entries later only requires changing the entries that move.
- The new playlist has no filter conditions and its sorting is set to "Playlist order", since both of these are now baked into the track list. If the query's base is `track`, the playlist copies the query's display section. Otherwise it uses the default `track` display preset.

## Adding tracks to a playlist

The user can add one or more tracks to a specific playlist from any query or playlist results, provided those results carry a track id column. After selecting the track(s) within the results, the user can do either of the following:

- Drag the selected tracks onto the playlist's entry in the sources tree. Only playlist entries accept the drop. The playlist that the rows came from does not accept it either, since that drag is a rearrangement within the page instead (see below).

- Choose "Add to playlist…" from the result row context menu.

    This opens a modal containing a sources tree that shows only playlists. The tree omits any folder that doesn't have a playlist as a descendant. Its expansion state starts out identical to the explorer's. The user can expand and collapse tree items, but those changes don't persist outside the modal.

    Single-clicking a playlist adds the tracks to it and closes the modal. Pressing Escape or clicking outside the modal closes it without adding anything.

There is no flow for adding tracks to a playlist from within the playlist page itself, and that's okay. To add tracks, the user opens a query in another tab, selects tracks there, and drags them onto the playlist's entry in the sources tree (or uses "Add to playlist…").

When adding tracks to a playlist, compute their `position` values as follows:

1. Read the playlist's `playlist_track` entries to find the maximum `position` value.
1. Give the new `playlist_track` records consecutive integers, starting one above the integer ceiling of that maximum (or at 1 for an empty playlist). This adds the tracks at the _end_ of the playlist.
1. The added tracks keep the order they had relative to one another in the results they were selected from.

If the target playlist is open in a tab, that tab reloads its results afterwards. Adding tracks from outside a playlist's page doesn't add an entry to that page's undo stack.

## The playlist page

The playlist page is nearly identical to the query page. The differences are described below.

### The playlist tab

- A playlist tab is a new kind of tab, alongside query and shortcuts tabs, and shows the `queue_music` icon.
- The toolbar's wrench menu offers Rename, Duplicate, View SQL and Delete. It omits the query-only entries ("Revert changes", "Convert to playlist", changing the base, and the full-Querydown mode). The Save button and the unsaved ✱ never appear, because a playlist is always saved.

### The playlist query

Like the query page, the playlist page turns user input into a Querydown query, compiles that to SQL, and runs it through the query API. What differs is how the user input is gathered and turned into Querydown.

The generated Querydown looks like this, with the user's `querydown_prelude` setting prepended as it is for queries:

```
#playlist_track

playlist:="d55b955b-6416-440d-bc12-9369c39806d0" // id of the playlist we're viewing

track{
  // the user's filter conditions (custom text and every checked preset), written as they are for tracks
}

\\track.(
  // the user's sorting conditions, written as they are for tracks
)
\\position
\\track.id

$id @{hide:yes}
$position @{hide:yes}
$track.(
  // the user's display definition, written as it is for tracks
)
```

The filter, sort and display slots are filled from the filter, sort and display builders. Because every slot is scoped to the related `track`, the presets defined for `track` work unchanged. Omit the `track{…}` block entirely when there are no filter conditions, because Querydown rejects an empty `{}` block. Empty sort and display blocks are fine.

The hidden `$id` and `$position` columns identify each row's `playlist_track` record and its position. Removing and rearranging tracks depend on them. As with a query of tracks, a row only counts as a track (playable, editable as a track, and addable to playlists) when the user's display includes the track's `$id` exactly once.

### Filtering a playlist

Filtering a playlist works much like filtering a query of tracks, with these differences:

- No filter presets are applied by default, even ones marked as defaults for `track`.
- All filter presets defined for `track` are available.
- When no filter conditions are applied, the user sees every track stored in the playlist through its `playlist_track` entries.
- After the user modifies the filter conditions, re-run the query (debounced) and then queue a lazy network request to auto-save the playlist's definition, just as we do for queries.
- When any filter condition is applied (custom text or at least one preset), render these buttons at the bottom of the filter builder:
    - "Remove these tracks" (with a `delete` icon): removes from the playlist every entry that the filter matches. This is all matching rows, not just the selected ones.
    - "Keep only these tracks" (with a `check` icon): removes from the playlist every entry that the filter _doesn't_ match.

    Both buttons then clear the filter conditions, so the user sees what remains of the playlist. They are disabled while the query is running, after it has failed, or (for "Remove these tracks") when it matched nothing. Each is a single undoable step.

### Sorting a playlist via sorting conditions

Sorting a playlist works much like sorting a query of tracks, with these differences:

- In the sort section's options menu, add a new radio item at the top labeled "Playlist order". This is the default, and it means no sorting conditions are applied.
- No sort preset is applied by default, even one marked as the default for `track`.
- All sort presets defined for `track` are available, including the built-in Shuffle.
- When no sorting conditions are applied, the user sees the tracks in the order they are stored in the playlist. That is the case when "Playlist order" is selected, and also when a custom sort is selected but empty.
- After the user modifies the sorting conditions, re-run the query (debounced) and then queue a lazy network request to auto-save the playlist's definition, just as we do for queries.
- When any sorting conditions are applied, render this button at the bottom of the sort builder:
    - "Commit this track order to playlist" (with a `check` icon)

    Committing rewrites the `position` value of _every_ entry in the playlist to sequential integers starting at 1, following the current sorting conditions. Entries hidden by a filter are reordered too: the order is computed from the playlist query with the sorting conditions but without the filter. Sorting then resets to "Playlist order", and any filter stays as it was. The commit is a single undoable step.

### Customizing the display of track fields within a playlist

The "Display" builder works exactly as it does for a query of `track` records, with the same presets.

### Playing tracks from a playlist

Playback works as it does from a query: double-clicking a row plays it, and the rest of the results, in the order displayed, follow it. Playing from a playlist updates the source's `last_play`, as playing from a query does.

### Manually removing tracks from a playlist

When one or more tracks are selected, the user can remove them from the playlist in either of these ways:

- A command-palette command, "Playlist: Remove selected tracks". By default it is bound to the `Delete` key while the results have focus, and the binding is configurable through our keyboard shortcut system.

- A "Remove from playlist" entry in the result row context menu (with a `delete` icon).

Removing tracks deletes the selected rows' `playlist_track` records (not the `track` records) in one request, and then reloads the results. A removal is a single undoable step.

### Manually rearranging tracks in a playlist

- The user can drag the selected rows to rearrange tracks within a playlist. The rows being dragged keep their current order relative to one another.
- The drag-and-drop UX is as similar as possible to the existing UX for rearranging items in the sources tree, including the drop indicator between rows and auto-scrolling near the edges.
- When tracks are rearranged, the frontend does the following:
    1. Immediately reorder the rows in the in-memory result set to show the order the user intended. This updates the UI optimistically and instantly.
    2. In a single API request, update the `playlist_track.position` values of the tracks being dragged. Wait for the request to finish before continuing. The new values fall between the `position` values of the rows just above and just below the drop position, evenly spaced. For example, dragging three tracks between rows whose positions are `6` and `7` gives them the positions `6.25`, `6.5` and `6.75`.
        - Dropping at the very top gives the tracks consecutive integers ending one below the integer floor of the first row's value. Dropping at the very bottom gives them consecutive integers starting one above the integer ceiling of the last row's value.
        - If the two neighboring values are too close for distinct doubles to fit between them, the same request instead renumbers every entry in the playlist to sequential integers starting at 1, in the new order.
        - When a filter is applied, the neighbors are the adjacent _visible_ rows. Hidden entries keep their values.
    3. Reload the playlist results.
- If the request fails, reload the results so that the UI shows the stored order again, and report the error as other failed requests are reported.
- To avoid race conditions, the frontend blocks a rearrangement while any write to the playlist's tracks is in progress, which includes every step of an earlier rearrangement. Other writes to the same playlist (adds, removals, commits, undo/redo) are queued and run one at a time.
- If the user manually rearranges tracks while sorting conditions are applied, the sorting conditions are committed to the playlist first (as with "Commit this track order to playlist"), and the user's manual rearrangement is applied after that. Together they form one undoable step.

### Undo/redo within playlists

- The playlist page has a single undo stack, using the same Undo and Redo toolbar buttons as the query page. The stack holds every change the user makes to the playlist from within the page as a transformation that can be applied and unapplied. This covers both changes to the playlist's definition (filter, sort and display) and every write to its `playlist_track` records. For example, when the user removes tracks from the playlist, the stack stores those `playlist_track` records in full so that undo can re-insert them with their original ids and `position` values.
- Undoing or redoing a `playlist_track` change sends the inverse (or original) writes as one request, queued like any other write to the playlist, and then reloads the results. If that request fails, the stack's position doesn't move.
- Renaming the playlist is not on the stack, as with queries.
- The query page's undo history is snapshot-based: it records the whole query definition each time the query runs, and undo restores an earlier snapshot. That model doesn't fit playlists, whose changes also include writes to `playlist_track` records. Refactor the undo/redo system as needed so that both pages share one clean abstraction. For example, a query definition snapshot can become one kind of transformation among several.

### The record editor within the playlist page

The playlist query lists `playlist_track` records, so on the query page the record editor would show a tree of fields with `id`, `playlist`, `track`, and `position` at the top level. On the playlist page, the user should be able to edit the related `track` record directly, without first expanding the `track` field, and has no need to edit the other `playlist_track` fields. So within the playlist page, the record editor "begins" at the related `track` record instead of the `playlist_track` record:

- The result row context menu offers "Edit track" (and not "Edit playlist_track"), and the "Results: Edit selected rows" command edits the selected rows' tracks.
- Selecting several rows that hold the same track edits that track once, as the record editor already does for duplicate records.

Find a clean way to implement this that shares as much code as possible between the query page and the playlist page.

## Changes to touch and pointer interactions for result rows

Result rows now need to be draggable: onto playlist entries in the sources tree (from any results), and to other positions within the results (on a playlist page). That requires changing how result rows respond to touch and pointer input, on both query and playlist pages.

Currently, a touch-hold opens the context menu for the selected records. Change this to match the explorer's behavior:

- A touch-drag scrolls.
- A touch-hold picks the rows up and starts a drag.
- A touch-hold followed by a release without moving opens the context menu.

Holding a row that is part of the selection drags the whole selection. Holding an unselected row first selects that row alone. With a mouse or pen, dragging a row past a small threshold starts the same drag (a mouse drag on the results currently does nothing).
