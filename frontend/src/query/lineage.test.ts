import { describe, expect, it } from "vitest";
import { recordKeyColumns, trackIdColumn, type ColumnSources } from "./lineage";
import { parseSchemaTables } from "./schema";

// The interpretation layer over the WASM lineage analysis: given each output
// column's source table columns, which tables' records do the rows identify?
// (The analysis itself is polyglot-sql's and is exercised by that crate.)

const TABLES = parseSchemaTables(`{
  "tables": [
    { "name": "track", "unique_constraints": [["id"]], "columns": [
      { "name": "id", "type": "UUID", "nullable": false },
      { "name": "title", "type": "VARCHAR", "nullable": true }
    ] },
    { "name": "album", "unique_constraints": [["id"]], "columns": [
      { "name": "id", "type": "UUID", "nullable": false },
      { "name": "name", "type": "VARCHAR", "nullable": true }
    ] },
    { "name": "credit", "unique_constraints": [["track", "artist"]], "columns": [
      { "name": "track", "type": "UUID", "nullable": false },
      { "name": "artist", "type": "UUID", "nullable": false }
    ] }
  ],
  "links": []
}`);

/** Terse fixture builder: `["track.id", "", "album.id"]` → column sources. */
const sources = (...cols: string[]): ColumnSources =>
  cols.map((col) =>
    col === ""
      ? []
      : col.split(",").map((pair) => {
          const [table, column] = pair.split(".");
          return { table, column };
        }),
  );

describe("trackIdColumn", () => {
  it("finds the sole column tracing to track.id", () => {
    expect(trackIdColumn(sources("track.title", "track.id"))).toBe(1);
  });

  it("gives up when two columns trace to it", () => {
    expect(trackIdColumn(sources("track.id", "track.id"))).toBeUndefined();
  });

  it("gives up when none does", () => {
    expect(trackIdColumn(sources("track.title", ""))).toBeUndefined();
  });
});

describe("recordKeyColumns", () => {
  it("finds a table whose single-column key the rows carry", () => {
    expect(
      recordKeyColumns(sources("track.id", "track.title"), TABLES),
    ).toEqual([{ table: "track", keyColumns: ["id"], keyIndices: [0] }]);
  });

  it("finds one table per key present, leftmost first", () => {
    const found = recordKeyColumns(
      sources("album.id", "track.title", "track.id"),
      TABLES,
    );
    expect(found.map((f) => f.table)).toEqual(["album", "track"]);
  });

  it("drops a table whose key two columns trace to", () => {
    // Two `track.id` columns: the row could stand for either track.
    const found = recordKeyColumns(
      sources("track.id", "track.id", "album.id"),
      TABLES,
    );
    expect(found.map((f) => f.table)).toEqual(["album"]);
  });

  it("finds a composite key only when every column is present", () => {
    expect(
      recordKeyColumns(sources("credit.track", "credit.artist"), TABLES),
    ).toEqual([
      { table: "credit", keyColumns: ["track", "artist"], keyIndices: [0, 1] },
    ]);
    // Half a key identifies nothing.
    expect(recordKeyColumns(sources("credit.track"), TABLES)).toEqual([]);
  });

  it("finds nothing in rows carrying no key", () => {
    expect(recordKeyColumns(sources("track.title", ""), TABLES)).toEqual([]);
  });

  it("matches table and column case-insensitively", () => {
    const found = recordKeyColumns(sources("TRACK.ID"), TABLES);
    expect(found.map((f) => f.table)).toEqual(["track"]);
  });

  it("reads a column that traces to several sources as all of them", () => {
    // A join key can carry both sides' lineage.
    const found = recordKeyColumns(
      sources("credit.track,track.id", "credit.artist"),
      TABLES,
    );
    expect(found.map((f) => f.table)).toEqual(["track", "credit"]);
  });
});
