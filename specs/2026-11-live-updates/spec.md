# Live updates across devices

**Status:** implemented (phases 1–4; phase 5 not started) · **Date:** 2026-11-21

RadioCrate has one user and several devices. When that user changes their
setup on one device (renames a playlist, rebinds a shortcut, edits the
prelude), every other device that has the app in the foreground should show the
change without anyone pressing Refresh.

Today every piece of server data is loaded once, when the app boots or a
component mounts, and reloaded only by a Refresh button. This spec adds a
**change stream** from the server, and a rule for each kind of data: either it
follows the stream (**live**), or it keeps waiting for Refresh (**manual**).

---

## 1. The short version

- The server keeps a small set of **change topics**, one for each kind of live
  data ("sources", "keybindings", "settings", …). Every write that changes one
  of them bumps that topic's version number and announces it.
- Each device in the foreground holds open one **event stream**
  (`GET /api/events`, Server-Sent Events). The stream says only *which topic
  changed*, never what it changed to.
- When a topic changes, the device **refetches that topic's list** using the
  load action it already has (`loadPresets`, `loadKeymap`, …), and merges it in
  so that **an edit of its own that hasn't been saved yet always wins**.
- Nothing in the manual category ever reloads because of the stream. Where a
  live change makes manual data out of date (a query's definition changed under
  its rows), the page says so and leaves the reload to the user.
- When the app goes into the background the stream closes. When it comes back,
  the server's version numbers tell the device which topics it missed, and it
  refetches only those.

```
 Device A                       Server                          Device B
 ────────                       ──────                          ────────
 rename playlist ──rpc──▶  write + CHECKPOINT
                           bump "sources" to v42
                           broadcast ─────────── changed: sources v42 ──▶ refetch source.list
                                                                         merge, keeping B's
                                                                         own unsaved edits
```

---

## 2. What's live and what's manual

The line is drawn by **where in the UI the data is loaded**, not by which table
it comes from. A query that lists the `playlist` table still shows query
results, so it's manual, even though the explorer's list of playlists is live.

### Live: follows the stream

| Data | Where it shows | Loaded today by |
|---|---|---|
| **Sources**: saved queries and playlists, their names and definitions | Explorer, open query and playlist tabs | `loadSources` (`source.list`) |
| **Explorer folders and arrangement** ✚ | Explorer | `loadSources` (`folder.list`) |
| **Query presets** ✚ | Builder, Data structure page | `loadPresets` |
| **Settings**, which today means the Querydown prelude | Data structure page, every compile | `loadSettings` |
| **Field metadata**: hidden fields, field order, embedded-record Querydown | Record editor, Data structure page | `loadFieldMetadata` |
| **Table settings**: hidden tables, table order, a table's Querydown settings | Base menus, Data structure page, the prelude | `loadTableSettings` |
| **Computed columns** ✚ | Record editor, Data structure page, the prelude | `loadComputedColumns` |
| **Custom comparisons** ✚ | Data structure page, the prelude | `loadCustomComparisons` |
| **Contextual query definitions** ✚ | Record editor fields | `loadContextualQueries` |
| **Schema introspection** | Everywhere | `loadSchema` |
| **Keyboard shortcuts** | Shortcuts tab, menus, tooltips | `loadKeymap` |
| **Rating vocabulary** ✚ | The results row menu's rating items | `loadRatings` |

✚ marks rows that weren't on your list. Most of them are what I'd guess you
meant by "table/field metadata", but each is its own load with its own merge,
so they're listed separately:

- **Folders and arrangement.** They load together with sources, and the
  explorer builds one tree from both, so they share the *sources* topic.
- **Presets.** These are definitions in the same sense sources are, and the
  explorer's Refresh already reloads them alongside sources.
- **Computed columns, custom comparisons and contextual queries.** All three
  go into the prelude or into record editor fields, the same as table and field
  metadata.
- **Rating vocabulary.** This one is the least obvious. It's the whole
  `rating` table, loaded the first time a menu that offers ratings opens, and
  it's treated as a fixed vocabulary, not as a query result. If you add a rating
  on one device, the other device's menu should offer it.

### Manual: waits for Refresh

| Data | Why it stays manual |
|---|---|
| **Query results**, including a playlist page's entries | Your call. Rows moving under the user while they read or select is disruptive. |
| **Record editor contents**: field values, child rows, contextual query rows | Your call. The user may be in the middle of an edit. |
| **Now playing**: track metadata, credited artists | Your call. |
| **Data structure page statistics** ✚ (`tableSummaries`: row counts, value stats) | These are derived from the data, as query results are, and change on every write to any table. The page already has a Refresh button. |

### On demand: neither, and needs nothing

Some data is loaded each time a short-lived piece of UI opens, and thrown away
when it closes. It's fresh every time it's opened, so it needs no live updates
and no Refresh button:

- the record picker's list of options (`RecordPicker`)
- the row actions menu's lookups (credited artists, album ids, the track's
  rating)

### Not server data at all

Some preferences live in each device's `localStorage`, not on the server, so
they don't sync and this spec doesn't change that: theme, audio quality,
explorer and record-sidebar widths, open tabs, the Find toggles, and logging.
**Theme** is the one you might expect to follow you between devices. If so,
it's a separate change: move it into `settings.settings`, and it rides the
*settings* topic for free.

---

## 3. The server side

### 3.1 Change topics

A topic is a name, like `sources` or `keybindings`, plus a version number. The
topics are an enum in `api-schema`, so `cargo xtask gen-api` gives the frontend
the same list as a TypeScript union.

| Topic | Announced by |
|---|---|
| `sources` | `source.rename`, `source.update_definition`, `source.arrange`, `query.add`, `query.delete`, `folder.*`, DML that touches `source`, `query`, `playlist` or `query_folder` |
| `presets` | `preset.*`, DML on `preset` |
| `settings` | `setting.*` |
| `keybindings` | `keybinding.*` |
| `field-metadata` | `metadata.field.*`, plus `metadata.computed_column.rename` / `.delete` (which rewrite field metadata too) |
| `table-settings` | `metadata.table.*` |
| `computed-columns` | `metadata.computed_column.*` |
| `custom-comparisons` | `metadata.custom_comparison.*` |
| `contextual-queries` | DML on `contextual_query` |
| `ratings` | DML on `rating` |
| `schema` | Nothing in the app changes the schema while it runs. Only outside writers (§3.4) and a restart (§3.3) do. |

Two writes deliberately announce nothing:

- **`source.record_play`** bumps a source's `last_play` on every track that
  plays. Nothing outside query results shows `last_play`, so announcing it
  would make every device refetch the source list once per song for no visible
  change.
- **`collection.rescan`** changes tracks, albums, artists and files. All of
  that shows up only in query results and the record editor, which are manual.

### 3.2 Announcing at the one place writes happen

Every mutation already goes through `AppState::write` / `write_mut`. That's
what guarantees the `CHECKPOINT` can't be forgotten. The announcement goes in
the same place, and for the same reason: **the topics become a required
argument of `write`**. A write that changes nothing live passes an explicit
empty list (`&[]`), so a new RPC method can't announce nothing by accident.

- The legacy RPC methods name their topics at the call site, next to the
  `state.write(…)` they already have.
- DML is generic, so it works out its topics from the tables its operations
  touch, using a static map from app-owned table to topic. A table that isn't
  in the map (`track`, `playlist_track`, user-created tables) has no topic,
  because it's data that only query results show.
- The version is bumped once the write has committed and checkpointed, so a
  device that refetches in response always reads the new data.
- A test runs every RPC method through `dispatch` and checks which topics it
  announced, so this table and the code can't drift apart silently.

### 3.3 The event stream

`GET /api/events` is a Server-Sent Events stream. It sends three kinds of
message:

| Event | Payload | When |
|---|---|---|
| `hello` | `{ epoch, versions: { topic → n } }` | First thing on every connection |
| `changed` | `{ topic, version, origin }` | After each write that announced a topic |
| *(comment)* | | Every ~25 s, so Cloudflare and other proxies don't close an idle connection (Cloudflare's idle limit is 100 s) |

- **`epoch`** is a random id chosen when the server starts. Versions are kept
  in memory and start over at 0 on every start, so a new epoch tells a device
  "forget what you knew, refetch everything." This also covers whatever
  migrations ran at startup.
- **`origin`** is the id of the client that made the write (§4.2, rule 3), or `null`
  for the server's own writes and for outside writers.
- In-process this is a `tokio::sync::broadcast` channel. A slow subscriber
  that falls behind and loses messages gets its stream closed, and reconnects
  into a fresh `hello`. Losing messages never means a missed change.

**Why topics and not data?** The stream carries no data. The device refetches
through the same RPC it boots with, so there's one code path for loading each
list, one place where merging happens, and nothing new to serialize. The lists
are small (tens of rows), so a whole-list refetch costs nothing worth
optimizing.

### 3.4 Outside writers

The only thing besides the app that can write to the database while it runs is
a DuckDB client attached through `--duckdb-server` (Quack). Its writes bypass
`AppState::write`, so they announce nothing.

When the DuckDB server is enabled, and at least one device is listening, the
server takes a cheap fingerprint every few seconds: a hash of the catalog
(tables, columns, constraints) and of each live topic's tables, which are all
small. A changed fingerprint bumps the topic, with `origin: null`. This is the
only way the `schema` topic ever changes while the app is running. Without
`--duckdb-server` there's nothing to watch, and the check doesn't run.

---

## 4. The client side

### 4.1 Connection lifecycle

A new framework-free module (`api/events.ts`) owns the stream: connecting,
parsing, reconnecting with backoff. The stores reach it through `AppEnv`, so
store tests drive it with a fake. `createStores()` wires it up, because one
topic (keybindings) belongs to the commands store and the rest to the app
store.

- **Foreground only.** Connect while `document.visibilityState` is
  `"visible"`. Disconnect a few seconds after the page goes hidden. Reconnect
  when it's shown again, and on `online`. A backgrounded phone playing music
  holds no connection, and loses nothing by it.
- **Catching up.** The device remembers the `epoch` and the last version it
  saw of each topic, own writes included. On each `hello`:
  - A different epoch means refetch every live topic.
  - The same epoch means refetch only the topics whose version moved.
- **Boot.** The stream opens first, and the boot loads wait for its first
  `hello` before they go out. That ordering guarantees no change can land in
  the gap between a list being read and the stream starting. The wait is
  capped (about one second): if the stream is slow or blocked, the loads go
  anyway and the app works as it does today, without live updates.
- **`fetch`, not `EventSource`.** The stream is read with `fetch` and a
  `ReadableStream`, not `EventSource`. That way a Cloudflare Access redirect or
  a 401 is visible as a status code, and goes through the same expired-session
  handling RPC failures already get. `EventSource` hides the status and just
  retries forever.
- **Service worker.** `/api/events` is excluded from the service worker's
  `runtimeCaching` route, so a long-lived streaming response never passes
  through it.

### 4.2 Applying a change

Every live topic is applied the same way: **refetch the list, then merge it
in.** The merge follows four rules.

1. **An unsaved edit of this device's wins.** If this device holds an edit to
   an item that the server hasn't acknowledged (one waiting in the idle queue,
   in flight in a write queue, or failed and waiting to be retried), that item
   keeps its local version. Everything else takes the server's.
   `loadPresets` already merges this way for presets. This spec makes it the
   rule for every live list. When the held-back edit lands, it overwrites the
   other device's change. With one user, last writer wins is the right
   conflict rule.
2. **No change, no new reference.** If the refetched list is equal to what's
   in state, state keeps its old reference. Subscriptions in `createStores()`
   fire on reference changes (each contextual query change re-syncs every open
   form), so an unchanged refetch must cost nothing downstream.
3. **This device's own echoes are skipped.** Each page load picks a client id
   and sends it on every RPC (an `x-radiocrate-client` header). A `changed`
   event with this device's own id updates the remembered version and triggers
   nothing. Two browser tabs on one device have two ids, and so do see each
   other's changes.
4. **Bursts coalesce.** Each topic has at most one refetch in flight and one
   queued. Typing in the prelude on device A sends many writes. Device B makes
   one or two refetches, not one per keystroke. The existing load tokens stay,
   and actions read `get()` after every `await`.

A failed refetch reports itself through the error bar like any other failed
RPC. The next event or reconnect tries again.

### 4.3 Where a change shows

Most topics just land in state, and the UI follows as it already does for a
local edit. These need more care:

**Open query and playlist tabs (sources).** An open tab holds its own copy of
its source, so a sources refetch has to reach it:

| Change on the other device | This device |
|---|---|
| Renamed | The tab's name follows, unless the user is renaming it here. |
| Definition edited | If the tab has no unsaved edits (rule 1), its `saved` and `live` take the new definition, as one undoable step, so Undo gets back what this device had. The rows aren't re-run (see "Out of date" below). |
| Moved between folders | Only the explorer changes. |
| Query deleted | The tab stays open as an unsaved query, keeping its definition, with a toast saying it was deleted on another device. Nothing the user was looking at disappears. |
| Playlist deleted | The tab closes, with the same toast. A playlist exists only as records, so there's nothing to keep the tab open on. |

**The prelude editor.** `preludeDraft` is this device's unsaved edit, so it
stays (rule 1). The prelude in force underneath it updates. If the draft now
matches the new prelude, the draft is dropped, since there's nothing left
unsaved.

**The shortcuts tab.** The keymap reloads under it. If the capture dialog is
open on a command whose binding changed on the other device, the capture goes
on, and saving it overwrites the other device's binding.

**Ratings.** These are refetched only if this device has already loaded them.
Otherwise the next menu that offers ratings loads them fresh, as it does today.

**The record editor's shape.** Field order, hidden fields, field labels,
computed and contextual fields appearing and disappearing: this is all live
data, and the form follows it through the subscriptions `createStores()`
already has. What's in the fields (the values and rows) is manual (next
section).

### 4.4 Live changes never reload manual data

A local edit to the prelude, a computed column or a table's Querydown setting
re-runs every open page today (`rerunOpenPages`), and a local edit to a
contextual query re-runs it in every form that shows it. **A change from
another device does neither.** It updates the definitions, and the data stays
as it is until the user refreshes. The remote merge marks its writes as
remote, and the re-run paths check that mark.

**Out of date.** Leaving old rows on screen under a new definition is
confusing, so a page shows when this has happened. The test is simple and
needs no bookkeeping about what changed: a page is out of date when the SQL it
would compile now differs from the SQL its rows came from (`lastRunSql`). Any
remote change to a definition, the prelude, a computed column, a custom
comparison or the schema makes the page recompile. When the result differs,
the page's Refresh button shows a small dot, with a tooltip saying "Changed on
another device." Refreshing clears it. A record editor field whose query
changed is marked the same way, on the editor's Refresh.

---

## 5. Testing

- **Server:** the table-driven test that every RPC method announces exactly
  its topics (§3.2). Tests that the DML table → topic map covers every
  app-owned table in the migrations. One stream test: connect, check the
  `hello`, write, check the `changed`.
- **Stores (vitest, with a fake stream in `AppEnv`):** catch-up on reconnect,
  for both the same epoch and a new one. Own echoes skipped. Bursts coalesced.
  For each live list, a pending local edit surviving a remote refetch. The
  open-tab table above. Remote changes never re-running a page.
- **End to end:** nothing in the repo drives the app against a real backend
  yet. Two browser contexts against one server would be the natural test for
  this feature ("rename in A, see it in B"), but setting that harness up is
  its own piece of work. It's listed as a phase below, not assumed.

---

## 6. Phases

1. **Server stream.** Topics, versions and epoch. `write` takes its topics.
   Every RPC and DML path announces. `GET /api/events`. The client id header.
   *As built, this needed no `Cargo.toml` change: each connection forwards
   its `broadcast` receiver into an `mpsc` channel, read through
   `tokio-stream`'s `ReceiverStream`, which needs no extra feature.*
2. **Client stream and the simple topics.** `api/events.ts`, the connection
   lifecycle, catch-up, and boot waiting for `hello`. The merge rules applied
   to keybindings, settings, presets, field metadata, table settings, computed
   columns, custom comparisons, contextual queries, schema and ratings.
3. **Sources into open tabs.** The open-tab table, the remote mark that keeps
   re-runs from happening, and the out-of-date dot on page and record editor
   Refresh buttons. Its visual snapshot goes in the `query` spec.
4. **Outside writers.** The fingerprint check under `--duckdb-server`.
5. **Optional: a two-device end-to-end test** against a real server.

The explorer's and the Data structure page's Refresh buttons stay through all
of this. They're the fallback if the stream is down. The Data structure page
also still needs its button for the statistics.

---

## 7. Decisions

These were open questions in the first draft. Each one is settled as
recommended, and the sections above already describe the result.

1. **Pages don't re-run on a remote prelude or definition change.** They show
   the out-of-date dot instead (§4.4). This follows the split strictly: query
   results load only when the user asks. Making a remote change behave exactly
   like a local one, re-runs included, would have been simpler to build, but
   then rows would move on a device nobody is touching.
2. **A deleted source's open tab:** a query tab stays open as an unsaved query,
   a playlist tab closes, and both show a toast (§4.3). Closing both was the
   alternative.
3. **The record editor doesn't re-run a field whose query changed remotely.**
   The field is marked out of date, the same as a page.
4. **The theme stays per device.** Syncing it is out of scope here. If it's
   wanted later, it's a one-line move into `settings.settings`, and from there
   it rides the *settings* topic.
5. **The explorer's Refresh button stays.** It costs nothing, and it's the
   escape hatch if the stream isn't connecting. The Data structure page keeps
   its button too, for the statistics.
