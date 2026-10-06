# Playlists

The app currently lets the user create and save queries. This document specifies a new feature that lets the user create and save playlists alongside their saved queries.

A query's tracks are whatever its conditions select, in whatever order its sorting produces. A playlist's tracks are an explicit, stored list in a manually maintained order. The user can still view that list through filtering and sorting conditions, and can commit those conditions into the list itself.

This document has three parts:

1. **Running the work**: status, the rules every implementation session follows, and the definition of done.
2. **Specification**: what the feature does. These sections are the product spec. Phases implement them and don't redefine them.
3. **Implementation**: cross-cutting findings from research into the codebase, then nine sequential phases. Each phase is sized for one Claude session and ends in one commit on the `playlists` branch.

Run the phases one per session with `/playlist-next` (`.claude/commands/playlist-next.md`).

## Status

Each phase has a status line. Update it when a phase lands, so that a session starting cold doesn't have to reconstruct progress from `git log`. Statuses are `not started`, `in progress` (with a few words on what remains), `awaiting user` (the phase's code has landed but needs something only the user can do, such as a build or a decision), and `done`.

| Phase | Status | Owed by the user |
| ----- | ------ | ---------------- |
| 1 — Schema, migration and source RPCs | done | Back up the real database, start the server so migration 0006 runs, and confirm that saved queries, folders, their order and open tabs all survived. |
| 2 — Playlist query, entry math, lineage fix | not started | |
| 3 — One undo abstraction | not started | |
| 4 — Playlist tabs and the playlist page | not started | |
| 5 — Creating and managing playlists | not started | |
| 6 — Removing tracks and committing conditions | not started | |
| 7 — "Add to playlist…" | not started | |
| 8 — Dragging result rows | not started | |
| 9 — Rearranging tracks within a playlist | not started | |

The "Owed by the user" column lists manual checks and actions that sessions can't do themselves (see "What a session can and can't run" below). They don't block later phases unless the phase says so.

## Starting a phase (read this every session)

1. Read **Status**, this section, **Definition of done**, all of **Implementation notes**, and your phase.
2. Read every earlier phase's **As built** note. They record where reality departed from the plan, and they override the plan text where the two disagree.
3. Read the **Specification** sections your phase lists. The spec is the source of truth for behavior. If the spec and a phase's notes disagree, the spec wins, unless an As-built note records a decision the user made.
4. Read `CLAUDE.md`. Its rules on cargo, React and stores apply throughout. The memory notes listed under "What a session can and can't run" apply too.
5. Do your phase and only your phase. Put anything worth doing that is out of scope under **Deferred follow-ups**.

## Definition of done (every phase)

1. **Rust** (only when the phase touched Rust): `cargo check`, `cargo clippy` and `cargo fmt` are clean, run with **one `-p <crate>` per invocation** (never `--workspace`, and never several `-p` flags at once, which triggers the 20-minute `duckdb-sys` rebuild). Run `cargo test -p <crate>` for each crate whose tests changed. `track-lineage` is its own workspace: run its checks from `track-lineage/` with `--target wasm32-unknown-unknown`.
2. **Frontend**, from `frontend/`: `bun run typecheck`, `bun run lint`, `bun run format:check` (run `bun run format` first), `bun run test:unit`, `bun run build`, and `bun run test:visual`.
3. **Snapshots.** A screenshot that changed without the phase intending it is a bug. Find it, don't regenerate it (memory: "Visual snapshot failures are real"). When a phase *intends* a visual change (it says so in its scope), regenerate only those stories (`bun run test:visual:update --grep "<story>"`), look at every regenerated image, and list each one in the As-built note so the user can review them.
4. **Probe** (from phase 1 on): `bun specs/2026-10-playlists/probe.ts` exits 0. Until the user rebuilds the lineage WASM after phase 2, its lineage checks are expected to fail and its compile/run checks must still pass.
5. **Docs**: the Status row is updated, the phase has an `#### As built` note (what landed, departures from the plan and why, what's left, what the next phase needs to know), and anything deferred is under **Deferred follow-ups**.
6. **One commit** on `playlists`, titled `Playlists, phase N: <title>`.

---

**Part 2: Specification.** The sections from here to "Changes to touch and pointer interactions for result rows" are the product spec.

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

---

**Part 3: Implementation.**

## Implementation notes

Findings from research into the codebase (2026-10-06). The phases below rely on them.

### What a session can and can't run

- **No real backend.** A session may not run `cargo build` or `cargo run`, so it can't start the server. Every Playwright spec mocks `/api/rpc` (the harness through `src/dev/harness/mockApi.ts`, the behavioral specs through `page.route`). Anything that needs a real server goes in the "Owed by the user" column as a manual check.
- **`probe.ts`** (in this folder) stands in for the server where it matters most. It copies the sample collection's database, applies migration `0006.sql` with the `duckdb` CLI, seeds a playlist, introspects the schema exactly as the app does, compiles playlist queries with the vendored Querydown WASM, runs them, and runs the vendored lineage WASM over the SQL. Extend it when a phase adds something it can check (phase 2 points it at the real generator).
- **Cargo.** No phase touches a `Cargo.toml`, so sessions run cargo themselves, with one `-p` per invocation (memory: "cargo check --workspace rebuilds DuckDB"). `cargo xtask gen-api` is safe to run: `xtask` depends only on `api-schema` and `resvg`, never on DuckDB. Linking `cargo test -p backend` can fail with a `rust-lld` relocation error that has nothing to do with the code (memory: "Backend test link failure"). If it does, rely on `cargo check --all-targets` and `cargo clippy --all-targets`, record that in the As-built note, and **never** run `cargo clean -p backend`.
- **WASM builds are the user's.** `track-lineage/build.sh` runs `wasm-pack`, a cargo build, and its output under `frontend/vendor/track-lineage/` is gitignored. A session changes `track-lineage/src/lib.rs`, checks it with `cargo check --target wasm32-unknown-unknown`, and then asks the user to run `./track-lineage/build.sh`.

### The migration (validated draft)

This draft of `backend/src/migrations/0006.sql` applies in one transaction (as `db::run_migration` runs it) to a copy of the sample database on DuckDB 1.5.4, the version the `duckdb` crate bundles. The `CHECK` rejects a source that wraps neither a query nor a playlist, and the `unique` constraints reject two sources wrapping the same query. Writing to the new `source` table and only *reading* `query` before the `ALTER`s keeps to the rule in memory "DuckDB ALTER after UPDATE".

```sql
-- Phase 1: the new tables, and every read of the old ones.
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
create table playlist (id uuid primary key, definition text);
create table playlist_track (
  id uuid primary key,
  playlist uuid not null,
  track uuid not null,
  position double not null default 0
);
-- Each source reuses its query's id (see "Identity" in the spec).
-- `query.position` was nullable (migration 0005).
insert into source (id, name, created_at, modified_at, last_play, source_folder, position, query)
select id, name, created_at, modified_at, last_play, parent, coalesce(position, 0), id from query;

-- Phase 2: reshape.
alter table query drop column name;
alter table query drop column created_at;
alter table query drop column modified_at;
alter table query drop column last_play;
alter table query drop column parent;
alter table query drop column position;
alter table query_folder rename to source_folder;
```

The scanner never hard-deletes tracks (deletions are recorded in the `deletion` table), so `playlist_track.track` can't be left dangling by a scan.

### Lineage of duplicate column names (a blocker the spec didn't anticipate)

The spec's playlist query compiles and runs correctly (`probe.ts`), but the lineage analysis gets it wrong. The SQL selects `"playlist_track"."id"` (the hidden `$id`) and, inside `$track.(…)`, `"track"."id"`. Both output columns are named `id`. The `track-lineage` binding calls `polyglot_sql::lineage::lineage(name, …)` once per output column *by name*, so both resolve to the first one and the track's id is reported as `playlist_track.id`. As a result `trackIdColumn` finds no `track.id` column: rows wouldn't be playable, the record editor couldn't open the track, and the rows couldn't be added to playlists.

The probe confirms that giving the projections unique aliases fixes the analysis (`"track"."id" AS "c2"` traces to `track.id`). The fix belongs in `track-lineage/src/lib.rs` (phase 2): analyze each output column by its *position*, for example by re-aliasing the outermost projection list positionally before calling `lineage`, keeping the JSON contract unchanged. The same bug already affects a query today: a track query that displays both `$id` and `$album.id` loses its track id column. The fix covers that case too.

### Writing through `dml`

Constraints of `backend/src/dml.rs` that every playlist write has to respect:

- **A `where` must name a non-null unique key.** Every `playlist_track` update or delete is therefore addressed by `{ id }`, one operation per row. There is no "delete where playlist = X".
- **Deletes check for dangling references, against the live transaction.** Deleting a playlist must delete its `playlist_track` rows, then its `source` row, then its `playlist` row, in that order. Deleting a `track` through the record editor now fails while a playlist holds it. That's correct behavior, and the error is reported like any other.
- **Values bind as JSON scalars.** Strings rely on DuckDB's implicit casts, so `timestamp_s` columns take a `'YYYY-MM-DD HH:MM:SS'` string. Numbers bind as `BIGINT` or `DOUBLE`, which suits both `position` columns. Verify the timestamp cast in the phase 1 backend tests by sending a `dml` insert into `source`.
- **Operation ids must be unique within a request.** Use a counter (`e0`, `e1`, …), not row ids, which can repeat in a request that both deletes and re-inserts.
- **Reads go through raw SQL.** Delete, duplicate, "add tracks" (maximum position) and "Keep only these tracks" all need entries the page hasn't loaded. Read them with `runSql` / `runSqlScalar` (`api/query.ts`). No Querydown is needed for these.

### The results after a write

`runQuery` treats a re-run that compiles to the same SQL as a *refresh* (`lastRunSql`, `setTabResult(…, refresh)`), keeping the selection, the record editor and the scroll position on the assumption that the rows haven't moved. After a write to `playlist_track` the SQL is the same but the rows have changed, so stale row indexes would point at the wrong tracks. Reload after a write as *new rows* (clear the selection), except where the phase says otherwise. A rearrangement keeps the moved rows selected at their new indexes.

### Keyboard shortcuts can't share a chord yet

Chords are globally unique. `commandForChord` returns the first command bound to a chord, and the shortcuts editor's assignment "steals" a chord from any other command. `Delete` already belongs to `selection.delete` (`when: "recordForm"`), and "Playlist: Remove selected tracks" needs `Delete` while a playlist's results have focus. Phase 6 makes dispatch pick the first command bound to the chord *whose `when` holds*, and makes the editor steal a chord only from a command whose context can overlap. The record form takes precedence: when it has focus, `Delete` belongs to it.

### Names already in use

- **"playlist" already means the play queue** in the store (`selectPlaylistAround` and its callers). Phase 2 renames those to "queue" so that "playlist" means only the new feature.
- **Tab ids are source ids.** A query tab's id is its query's id today. After the migration the source reuses that id, so tabs persisted in `localStorage` keep working. The stored tab shape (`StoredTab` in `stores/app/persistence.ts`) gains a playlist variant **without** bumping `OPEN_TABS_VERSION`, since a bump would discard every open tab.
- **`selectQueryTab` and `t.kind === "query"`** gate a lot of behavior that playlist tabs need too (runs, builders, results, undo, record editor). Phase 4 checks each call site and decides whether it means "a query tab" or "a tab with a results page". Narrowing is safer than widening by default.

### Querydown details

- `track{…}` scopes conditions to the related track. The prelude's track-scoped definitions (`artist:@x`, the default text search) work inside it (verified with the probe). An empty `track{}` is a parse error ("Invalid querydown code"), as the spec says. Empty `\\track.()` and `$track.()` are fine.
- The playlist query is one whole query, so it goes through `compile`, not `compile_sections`. A syntax error in the user's filter text reports as a generic "Invalid querydown code" rather than one tied to the filter. The query page shows no compile errors yet (console only), so nothing regresses.
- Shuffle's built-in fragment (`\\id|concat('<seed>')|md5`) works unchanged inside `\\track.(…)`.

## Phases

| Phase | Spec sections it implements |
| ----- | --------------------------- |
| 1 | Data model changes |
| 2 | The playlist query (generation); Writing playlist entries (operation builders); the `position` rules from Adding tracks, Converting a query, Sorting (commit) and Manually rearranging |
| 3 | Undo/redo within playlists (the shared abstraction) |
| 4 | Terminology and iconography; The playlist tab; The playlist query; Filtering and Sorting (without their buttons); Customizing the display; Playing tracks; The record editor within the playlist page |
| 5 | No ephemeral playlists; Listing playlists and queries in the explorer; Creating a new playlist from scratch; Other CRUD on playlists; Converting a query into a playlist |
| 6 | Manually removing tracks; the filter builder's buttons; "Commit this track order to playlist" |
| 7 | Adding tracks to a playlist (the "Add to playlist…" modal) |
| 8 | Changes to touch and pointer interactions for result rows; Adding tracks to a playlist (the drag onto the sources tree) |
| 9 | Manually rearranging tracks in a playlist |

Each phase leaves the app working and shippable: no phase depends on a later one to undo a regression.

### Phase 1 — Schema, migration and source RPCs

**Goal:** the database holds sources, and the backend and frontend run on the new schema with no visible change.

- **Migration `0006.sql`**, from the validated draft above, registered in `db.rs` (`MIGRATIONS`) and in `rpc.rs`'s test `setup()`.
- **`api-schema`:**
  - `Query` becomes `Source`: `id` (the source's), `kind` (`"query" | "playlist"`), `name`, the three timestamps, `definition` (from whichever row the source wraps), `parent` (from `source.source_folder`), `position`, and `queryId` / `playlistId` (one of them set).
  - `QueryFolder` becomes `SourceFolder`, and `TreeItemKind::Query` becomes `TreeItemKind::Source`.
- **RPCs:**
  - `query.list` becomes `source.list`, and `query.rename`, `query.record_play` and `query.arrange` become `source.rename`, `source.record_play` and `source.arrange`, all keyed by source id.
  - `query.update_definition` becomes `source.update_definition`, which writes the definition of whichever row the source wraps and bumps `source.modified_at`. Both pages' autosave uses it.
  - `query.add` keeps its name and inserts the `query` row and its `source` row in one transaction. New queries get a query id distinct from their source id ("No code assumes that these ids are equal").
  - `query.delete` takes a source id and deletes the source, then its query, in one transaction.
  - `folder.*` targets `source_folder`.
  - Playlists get **no** RPCs. They are created, duplicated and deleted through `dml` (phase 5).
  - Update `METHODS` and run `cargo xtask gen-api`.
- **Backend tests:**
  - The migration carries over name, timestamps, `position` (including a null one), and folder. Ids are reused. The old columns are gone.
  - The `CHECK` and `unique` constraints hold.
  - `source.list` returns both kinds.
  - A `dml` insert into `source` with string timestamps succeeds.
  - Deleting a playlist in the wrong order fails, and in the right order succeeds.
- **Frontend**, adapted with no visible change:
  - The store's `queries`, `loadQueries` and `refetchQueries` become `sources`, `loadSources` and `refetchSources`. The explorer components and UI text are renamed in phase 5, not here.
  - Until phase 4 the explorer shows only `kind === "query"` sources.
  - Update the harness `mockApi.ts`, `dev/fixtures.ts`, and every Playwright `page.route` mock that answers `query.list`.
- **Verification:** the gate, plus the probe against the real `0006.sql` (compile and run checks pass; lineage checks fail until phase 2).
- **Owed by the user:** back up the real database, start the server so the migration runs, and confirm that saved queries, folders, their order and open tabs all survived.

#### As built

- **Migration:** `backend/src/migrations/0006.sql` is the validated draft plus a header comment, registered in `db.rs`'s `MIGRATIONS`. Instead of adding it to `rpc.rs`'s `include_str!` list, both test modules (`rpc.rs` and `dml.rs`) now build their schema with a new `#[cfg(test)] db::migrate_through(conn, version)`. It runs `MIGRATIONS` through `version`, each in its own transaction exactly as `get_db` does. So there's one list of migrations, and the migration test exercises the real transactional path. `dml.rs`'s tests previously stopped at 0003. They now get the full schema, and nothing in them changed meaning.
- **`api-schema`:** `Source` (with `kind: SourceKind`, `queryId`, `playlistId`), `SourceFolder`, and `TreeItemKind::Source`. The params structs are renamed to `SourceRecordPlayParams`, `SourceRenameParams`, `SourceUpdateDefinitionParams` and `SourceArrangeParams`. `QueryDeleteParams` keeps its name and takes a source id. `query.add` takes a `Source` and rejects one that isn't a query or has no `queryId`. The client is regenerated (`api-client/src/`).
- **RPCs** (`backend/src/rpc.rs`): `source.list` (left-joins `query` and `playlist` for the definition, and derives `kind` from which id is set), `source.rename`, `source.record_play`, `source.arrange`, and `source.update_definition` (writes `query` or `playlist` through a subquery on `source`, bumps `source.modified_at`, all in one transaction). `query.add` and `query.delete` each run in one transaction over both tables. `query.delete` is a no-op for a source that doesn't wrap a query. `folder.*` targets `source_folder`.
- **Backend tests:** the migration (ids reused, name, all three timestamps, a null `position` becoming 0, folder kept, `query` left with only `id` and `definition`); the `CHECK` and both `unique`s; `source.list` returning both kinds; `update_definition` on both kinds; `query.add` / `query.delete` spanning both tables; rename and record_play; arrange. In `dml.rs`: an insert into `source` with string timestamps (and a `playlist` op-reference), deleting a playlist in the wrong order failing (both orders tried) and in the right order succeeding, and deleting a track held by a playlist failing. `cargo test -p backend` linked and passed (32 tests).
- **Frontend:** the store's `queries` / `loadQueries` / `refetchQueries` are now `sources` / `loadSources` / `refetchSources`. The tree model (`query/explorerTree.ts`) follows the wire: a source node is `{ kind: "source", source }` (it was `{ kind: "query", query }`), and tree refs and placements use `kind: "source"`. Component names and UI text are untouched (phase 5). `saveQuery` sends a `Source` with a fresh `queryId`, distinct from the tab's (source) id. `QUERIES_FIXTURE` is now `SOURCES_FIXTURE`. Its three queries carry `queryId`s that differ from their source ids, so nothing can quietly rely on the two being equal. Every `page.route` mock answers `source.list`.
- **Hiding playlists until phase 4:** only `QueryTree` filters to `kind === "query"`, when it builds its tree. The store's tree actions (move, delete folder, top position) still see every source, so a hidden playlist keeps a consistent place among its siblings. Phase 4 deletes that filter.
- **Not renamed, deliberately:** `RpcErrorBanner`'s labels are rekeyed to the new method names but still say "queries" ("Loading your queries"). That's UI text, which phase 5 renames.
- **Gate:** cargo check, clippy (`--all-targets`) and fmt are clean for `backend` and `api-schema`. The frontend's typecheck, lint, format:check, test:unit (398), build and test:visual (229) all pass with no snapshot changes. The probe compiles and runs every case against the real `0006.sql`; its lineage checks fail, as expected until phase 2.
- **For the next phase:** a tab's id is a source id. Reach a playlist's `playlist` row through `Source.playlistId`. `dml`'s link inference already covers `source.playlist`, `source.query`, `source.source_folder`, `playlist_track.playlist` and `playlist_track.track` (the dml tests rely on it).

### Phase 2 — Playlist query, entry math and the lineage fix (no UI)

**Goal:** every framework-free piece the later phases build on, unit-tested.

- **Lineage fix** in `track-lineage/src/lib.rs`, as described above, keeping the JSON contract. Check it with `cargo check`, `clippy` and `fmt --target wasm32-unknown-unknown` from `track-lineage/`. Then set the status to `awaiting user` with the action "run `./track-lineage/build.sh`, then `bun specs/2026-10-playlists/probe.ts` must exit 0". Phase 3 doesn't need the rebuild. Phase 4 does.
- **`frontend/src/query/playlist.ts`:**
  - `PlaylistDefinition`: filter, sort and display, with no base and no full mode.
  - Its stored-JSON round trip.
  - The new-playlist definition (default `track` display preset, "Playlist order", no filter).
  - The definition converted from a query's (display copied when the base is `track`).
  - The playlist Querydown generator from the spec's template, with a variant that leaves out the filter (for committing a sort).
  - A `compilePlaylist` beside `compileSavedQuery`.
  - Represent "Playlist order" as a sort `SectionContent` variant (recommended: `{ builtin: { preset: "playlist_order" } }`, resolving to no fragment) so that the existing section plumbing and the options-menu radio carry it. Record the choice in the As-built note.
- **`frontend/src/query/playlistEntries.ts`:**
  - Position math: append (one above the ceiling of the maximum, or 1), between two neighbors (evenly spaced), top and bottom (consecutive integers past the floor or ceiling), and the "too close for distinct doubles" check that falls back to renumbering everything from 1.
  - Builders for each `dml` request: create a playlist with entries; duplicate; delete; add entries; remove entries; set positions.
  - Builders for the inverse of each entry write, for undo. A removal's inverse re-inserts the full records with their original ids and positions.
  - Unit-test the edge cases: duplicate tracks, an empty playlist, neighbors 6 and 7, adjacent doubles, top and bottom drops.
- **`frontend/src/api/playlist.ts`:** raw-SQL reads of a playlist's entries (`id`, `track`, `position`, in order) and of its maximum position.
- **Probe:** switch `probe.ts` to import the real generator.
- **Rename:** "playlist" meaning the play queue becomes "queue" (see "Names already in use").

### Phase 3 — One undo abstraction

**Goal:** the query page's snapshot history becomes a stack of transformations that playlist pages can share, with no behavior change on the query page.

- Replace `UndoHistory` (`entries: QueryDefinition[]`, `index`) with a history of **steps**. Each step can carry:
  - a definition transition (before and after),
  - track writes (the redo operations and the undo operations), or
  - both, as "Remove these tracks" does when it also clears the filter.
- On the query page, every run still checkpoints, and an edit still waiting on its debounced run is undone first. The existing `undo and redo` tests in `stores/app/actions.test.ts` keep passing. Change them only where the state's shape changed, not their expectations.
- **A per-source write queue**, framework-free: it serializes every write to one playlist's entries. Undoing or redoing a step with writes sends that step's operations through the queue as one request, moves the history's index only once the request succeeds, and then applies the definition half and reloads.
  - A failure leaves the index where it was and is reported through the RPC error bar.
  - Expose an "is writing" flag in page state for phase 9's block on rearranging.
  - Disable Undo and Redo while a step is in flight.
- **Tests:** steps with fake writes. Cover success, failure leaving the index unmoved, two queued writes running in order, and redo after undo.
- **No UI change**, so no snapshot changes.

### Phase 4 — Playlist tabs and the playlist page

**Goal:** a playlist opens in its own kind of tab and works as a read-only page: filter, sort, display, play and edit tracks.

**Precondition:** the lineage WASM has been rebuilt. If `probe.ts` doesn't exit 0, set the status to `awaiting user` and stop.

- **Tab kind:**
  - Add `PlaylistTab`: `kind: "playlist"`, `id` (the source id), `playlistId`, `name`, `live`, `saved`, `saveFailed`.
  - Persist it in `StoredTab` (without a version bump).
  - Add a `queue_music` icon to `icons.tsx` (`Icons.Playlist`) and return it from `tabIcon`.
- **Explorer:** show playlist sources in the tree with that icon, and open them in playlist tabs. They already rearrange, because `source.arrange` doesn't care about kind.
- **Page:** reuse `QueryPage`, `QueryToolbar`, the builders and `QueryResults`. Branch on kind only where the spec differs:
  - `runQuery` compiles a playlist tab with `compilePlaylist`.
  - Builder actions go through a kind-aware `editLive`.
  - There's no base selector and no full mode.
  - No preset applies by default.
  - "Playlist order" is the first radio in the sort options menu. An empty custom sort also means playlist order.
- **Autosave** goes through `source.update_definition` on the same `IdleQueue`. The Save button and the ✱ never show. A failed save is still reported through the error bar.
- **Undo** of definition changes uses the phase 3 history.
- **Playback** works as from a query, and `source.record_play` takes the source id.
- **Record editor:** on a playlist page, leave the `playlist_track` entry out of the lineage mapping's `records`. "Edit track" and "Results: Edit selected rows" then begin at the track, and the existing de-duplication edits a repeated track once.
  - Add a helper that reads a row's entry id and position from result columns 0 and 1 (positions before hidden columns are dropped). Phases 6 and 9 use it.
- **Wrench menu:** Rename and View SQL. Duplicate and Delete arrive in phase 5.
- **Stories** (intended snapshot additions): the playlist tab handle, the sort options menu with "Playlist order", and the playlist toolbar.
- **Tests:** compile routing per kind, a persisted playlist tab surviving a round trip, and a playlist page leaving out `playlist_track` records.
- **Owed by the user:** nothing can create a playlist until phase 5, so manual checks wait until then.

### Phase 5 — Creating and managing playlists

**Goal:** the user can create, convert, duplicate, rename and delete playlists, and the explorer is the "Sources" section.

- **Rename** the explorer's Queries section to Sources, in code (`QueryTree` → `SourceTree`, `QueryRow` → `SourceRow`, `queryFilter` → `sourceFilter`, …) and in the UI ("Sources", "Filter sources"). This is an intended snapshot change for the explorer stories and the two `app.spec.ts` frames.
- **"Add playlist":**
  - Add it to the section's dropdown menu and to the folder context menu.
  - Turn the tab bar's new-tab button into a dropdown with "New query" and "New playlist".
  - Each one sends one `dml` request (source + playlist), placed at the top of its folder (follow how `addQuery` computes a top position), and opens the playlist in a new, active tab.
- **Delete:**
  - Keep the same confirmation modal as for queries.
  - Read the playlist's entry ids, then send one `dml` request (entries, then source, then playlist) through the playlist's write queue.
  - Close the playlist's tab.
- **Duplicate:** read the entries, send one `dml` request, place the copy at the top of the original's folder, and open it in a new tab. Offer it from both the explorer and the wrench menu.
- **Rename:** already generic through `source.rename`. Check the explorer, the tab handle and the wrench menu.
- **"Query: Convert to playlist":**
  - Add a command (no chord) and a wrench entry.
  - It's available when the query's current results carry a track id column and the query isn't running or failed. That needs a new `When` predicate, since the set is fixed booleans.
  - It copies the rows in their displayed order, with positions 1…n.
  - The tab opens next to the query's tab.
- **Owed by the user:** a manual pass against the real server, covering create, convert (including one large query to see the request-size failure reported), duplicate, rename, delete, and filter/sort/display/play on the result.

### Phase 6 — Removing tracks and committing conditions

**Goal:** every in-page write except rearranging, each one an undoable step.

- **"Playlist: Remove selected tracks":**
  - Add the command, with `Delete` as its default chord while a playlist's results have focus. This first needs the keymap change described in "Keyboard shortcuts can't share a chord yet", with tests for dispatch and for the editor's stealing.
  - Add a "Remove from playlist" entry (`delete` icon) to the row context menu.
  - It deletes the selected rows' entries in one request.
- **"Remove these tracks" / "Keep only these tracks"** (under the filter builder, when a filter applies):
  - Read the playlist's full entries and split them by the ids the filtered results hold (column 0).
  - Delete one side in one request, then clear the filter.
  - Record one step holding the writes and the definition change.
  - Disable per the spec.
- **"Commit this track order to playlist"** (under the sort builder, when a sort applies):
  - Run the playlist query with the sort and without the filter, and read the entry ids and old positions in that order.
  - Write positions 1…n in one request, then reset the sort to "Playlist order".
  - Record one step holding the writes and the definition change.
- **Reload** after each write as new rows (see "The results after a write").
- **Stories** (intended additions): the filter builder with its two buttons, and the sort builder with its commit button.

### Phase 7 — "Add to playlist…"

**Goal:** add selected tracks to any playlist from a menu.

- An "Add to playlist…" entry in the row context menu, and so in the multi-select toolbar's menu, which uses the same body. It shows when the rows are tracks (`lineage.trackIdColumn`).
- **The modal:**
  - A sources tree of playlists only. Folders with no playlist below them are left out.
  - Expansion is seeded from the explorer's `expandedFolders` and kept local to the modal.
  - A single click adds the tracks and closes the modal. Escape or a click outside closes it.
  - Give it its own body component, since it seeds state on mount.
- **`addTracksToPlaylist(sourceId, trackIds)`:**
  - Runs in the target playlist's write queue.
  - Reads the maximum position, then inserts the tracks in one request, keeping their relative order.
  - Reloads the target's tab if it's open. The target's undo history gets no entry.
- **Stories** (intended additions): the modal, with a nested folder and an omitted empty folder.

### Phase 8 — Dragging result rows

**Goal:** result rows respond to touch and pointer input as the explorer does, and can be dropped onto a playlist in the sources tree.

- **`grid/canvasGrid.ts`:**
  - A touch-drag still pans.
  - A touch-hold (reuse `useTreeDrag`'s `LONG_PRESS_MS` / `LONG_PRESS_SLOP` / `HOLD_SLOP`, moved into a shared module) picks the rows up. A hold released without moving raises the context menu, which replaces the platform's long-press `contextmenu` on touch.
  - A mouse or pen drag past `DRAG_THRESHOLD` starts the same drag.
  - Holding an unselected row selects it alone first.
- **The drag session:**
  - Its state, `{ source tab, track ids, entry ids }`, lives somewhere both the grid and the explorer can reach, such as a store slot that holds plain data.
  - A floating chip follows the pointer ("3 tracks").
  - The explorer highlights the playlist row under the pointer (`document.elementFromPoint` → `[data-tree-row]`, with the source's kind and id as data attributes). Only playlists accept the drop, and not the playlist the rows came from.
  - Dropping calls `addTracksToPlaylist`.
- **Edge cases:** on a narrow layout where the explorer is a closed drawer, there's nothing to drop on. Record how that behaves.
- **Tests:**
  - A behavioral spec drives the mouse drag with `page.mouse` against the assembled app (`?expose=1`).
  - Unit tests cover the gesture state machine (hold, drag, release without moving) with synthetic pointer events if it can be factored out of the canvas class. Touch can't be screenshot-tested easily, so the user's device check covers it.
- **Owed by the user:** a touch-device pass covering scroll, hold to drag, hold and release for the menu, and a drop onto a playlist.

### Phase 9 — Rearranging tracks within a playlist

**Goal:** drag rows to a new place in a playlist.

- **Drop indicator:** a drop line between rows, drawn on the canvas, with edge auto-scrolling while dragging. Match the tree's feel.
- **Optimistic reorder:** `QueryResult` gains a reordered view (a new instance over a row-index map, with its row patches remapped). The page swaps it in, and the moved rows stay selected.
- **Positions:**
  - Use the phase 2 math. The neighbors are the adjacent *visible* rows.
  - If the neighbors are too close, renumber everything.
  - If a sort applies, compute the final full order (sorted, then the move) and renumber everything in **one** request, which is a single undo step, rather than committing and then moving.
- **Concurrency:** block a rearrangement while the page's write queue is busy. Other writes queue.
- **Afterwards:** reload. A failure reloads the stored order and is reported.
- **Owed by the user:** the final manual pass over the whole feature against the real server, on desktop and on a touch device.

## Deferred follow-ups

(Add entries as phases defer work.)

## Open questions

- **"Add to playlist…" from a playlist page.** Should the modal list the playlist the rows came from? Dragging onto it isn't allowed, and the spec says there's no flow for adding tracks to a playlist from its own page. Phase 7 should leave it out unless the user says otherwise.
