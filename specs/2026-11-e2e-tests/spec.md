# End-to-end tests

**Status:** phases 1 and 2 built (2026-11-24); phase 3 not started · **Date:** 2026-11-23

RadioCrate has unit tests (Vitest, `cargo test -p backend`), component
snapshots (the harness), and behavioral Playwright specs that drive the
assembled frontend over a stubbed backend. Nothing tests the real frontend
against the real server and a real DuckDB file. This spec says how to add that
layer: what data it runs on, how each test gets a clean copy of it, how time is
kept from making tests flaky, and what a test should assert.

Numbers marked *measured* were taken in the dev container while writing this.
§10 lists what was checked and what is still an assumption.

---

## 1. The short version

- **Fixture:** the realistic sample library is the right base for nearly every
  test. Build it once as a **template database**, with its clock pinned to a
  fixed instant, and cache it under `target/e2e/` until its inputs change.
- **Reset:** every test gets its **own server process on its own copy** of the
  template. Copying the 12.9 MB file takes 10–35 ms and the server answers its
  first query about 250 ms after it's spawned (*measured*), so a clean world
  costs roughly 0.3 s a test. No reset endpoint in the backend is needed.
- **Time:** one fixed instant in three places. The fixture is generated as if
  it were `2026-01-15 12:00:00`, the browser's `Date` is frozen there, and the
  server's `now()` is pinned there. "2 minutes ago" then reads the same on
  every run, and so does every absolute date.
- **Assertions:** behavior first, in words. Text snapshots (accessibility tree
  for DOM, a text dump for the canvas grid) cover "this whole region shows the
  right data". Pixel snapshots are a small budget: about one per spec file,
  light theme only.
- **Visibility for agents** comes from *unasserted* screenshots: a `look()`
  helper that saves a PNG at each step only when asked, plus a screenshot and
  trace on every failure. Looking costs an ordinary run nothing; only
  asserting costs.
- **What runs:** the production frontend build, served by a debug build of the
  `radiocrate` binary. Agents build that binary with a new
  `cargo xtask e2e-build`, allowed whenever `cargo check` is.
- **Backend changes:** one hidden `--fixed-now` option. **Frontend changes:**
  measure elapsed time with `performance.now()` in two places, and one more
  accessor on the test facade.

---

## 2. What an E2E test is for

An E2E test earns its cost when **the backend's answer is the thing under
test**. The stack it exercises that nothing else does:

- Querydown → SQL → DuckDB → Arrow → the grid, on real rows
- a write through `/api/rpc` or the DML API, and reading it back after a reload
- migrations and their seeded defaults, as a new library shows them
- the stream endpoint feeding the audio engine
- the change stream between two pages

| The question | Where it's tested |
| --- | --- |
| Does this component look right in this state? | Harness story + snapshot |
| Do these components behave together, given canned data? | `tests/visual` behavioral spec over the seed seam |
| Does a pure function or a store action do the right thing? | Vitest |
| Does the server do the right thing for this request? | `cargo test -p backend` |
| Does the user get the right result from the real system? | **E2E** |

An E2E test that could have been a story or a store test should be one. The
suite stays valuable by staying small: tens of journeys, not hundreds of cases.

---

## 3. The fixture

### 3.1 Is the realistic sample library the right base?

Yes. It goes through the real scanner, so it has exactly the shape real data
has, and it's rich enough to make queries interesting: 6 albums, 63 tracks,
3,530 plays over two years, typographic punctuation in titles, guest credits.
The `play` table is long enough to exercise scrolling and range loading.
Writing small synthetic datasets per test would be more work and would drift
from what the scanner produces.

Three things about how to use it:

1. **One base, small per-test changes.** A test that needs a playlist, a saved
   query or an unrated track creates it at the start, through the API (§6.5).
   Don't grow the base set to serve one test: every change to
   `collection.yaml` moves every snapshot that shows the data.
2. **Know what it lacks.** Every track is rated and every track has been
   played, so "unrated" and "never played" don't exist until a test makes
   them. Every file is a single-disc FLAC with complete tags.
3. **Two more fixtures cover what it can't:**
   - **Empty library:** a database with migrations applied and nothing
     scanned. It costs nothing to build and is the only way to test what a new
     user sees.
   - **Private collection:** for the few tests that rescan, a test gets its
     own copy of the audio files (15 MB) to add to and delete from.

### 3.2 Pinned, so that it's the same every time

Today's generator is deliberately *not* reproducible: plays are placed relative
to the moment it runs, the timestamps are whatever the machine's local time
was, and every id is a fresh UUID. That's right for a development database and
wrong for a test fixture. The E2E template is built by the same scripts with
three things held still:

- **The clock.** `generate_database.py` takes `--now "2026-01-15 12:00:00"`
  and uses it where it calls `datetime.now()` today. The default stays the real
  time, so the development database keeps looking freshly used.
- **The time zone.** Timestamps in the database are zone-less civil times:
  the generator writes its machine's local time, and the browser writes its
  own (`nowTimestamp()` in `api/track.ts`). E2E runs the generator, the server
  and the browser all in UTC.
- **The ids.** See §3.4. This one can wait until it's shown to matter.

A fixed instant, not "whenever the template was built", is what keeps absolute
dates stable. If the anchor moved with each rebuild, every snapshot showing an
`added` date would change whenever a migration was added.

### 3.3 Building and caching the template

The template lives in `target/e2e/`, which is a named volume in the container
and already ignored:

```
target/e2e/
  collection/           a copy of sample-data/realistic/collection (no .radiocrate/)
  template/radiocrate.db
  template.key          hash of the inputs the template was built from
  run/<worker>/<test>/  one test's database, deleted when it passes
```

E2E gets **its own copy of the audio files** because the generator backdates
each file's mtime relative to its clock. Sharing the files with the
development database would have the two anchors overwrite each other's mtimes,
and the development server would then rescan every file.

Playwright's `globalSetup` rebuilds the template when the hash of its inputs
changes: `collection.yaml`, the generator scripts, `backend/src/migrations/`,
`backend/src/scanner/` and `backend/src/db.rs`. Otherwise the tens of seconds
are paid only on the run after one of those changes.

The generator also needs `--collection`, `--db-dir` and `--server-bin`, so it
can scan the E2E copy with the already-built binary instead of `cargo run`.

### 3.4 Reproducible ids (later, if needed)

The scanner mints random UUIDs, so each rebuild of the template has different
ids. Tests must never hard-code one. They find records by what the user sees
(a title, a name).

The remaining exposure is **tie-breaking**. A sort whose keys tie falls back
to physical order or to an explicit `\\id`, and both can differ between
rebuilds. The symptom would be an unrelated snapshot changing row order right
after someone adds a migration.

The fix, if it shows up, is a pass at the end of `generate_database.py` that
rewrites ids deterministically: walk the tables parents-first using
`metadata.relationship`, rank each table's rows by their column values, and
replace each id with a UUIDv5 of table and rank. I'd leave it out of the first
phases and add it the first time a tie bites.

Committing an `EXPORT DATABASE` dump as the fixture would give the same
stability with no ranking pass and no scan at build time. I don't recommend
it: it makes a second source of truth beside `collection.yaml`, and the fixture
build would stop exercising the scanner.

---

## 4. A clean world for every test

### 4.1 The options

| Option | Cost per test | Verdict |
| --- | --- | --- |
| **A. New server process on a fresh copy of the template** | ~0.3 s (*measured*: copy 10–35 ms, server answering ~250 ms after spawn) | **Recommended** |
| B. A test-only reset endpoint that swaps the connection in a running server | maybe 0.05 s | Fallback |
| C. Roll back a transaction around each test | n/a | Impossible: the app commits and checkpoints its own writes |
| D. Regenerate the sample data | tens of seconds | What we're avoiding |

**A is the recommendation because it needs no test-only code in the server and
cannot leak state.** The database, the change stream's epoch and versions, and
anything a later feature keeps in memory all start over, by construction. B is
faster but has the usual weakness of reset endpoints: it resets what somebody
remembered to reset. The 0.25 s it saves per test isn't worth that until the
suite is in the hundreds.

Tests only ever see a `server` fixture, so switching to B later changes one
file.

### 4.2 The `server` fixture

A test-scoped Playwright fixture, automatic for every test:

1. Copy `target/e2e/template/radiocrate.db` into the test's run directory.
2. Spawn the server:
   `radiocrate serve target/e2e/collection --db-dir <run dir> --no-scan --port <4300 + parallelIndex> --fixed-now <instant>`,
   with `TZ=UTC`.
3. Wait for its `listening` log line, with a timeout that prints the captured
   stderr.
4. Hand the test a `baseURL`.
5. Afterwards kill the process, attach its stderr to the report if the test
   failed, and delete the run directory if it passed.

Each Playwright worker runs one test at a time, so a port per worker index is
enough, and the suite runs `fullyParallel`. Cap `workers` at 4 to start with:
each one holds a DuckDB instance and a Chromium.

### 4.3 The browser side

Playwright gives every test a new browser context, so `localStorage` (open
tabs, sidebar state, expansion memory) starts empty without any work. The E2E
config also sets:

- `serviceWorkers: "block"`, since a production build registers one and its
  precache would outlive the server it came from
- `timezoneId: "UTC"`, `locale: "en-US"`, a fixed viewport, and
  `reducedMotion: "reduce"`
- `retries: 0`. A flake here is a bug to find, as with the visual snapshots.

### 4.4 What serves the frontend

**The production build, served by the `radiocrate` binary.** One process per
test then serves the API and the app from one origin, exactly as a deployment
does, and the routing, content types and embedded-asset fallback get tested
along the way.

- A debug build of `radiocrate` reads `frontend/dist` from disk at run time
  (rust-embed's default in debug), so a frontend change needs `bun run build`
  (20 s, *measured*) but not a recompile. `globalSetup` runs the build only
  when `src/`, `index.html`, `vite.config.ts` or `vendor/` is newer than
  `dist/build-id.txt`.
- `globalSetup` **refuses to run when the binary is older than the backend
  sources** (`backend/src`, `radiocrate/src`, `api-schema`, `introspection`).
  An agent that changed the backend and didn't rebuild would otherwise get a
  green run of the old code. The error names the command that fixes it
  (§4.5).

The Vite dev server proxying to `radiocrate-server` was considered and
rejected. It saves the 20 s build, but the proxy has one fixed target, so
per-worker servers would need a custom proxy, and the thing under test would no
longer be the thing that ships.

### 4.5 Building the server binary

Building the binary is the one step that needs cargo. It goes through a new
xtask, so that what it builds is fixed in one place:

```sh
cargo xtask e2e-build   # cargo build -p radiocrate, dev profile, nothing else
```

It builds the one crate in the dev profile, never `--release` and never
`--workspace`. That way it reuses the dev-profile `libduckdb-sys` that
`cargo test -p backend` already compiles, and the cost should be our own
crates plus a link. Phase 1 measures that, and if it turns out to recompile
DuckDB, this decision is reopened before going further.

**Who may run it.** Agents may run it under the same condition as `cargo
check`: when they haven't changed the top-level `Cargo.toml` or
`backend/Cargo.toml`. After a change there, the user builds, as for any other
cargo command. Phase 1 adds this rule to `CLAUDE.md`'s "Validation" section,
next to the one for `cargo xtask vendor-querydown`.

`globalSetup` never runs cargo itself, even when the binary is stale. Doing so
would get around that rule whenever the suite ran after a dependency change.

---

## 5. Time

### 5.1 Where "now" comes from

| Clock | Read by | Effect on a test |
| --- | --- | --- |
| Generator's `datetime.now()` | Every play, `file.added`, file mtimes | Decides every timestamp in the fixture |
| Browser `Date` | `formatRelative`, the minute tickers, a new play's timestamp, `modified` stamps, a new query's default name | What "ago" counts from, and what new rows are stamped with |
| DuckDB `now()` | Relative filters: Querydown compiles `added:<6m` to `… CAST(NOW() AS TIMESTAMP) - "file"."added" …` (*checked*). Also the scan's `file.added` and migration 0020's `created`/`modified` | Which rows a time-relative preset ("Not played recently", "Added recently") matches |

Leaving any one of the three on the real clock breaks something. A real
browser clock makes "2 minutes ago" drift. A real server clock makes "Not
played recently" match a different set of tracks as the calendar moves away
from the fixture's date.

### 5.2 One frozen instant in three places

`E2E_NOW = 2026-01-15 12:00:00 UTC`, defined once in the E2E support code.

- **Generator:** `--now` (§3.2). The most recent plays land 2.16 minutes
  before it, so they read "2 minutes ago" on every run.
- **Browser:** `page.clock.setFixedTime(E2E_NOW)` in the `page` fixture, before
  navigation. This freezes `Date` but leaves timers and `performance.now()`
  running (*checked* on the installed Playwright 1.61), so debounces,
  animations and Playwright's own waiting behave normally.
- **Server:** `--fixed-now`, which runs this on the connection as soon as
  it's opened, before migrations:

  ```sql
  CREATE TEMP MACRO now() AS (TIMESTAMPTZ '2026-01-15 12:00:00+00');
  ```

  A temp macro shadows the built-in for that connection, is picked up inside
  `CAST(NOW() AS TIMESTAMP)`, is invisible to other connections and writes
  nothing to the file (*checked* on the DuckDB 2.0.0 CLI). The same is done
  for `today`, `current_date` and `get_current_timestamp`. The option is
  hidden from `--help`, and applies to `scan` as well as `serve` so the
  template build is pinned too.

Frozen is better than "starts at the instant and runs". With a running clock
"2 minutes ago" becomes "3 minutes ago" 50 seconds into a test, and the browser
and server drift apart by however long the test takes.

### 5.3 What freezing `Date` breaks

Code that measures *elapsed* time by subtracting two `Date.now()` readings
sees zero forever. I found two places:

- **`IdleQueue` (`api/idleQueue.ts`).** Its idle check is
  `Date.now() - lastActivity < idleMs`, which never becomes false under a
  frozen clock, so it re-arms forever and **autosave never fires**. I traced
  this in the code and didn't run it.
- **The audio engine's stall tracking (`audio/engine.ts`, `lastData`).** Only
  log output is affected.

Both should use `performance.now()`. It's the right clock for durations
regardless, since it doesn't jump when the wall clock is corrected. The
implementing phase should grep for other `Date.now()` subtractions.

### 5.4 Moving the clock inside a test

A test can call `page.clock.setFixedTime()` again to step forward. Two cases
need it:

- **Playing the same track twice.** `play`'s primary key is
  `(track, timestamp)` at one-second resolution, so two plays at one frozen
  instant collide. Step the clock between them.
- **Testing the minute ticker itself**, which the frozen clock otherwise
  hides.

The server's clock doesn't move with it. A test that needs both to move is
rare enough to solve when it appears.

### 5.5 A gap this leaves

Running everything in UTC hides zone mistakes. The app stores browser-local
civil time, while a relative filter compares it against the *server's* `now()`
cast to a civil time. If the server and browser are in different zones, a
filter such as `last_play:<1h` would be off by the difference. I didn't
confirm how the bundled DuckDB resolves that cast, so treat it as a question
to check, not a known bug. Once the suite is stable, one spec run under a
non-UTC `timezoneId` would answer it.

---

## 6. Assertions

### 6.1 Order of preference

1. **Behavioral assertions decide pass or fail.** Web-first, retrying
   `expect`s against roles and accessible names: the tab is called "Tracks",
   the status reads "63 tracks", the Save button is gone. Icon buttons
   already carry their names through `useTooltip`, so role selectors work
   without test ids.
2. **Text snapshots cover "this region shows the right data".**
   - DOM regions (explorer tree, record editor form, a menu):
     `expect(locator).toMatchAriaSnapshot()`. It records roles, names and text
     as YAML.
   - The results grid is a canvas, so the DOM has nothing to read. Add
     `gridText(tabId)` to `AppStoreFacade` (`dev/seed.ts`, reached with
     `?expose=1`), returning the visible columns' `QueryResult.text()` row by
     row, and compare it with `toMatchSnapshot("tracks.txt")`.

   Text snapshots diff in a terminal, review well in git, don't depend on
   fonts or the GPU, don't need a light and a dark copy, and cost
   milliseconds. They answer most of what a screenshot of real data would be
   asked.
3. **Persistence is asserted by reloading.** After a write, `page.reload()`
   and assert through the UI again. That proves the write reached the file
   and reads back through the real path. Where the UI can't show the fact, a
   `db.query(sql)` helper posts to `/api/query` and decodes the Arrow reply
   with the `apache-arrow` package the frontend already depends on.
4. **Pixel snapshots are a budget** (§6.2).

### 6.2 The pixel budget

The harness already owns how components look: 276 baselines behind 137
`toHaveScreenshot` calls. Each call captures and compares an image, and each
baseline is a file that churns. E2E shouldn't repeat that, and in E2E every
snapshot also sits on more asynchronous state than a story does.

- **About one per spec file**, at the state that is the point of the journey
  and that no story can reach: real data, through the real pipeline, in the
  assembled app.
- **At most 12 for the whole suite.** `globalSetup` counts the baselines
  under `tests/e2e/__screenshots__/` and fails when there are more than
  `PIXEL_BUDGET` (12, in `support/globalSetup.ts`). A test that needs a 13th
  either replaces an existing one or raises the constant in the same change,
  where a reviewer sees it.
- **Light theme only.** The theme has nothing to do with the backend. Dark is
  the harness's job.
- **A region, not the page**, wherever one region is the point. The smoke
  test's single full-app shot is the exception.
- Baselines live in `tests/e2e/__screenshots__/<spec>/<state>.png`.

### 6.3 Looking without asserting

What makes snapshots useful to an agent is being able to *see* the app. That
doesn't need a committed baseline:

- **`look(page, "after-save")`** does nothing by default. With `E2E_LOOK=1`
  it saves `test-results/look/<test>/<nn>-after-save.png`. Authors put one at
  each meaningful step, and an agent working on a flow runs that one test with
  the variable set and reads the PNGs.
- **On failure**, the config keeps a screenshot (`only-on-failure`), a trace
  (`retain-on-failure`) and the server's stderr.
- **`test.step`** names the stages of a journey, so a failure says which
  stage it was in.

This is how I'd meet the wish to capture a test's lifecycle visually: many
`look()` calls, few `toHaveScreenshot()` calls. An ordinary run pays for
neither the captures nor the comparisons unless something fails.

### 6.4 Guards on every test

Automatic fixtures, so no test has to remember them:

- Fail on an uncaught page error or a `console.error`.
- Fail on any 5xx from `/api/`.
- Fail if the server's stderr holds a panic.

A test that expects one of these (a rejected query, say) opts out by name.

### 6.5 Arrange through the API, act through the UI

Preconditions are set by calling the real API with Playwright's `request`
fixture: `api.rpc("query.add", …)`, or a DML batch to clear a rating. That
keeps a playlist test from spending ten seconds building its playlist through
menus, and from failing when those menus change. Each creation flow is tested
through the UI once, in its own spec.

No `waitForTimeout`. Wait for what the user would see. For the canvas, poll
the facade (`expect.poll(() => app.grid.rowCount())`). Autosave has a 5 s idle
period: trigger the app's own flush (close the tab, leave the editor) or wait
for the `/api/rpc` response.

### 6.6 What a test looks like

The helper names are proposals.

```ts
import { test, expect, look } from "./fixtures";

test("a retitled track keeps its title after a reload", async ({ app, page }) => {
  await app.openSource("Tracks");
  await expect.poll(() => app.grid.rowCount()).toBe(63);

  await test.step("retitle it in the record editor", async () => {
    await app.grid.editRow({ title: "Billie Jean" });
    const form = page.getByRole("form", { name: "Edit track" });
    await form.getByLabel("title").fill("Billie Jean (2026 mix)");
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByRole("button", { name: "Save" })).toBeHidden();
    await look(page, "saved");
  });

  await test.step("the grid row follows", async () => {
    expect(await app.grid.text()).toMatchSnapshot("tracks-after-retitle.txt");
  });

  await test.step("and it's still there after a reload", async () => {
    await page.reload();
    await app.openSource("Tracks");
    await expect
      .poll(() => app.grid.find({ title: "Billie Jean (2026 mix)" }))
      .not.toBeNull();
  });
});
```

---

## 7. Layout and commands

```
frontend/
  playwright.e2e.config.ts     its own config: no Vite webServer, UTC, SW blocked
  tests/e2e/
    fixtures.ts                test.extend: server, page (clock), app, api, db, guards
    support/
      globalSetup.ts           binary check, frontend build, template build, pixel budget
      template.ts              input hash, generator invocation
      server.ts                spawn, ready, kill
      app.ts                   page object: explorer, grid, record editor
    __screenshots__/  __snapshots__/
    smoke.spec.ts  …
```

A separate config, not a second project in `playwright.config.ts`: the two
suites share no server, no snapshot layout and no defaults.

- `bun run test:e2e` runs the suite. `bun run test:e2e -- record.spec.ts`
  runs one file.
- `E2E_LOOK=1 bun run test:e2e -- -g "retitled track"` to watch one test.
- `bun run test:e2e:update` rewrites text and pixel baselines.

`CLAUDE.md` gets a "Writing E2E tests" section beside "Writing visual snapshot
tests" once phase 2 lands, with the table from §2 and the rules from §6.

---

## 8. Phases

1. **Walking skeleton.** `--now`, `--collection`, `--db-dir` and
   `--server-bin` on the generator. `--fixed-now` on both binaries (a change
   under `backend/src` and `radiocrate/src`, no `Cargo.toml` edit).
   `cargo xtask e2e-build`, and its rule in `CLAUDE.md` (§4.5). `IdleQueue`
   and the audio engine on `performance.now()`. The E2E config, `globalSetup`
   (with the stale-binary check and the pixel budget), the `server` and `page`
   fixtures. One smoke test: the app boots on the sample library, the explorer
   lists Tracks, Albums and Artists, and Tracks opens to 63 rows. Measure what
   `e2e-build` costs after a backend change, and re-measure the per-test cost
   with the current binary.
2. **Assertion toolkit and the core journeys.** `gridText` on the facade, the
   `app` page object, `look()`, the guards, `api` and `db`. Then:
   - build a query (filter, sort, a time-relative preset) and read the rows
   - save a query, let it autosave, reload
   - edit one record and several at once
   - rate a track from the row menu
   - create a playlist, add to it, drag to reorder, remove
3. **The harder corners.**
   - Playback: a double-click streams a track, and finishing it records a
     play and updates "last played".
   - Live updates: two contexts on one server. This is phase 5 of
     `specs/2026-11-live-updates/spec.md`.
   - The Data structure page: hide a field and see the record editor follow.
   - The empty-library fixture and the first-run experience.
   - The private-collection fixture and a rescan.
4. **Hardening, as needed.** Reproducible ids (§3.4), a non-UTC run (§5.5),
   and the reset endpoint if the suite has outgrown a process per test.

Phases 1 and 2 are the commitment. Stop after 2 and judge whether the suite is
catching things before spending on 3.

---

## 9. Decisions

These were open questions in the first draft. Each one is settled as
recommended, and the sections above already describe the result.

1. **Agents build the server binary with `cargo xtask e2e-build`** (§4.5),
   allowed under the same condition as `cargo check`. Without it, an agent
   that touched the backend couldn't run the suite at all. The alternative was
   for you to build it and for agents to run E2E only after frontend changes.
2. **The suite runs the production build** (§4.4), not the Vite dev server.
   The cost is a 20 s frontend build on the first run after a frontend change.
3. **The pixel budget is 12** (§6.2), enforced by `globalSetup`.
4. **CI is out of scope for now.** The suite is for local runs, by you and by
   agents. Running it in CI is a separate decision, once the repo has CI.

---

## 10. What was checked, and what wasn't

Checked in the dev container on 2026-11-23:

- Copying the sample database (12.9 MB): 10–35 ms.
- A debug `radiocrate-server` on a copy answered its first query about 250 ms
  after spawn. One sample, with the binary built 2026-11-16, so re-measure in
  phase 1.
- DuckDB 2.0.0 CLI: a temp macro shadows `now()`, including inside
  `CAST(NOW() AS TIMESTAMP)`, for its own connection only. `current_timestamp`,
  `current_date` and `today()` were pinned the same way.
  `transaction_timestamp()` and `current_localtimestamp()` were not, and
  nothing in the app uses them.
- Querydown compiles `added:<6m` to SQL that calls `NOW()`.
- Playwright 1.61 `page.clock.setFixedTime`: `Date.now()` stayed fixed over
  650 ms while `performance.now()` advanced and an interval fired.
- `bun run build`: 20 s.

Checked while building phases 1 and 2 (2026-11-23/24):

- The macro pins `now()`, `current_timestamp`, `get_current_timestamp()`,
  `today()`, `current_date` and a column's `DEFAULT now()` through the Rust
  crate's bundled DuckDB too (`clock::tests`).
- A debug `radiocrate` serves `frontend/dist` from disk: a frontend rebuild
  reaches the next test with no recompile.
- `cargo xtask e2e-build` after a backend change: 46 s, no DuckDB rebuild.
- Per test: copying the template, spawning the server and answering its first
  query took 65–117 ms over five samples, not the ~0.3 s estimated.
- Building the template: about 5 s. Row order in the unsorted Tracks grid held
  across template rebuilds, so §3.4 hasn't bitten yet.
- Autosave fires under the frozen `Date` now that `IdleQueue` measures with
  `performance.now()` (`query.spec.ts`).
- The whole suite (12 tests, 4 workers) runs in about 50 s.

Ports are taken from the OS rather than `4300 + parallelIndex`, and the run
directory is keyed by the runner's pid, so two suites can run at once (setup
holds a lock on `target/e2e/`).

Not checked:

- Chromium playing the silent FLACs headlessly through the real stream
  endpoint. The existing playback specs use a stubbed backend.
- Memory use of four servers and four browsers at once.
