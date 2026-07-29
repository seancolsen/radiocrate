# Arrow-backed results

Keep a query's answer as the **Arrow table DuckDB sent**, every column of it, and
derive display text at paint time instead of stringifying the whole result up
front.

Status: **proposed**, 2026-07-29. Supersedes the "lineage on demand" sketch from
the same day, which tried to reach the same place by bolting a second copy of the
raw values onto the decoded result.

## Why

`buildResultFromArrow` currently walks the whole Arrow table once per run and
produces, per visible column, a `string[]` of finished display text — formatter,
prefix and suffix already applied. The Arrow table is then dropped, and with it
every hidden column and every raw value. Three things follow from that, all of
them bad:

1. **Derived text is frozen at decode time.** A `relativeTime` column reads
   `Date.now()` when the string is built and never again. Finish a track and its
   "last play" correctly becomes "0 minutes ago" — and then stays "0 minutes ago"
   for the rest of the session, through every scroll and repaint. Nothing short
   of re-running the query fixes it.
2. **Identity has to be snapshotted separately.** Because hidden columns are
   dropped and visible ones survive only as *formatted* text (`#2` where the
   database has `2`), the store can't ask the result what row 42's `track.id` is.
   So `analyzeLineage` transposes the key columns out of the Arrow table into
   `RecordTarget.keyValues` while it still can — a second, per-row copy of data
   the result was holding a moment earlier, which then goes stale the instant a
   DML re-read updates the row's cells.
3. **The work is done for rows nobody looks at.** Only the visible window is
   painted (`canvasGrid`: `for (let r = first; r <= last; r++)`), perhaps thirty
   rows of a result with tens of thousands. Every other row's text is built,
   held, and never drawn.

Deriving at paint time removes all three: text is as fresh as the frame, raw
values (hidden columns included) are always there to be read, and the only cells
formatted are the ones on screen.

## The one thing that can't be done literally

> when we update a row via DML, we'd go in and mutate the stored arrow values

Arrow vectors can't be mutated. A `Vector` is an immutable view over packed
buffers — for a `Utf8` column the strings live end-to-end in one byte buffer with
an offsets array, so writing a different-length string into row 42 would mean
rewriting every offset after it. apache-arrow JS exposes no setter, and adding
one by hand would mean owning buffer layout.

The same observable effect comes from an **indirection** instead. The re-read
already returns its own Arrow table — one row, same projection — so keep it and
point the row at it:

```ts
/** Where a display row's values live. Rows come from the run's own table until
 * something re-reads one, after which that row's values come from the one-row
 * table its re-read returned. */
class ResultValues {
  constructor(private readonly table: Table) {}
  private patches = new Map<number, { table: Table; row: number }>();

  cell(row: number, column: number): unknown {
    const patch = this.patches.get(row);
    return patch
      ? patch.table.getChildAt(column)?.get(patch.row)
      : this.table.getChildAt(column)?.get(row);
  }

  /** Re-point one row at a freshly read table (see `query/rowDml.ts`). */
  patchRow(row: number, table: Table, from: number): void { … }
}
```

A `Map` that is empty in the ordinary case, one small table per re-read row, all
of it dropped when the query re-runs. No copying, no decode, and the type of each
column still comes from the schema.

The patch table's projection has to match the result's — the narrowed re-read
compiles the same display section, so it does; assert on schema width and skip
the patch rather than trusting it.

## Shape

```ts
/** One output column of a query: what it is, and how to read it. Columns are
 * kept in projection order — the Arrow column order — hidden ones included, so
 * a lineage index always addresses the right one. */
interface ResultColumn {
  /** Position in the query's projection (= the Arrow column index). */
  index: number;
  meta: ColumnMetadata;
  isList: boolean;
}

class QueryResult {
  readonly rowCount: number;
  readonly columns: readonly ResultColumn[];
  /** The columns the grid lays out and paints, in order (`!meta.hide`). */
  readonly visible: readonly ResultColumn[];

  /** The raw value in a cell, as Arrow gives it — what a key or a track id is
   * read from. `null`/`undefined` for a NULL cell. */
  value(row: number, column: number): unknown;
  /** A scalar cell's display text, formatted **now**. */
  text(row: number, column: ResultColumn): string;
  /** A list cell's pill texts, formatted now. */
  pills(row: number, column: ResultColumn): readonly string[];
  /** Re-point one row at a re-read (returns false if the schema doesn't fit). */
  patchRow(row: number, table: Table, from: number): boolean;
}
```

`text` is exactly today's pipeline, just called later:
`displayText(meta, stringifyArrowValue(value, arrowType))`. Keeping that
composition unchanged is deliberate — the formatters keep parsing strings, the
format tests keep passing, and this refactor stays about *when* the work happens.
(Teaching `format.ts` to take raw values and skip the round trip is a sensible
follow-up, and out of scope here.)

Making `QueryResult` a **class** is load-bearing, not stylistic. Solid's
`updatePath` merges an assigned object into the one already at a store leaf when
both are `isWrappable`, and a class instance is not wrappable — so assigning one
swaps the reference, which is what the grid's effect watches. The delete-then-set
dance in `setTabResult` and the `unwrap()` in `QueryResults` exist only to work
around that merge and can both go.

## What this fixes, concretely

- **Relative times keep up.** Any repaint re-derives them; scrolling refreshes
  what's on screen. Plus the ticker below for the idle case.
- **Row identity is read, not remembered.** `RecordTarget.keyValues` and
  `trackIdsByTab` disappear. The store keeps only what the analysis found —
  `{ trackIdColumn?: number; records: RecordKeyColumns[] }` per tab — and
  `rowRecords(tab, row)` reads `result.value(row, keyIndex)` on demand. A row
  re-read after a DML write updates its key values for free, because they are
  the same values the grid is painting.
- **Aggregates and computed columns are as fresh as their row.** Already true
  after the row-refresh work; this just stops there being a second copy that
  isn't.

## Work

1. **`query/result.ts`** — replace `buildResultFromArrow`'s eager stringification
   with the class above. Keep the list-detection fallback (`isListType`, then the
   first non-null value) as a one-time per-column decision at construction. Stop
   dropping hidden columns; compute `visible` once.
2. **`components/canvasGrid.ts`** — `relayout` and `drawCell` iterate
   `result.visible` (and `colSizesOf` derives from it), and `drawCell` calls
   `result.text(...)` / `result.pills(...)` instead of indexing `col.cells[r]`.
   Nothing else in the engine changes: it already draws only `[first, last]`.
3. **`state/store.tsx`** — hold the lineage *mapping* per tab instead of
   per-row snapshots; rewrite `rowRecords`, `trackIdAt`, `locateRow` and
   `playlistAround` as reads through the result. `analyzeLineage` shrinks to
   "analyze, store the mapping" — but keep the list-column veto (a key whose
   values arrive as a list identifies no record) where the table is in hand.
   `setTabResult` loses the delete-then-set workaround.
4. **`query/rowDml.ts`** — stop decoding the re-read into `RowCells`; hand the
   store the re-read `Table` plus the row index it found, and let
   `QueryResult.patchRow` take it. `applyRowCells` becomes `patchRow` + the
   existing `rowPatch` repaint signal.
5. **Fixtures** — `dev/gridFixture.ts` builds a `QueryResult` from plain strings
   today; it must build a real Arrow table instead (`arrow.vectorFromArray`,
   with the list builder from `result.test.ts`), which is what
   `buildResultFromCells` exists for. Give the columns honest types — a
   `TimestampSecond` for a timestamp, `Int32` for the track number — so the
   seeded grid exercises the same decode production does. `?records=` / `?tracks=`
   become column indices into that table rather than fabricated per-row values.
6. **Tests** — `result.test.ts` moves from asserting `cells` arrays to asserting
   `text(row, col)`; add one for `patchRow` (a patched row reads from the new
   table, its neighbours don't) and one proving a `relativeTime` cell re-derives
   (build a result, advance a fake clock, read again). The visual baselines
   should not move: same values, same formatters, same pixels — verify rather
   than assume.

## Performance

The claim this rests on is that formatting ~30 rows × ~8 columns per frame is
free. It should be: `format.ts` is hand-rolled string and number math with no
`Intl` construction anywhere, and the canvas already does per-cell
`measureText` work on the same cells. But it is a claim about the hot path
during a touch fling, so measure it rather than assert it:

- **Budget.** A fling over a 50k-row result stays under ~4 ms of scripting per
  frame on the reference device.
- **Method.** Seed a large result, fling, record frame times via the existing
  `frame` loop; compare against `main` before the change.
- **If it misses.** Add a per-column memo of the visible window's derived text —
  a `Map<row, string>` capped to a few hundred entries, cleared on `patchRow`
  and on the relative-time tick. Do not reach for this first; a memo that has to
  be invalidated correctly is exactly the complexity this change is removing.

Two allocation notes for whoever profiles: apache-arrow decodes a **new string
per `get()`** on a `Utf8` column (no internal cache), and a list cell's `get()`
returns a sub-vector that has to be walked to build its pills. Both are bounded
by the visible window.

## The relative-time ticker

Scrolling refreshes what's on screen, but a user staring at a still grid should
still see "1 minute ago" arrive. Add to the query page:

- A 60 s interval that calls `grid.redraw()` — the same repaint the row-patch
  signal asks for, so nothing new is needed downstream.
- Armed **only when some visible column carries a `relativeTime` formatter**;
  otherwise every other query pays for a wakeup that changes no pixel.
- Paused while `document.hidden`, and cleared on unmount. A background tab that
  wakes up once a minute to repaint an invisible canvas is exactly the kind of
  thing that shows up in a battery report.
- A cell can be up to ~59 s stale between ticks, since elapsed-time boundaries
  don't align to wall-clock minutes. That's fine; aligning the interval to the
  minute would not fix it.

## Risks and open questions

- **Memory.** Holding the Arrow table per tab keeps its buffers alive, but
  columnar Arrow is smaller than the JS strings it replaces, so this should be a
  net reduction — confirm with a heap snapshot on a tab holding a big query.
- **Patch tables accumulate** while a tab stays open: one small table per
  re-read row. Bounded by how many rows the user writes to between runs, and
  dropped on re-run. If it ever matters, compact on run instead of tracking it.
- **Hidden columns are now decoded on demand rather than never.** That's the
  point, but it means a hidden column's raw value is no longer guaranteed to
  have been read at least once — nothing depends on that today; check nothing
  starts to.
- **Lineage stays positional.** `column_sources` reports one entry per output
  column and the store indexes it against Arrow columns. Duplicate output names
  are handled in the Querydown the user writes (alias `album.id` as `album_id`),
  not here.

## Not in scope

- Teaching `format.ts` to consume raw Arrow values instead of round-tripping
  through a string (worth doing, independent, and easier once this lands).
- Making the lineage analysis lazy rather than post-run.
- Virtualizing the Arrow table itself (streaming, paging). The result is one
  buffered response today and stays that way.
