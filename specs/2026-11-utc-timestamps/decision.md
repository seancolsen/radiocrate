# Timestamps are stored in UTC

**Status:** decided and built · **Date:** 2026-11-24

Every timestamp in RadioCrate's database is **UTC civil time**: a value of
DuckDB's plain `TIMESTAMP` (or `TIMESTAMP_S`) type, which carries no zone and,
by this convention, means UTC. The browser converts to and from the viewer's
local time, and nothing else does. This note records why, what it rules out,
and what it costs.

---

## 1. The rule

| Layer | What it does with time |
| --- | --- |
| **Database** | Stores UTC civil time in `TIMESTAMP` columns. `now()`, `CAST(NOW() AS TIMESTAMP)`, `DEFAULT now()`, the scanner's `file.added` and every migration's stamps are UTC. |
| **Backend** | Opens the database so it can't ever answer in another zone (§3). Never converts a timestamp. The API stays "SQL in, Arrow out". |
| **Frontend** | Writes "now" as UTC civil text (`YYYY-MM-DD HH:MM:SS` from the `getUTC*` getters). Shows stored values in the viewer's local time: relative ("30 minutes ago") and absolute. A record editor's timestamp field shows and accepts local time and writes UTC. Keys, lineage filters and raw export keep the stored UTC text untouched. |
| **Sample data / E2E** | The generator writes UTC whatever the machine's zone. The E2E suite runs browsers and servers in several zones (`timezone.spec.ts`, `playback.spec.ts`). |

Use `TIMESTAMP`, not `TIMESTAMPTZ`, for a new column (§4). A `DATE` is a
calendar date, not an instant: it isn't converted.

Where it lives in the frontend:

- **`src/query/timestamps.ts`** holds every conversion. `nowUtcText()` and
  `utcCivilText(ms)` produce the stored spelling. `utcToLocalText` and
  `localToUtcText` convert between UTC text and local text. `isInstantType`
  says which column types are instants (every `TIMESTAMP*`, not `DATE` or
  `TIME`). `LOCAL_TIME_CODEC` is the record editor's show/input/commit codec.
- **Writes:** `nowTimestamp()` (`api/track.ts`, the play log) and a timestamp
  field's pre-fill (`stores/recordForm/model.ts`) use `nowUtcText()`.
  `sourceTimestamp` (`query/playlistEntries.ts`) was already UTC.
- **Display:** `query/format.ts` reads zone-less text as UTC for the
  `timestamp` and relative-time formatters. A timestamp column with no
  formatter shows local time through the fallback `LOCAL_TIMESTAMP`
  (`QueryResult.text` / `pills` / `displayMeta`). Embedded previews, record
  pickers and computed fields go the same way.
- **Unchanged, UTC on purpose:** `stringifyArrowValue` (`api/query.ts`),
  `QueryResult.keyText`, `rawPills`, raw export, lineage filters and every DML
  value built from a stored cell.
- **Record editor:** form state holds the stored UTC text from load to save.
  The input box goes through the codec, so it shows local time and a typed
  local time commits as UTC. A value left alone is written back byte for
  byte, or not at all.
- **Tests:** `src/dev/inZone.ts` runs a Vitest file under another
  `process.env.TZ`. `timestamps.test.ts`, `format.test.ts`, `result.test.ts`,
  `api/track.test.ts` and the record-form model tests use it with New York
  and Kolkata.

## 2. The bug that led here

Filtering plays with `#play timestamp:<1h` didn't return the last hour's plays
for a user in UTC-5; `timestamp:<6h` did. Tracks the scanner added showed as
added "in 5 hours". Querydown wasn't at fault: it compiles a relative filter to

```sql
ABS(EXTRACT(epoch FROM CAST(NOW() AS TIMESTAMP) - "play"."timestamp")) < EXTRACT(epoch FROM to_hours(1))
```

which is right for a zone-less column. The two sides of that subtraction
disagreed about the zone:

- The browser stored its **own local** civil time (`nowTimestamp()` used the
  local getters). A play at 14:00 in New York was stored as `14:00`.
- DuckDB's `CAST(NOW() AS TIMESTAMP)` answered in **UTC**: `19:00`. So did
  `DEFAULT now()` and the scanner's `added`.

DuckDB converts between `TIMESTAMPTZ` and `TIMESTAMP` in the session's time
zone only through its **ICU extension**. The `duckdb` CLI has ICU built in,
which is why `now()::timestamp` there reads local time. The crate's bundled
build doesn't, so in the server the cast is fixed to UTC.

Worse, the server's behavior wasn't even stable. ICU isn't compiled in, but
DuckDB loads it lazily from the shared extension cache (`~/.duckdb/extensions`)
the first time a query touches a time zone, **even with
`autoload_known_extensions` off**. From then on the same cast answered in the
server process's zone (`TZ`). One server was seen switching from UTC to New
York partway through a session, after a query called
`current_setting('TimeZone')`. A Raspberry Pi can never load ICU at all, since
DuckDB publishes no extensions for 32-bit ARM.

## 3. How the backend keeps the database in UTC

`db::config` (`backend/src/db.rs`) opens every library's connection with:

- **its own extension directory**, `<db-dir>/extensions`, which ICU is never
  installed into. A query that would need ICU (`date_trunc` on a
  `TIMESTAMPTZ`, `SET TimeZone`) now fails with an "Extension Autoloading
  Error" instead of loading it and switching zones;
- **autoloading and autoinstalling off**, so no extension is fetched from the
  network behind a query's back, and a query behaves the same on every
  machine, the Pi included.

An extension loaded on purpose still loads: `--duckdb-server` runs
`INSTALL quack; LOAD quack;`, which downloads it into that directory once.

Turning autoloading off alone was tried first and isn't enough: ICU still
loaded from the shared cache. `SET TimeZone = 'UTC'` can't be the fix either:
without ICU the setting doesn't exist (it's an ICU setting), and the lazy
load later starts ICU in the process's own zone.

`db::tests` pins this down: `the_database_clock_reads_utc`,
`a_query_needing_icu_does_not_load_it` (which loads ICU without the private
directory, on any machine where some DuckDB once installed it), and
`timestamp_functions_work_without_icu` for the functions the app relies on.
Run them under a non-UTC zone too: `TZ=America/New_York cargo test -p backend db::`.

## 4. Why `TIMESTAMP`, not `TIMESTAMPTZ`

`TIMESTAMPTZ` states the intent better, and it's what one would choose with
ICU available. Without ICU it barely works. Checked on the bundled build:

| On `TIMESTAMPTZ`, without ICU | |
| --- | --- |
| `<`, `=`, `epoch`, storing and reading | works |
| `tz - tz` | Binder Error: no such function |
| `tz + INTERVAL 1 hour` (or day, or month) | Binder Error |
| `date_trunc`, `strftime`, `extract(hour …)` | needs ICU: loaded it before §3, fails after |

A `TIMESTAMP` holding UTC has all of DuckDB's core arithmetic and functions,
with no extension. If ICU is ever built in, converting the columns is lossless,
because the values are already UTC.

## 5. Why convert in the frontend

- **The API can't tell which columns are timestamps for display.** `/api/query`
  runs whatever SQL Querydown compiles and streams Arrow back. Converting there
  would mean rewriting results. It would also break the values the frontend
  sends back: lineage builds its equality filters from a cell's raw text
  (`QueryResult.keyText`), which must round-trip through DuckDB unchanged.
- **The zone belongs to the viewer.** Each device has its own, and the browser
  has the full time-zone database, historical DST included (`Intl`, `Date`).
  The server would need one of its own, and a Pi or a Docker image may not
  have it.
- **Formatting already happens in the frontend:** relative times, the
  formatters, and the Arrow decoding in `api/query.ts`.

## 6. What we gave up

**Calendar logic inside SQL is in UTC.** "Plays per day", `date_trunc('day',
timestamp)`, or a date typed into a filter (`timestamp:>2026-01-01`, which
means UTC midnight) work in UTC days. For a user in UTC-5 a play at 21:00 local
counts toward the next day. Rolling windows (`<1h`, `<7d`, "Not played
recently") are unaffected, and so is everything the frontend displays.

If local calendar logic is ever wanted in SQL, the way to do it without ICU is
for the browser to send its current UTC offset with each query, and for the
server to define a per-request temp macro the SQL can use (the same mechanism
`--fixed-now` uses in `backend/src/clock.rs`). That's how the alternative
below would have worked, and it can be added for just calendar functions.

**Old data wasn't migrated.** Values the browser wrote before this change
(play history, mostly) are local civil time and now read as UTC: off by the
user's offset. The user chose to accept that rather than run a migration whose
correct answer depends on which zone each play was recorded in.

## 7. The alternative we didn't take

**Keep storing local civil time, and shadow `now()` per request.** The browser
would send its UTC offset in a header. Under the connection lock, before each
query, the server would run
`CREATE OR REPLACE TEMP MACRO now() AS (TIMESTAMP '<local civil now>')` (and the
same for `current_timestamp`, `today()`, …), computed in Rust from its clock
plus the offset. `CAST(NOW() AS TIMESTAMP)` would then be the browser's local
time, `DEFAULT now()` would stamp it, and calendar logic in SQL would be local.

It wasn't chosen because:

- every server-side stamp (the scanner, defaults, migrations, a DuckDB client
  connected with `--duckdb-server`) needs the offset plumbed to it, or it stays
  in UTC and displays wrong;
- a stored value would mean "the writer's local time": ambiguous across DST,
  and different from device to device when they're in different zones;
- it adds a header and a statement to every request.

UTC storage fixes both reported bugs at the root and removes the dependence on
zones instead of passing it around.

## 8. Rules for future work

- A new timestamp column is `TIMESTAMP` (or `TIMESTAMP_S`) holding UTC. Its
  `DEFAULT now()` is already UTC.
- The browser never writes local civil time into the database. "Now" goes in
  as UTC text; a value the user typed in local time is converted to UTC before
  it's written.
- Display converts; data doesn't. Anything that sends a stored value back to
  the server (keys, lineage filters, DML `where` clauses, raw export) uses the
  stored UTC text.
- Don't load ICU, and don't use `TIMESTAMPTZ` arithmetic or time-zone functions
  in SQL: they fail (§3). If a feature needs local calendar logic in SQL, see
  §6.
- Convert through `src/query/timestamps.ts`; don't hand-roll `getHours()` or
  `getUTCHours()` formatting for a stored value.
- Test a time feature with the browser and the server in different zones:
  `inZone(...)` in Vitest, `test.use({ timezoneId, serverTimeZone })` in the
  E2E suite (`timezone.spec.ts`), and `TZ=... cargo test -p backend db::`.
