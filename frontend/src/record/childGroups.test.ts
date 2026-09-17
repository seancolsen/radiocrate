import { describe, expect, it } from "vitest";
import { groupChildRows, type ChildRowLayout } from "./childGroups";

// The credits of one or more tracks, as `childRecordsQuery` returns them: the
// key columns `(track, artist)`, then one preview column (`artist.name`), then
// every column of `credit`.

const LAYOUT: ChildRowLayout = {
  keyColumns: ["track", "artist"],
  previewWidth: 1,
  columns: ["track", "artist", "order", "role"],
  linkColumn: "track",
};

/** One row of that query: key, preview, then the record's own columns. */
const credit = (
  track: string,
  artist: string,
  name: string,
  order: string | null,
  role: string | null,
) => [track, artist, name, track, artist, order, role];

describe("groupChildRows", () => {
  it("collapses records that differ only in the base record they hang off", () => {
    // Two tracks, each credited to Beyoncé at order 1 — one row, standing for
    // both records, showing what both of them say.
    const groups = groupChildRows(
      [
        credit("t1", "a1", "Beyoncé", "1", null),
        credit("t2", "a1", "Beyoncé", "1", null),
      ],
      LAYOUT,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].cells).toEqual(["Beyoncé"]);
    expect(groups[0].keys).toEqual([
      [
        { column: "track", value: "t1" },
        { column: "artist", value: "a1" },
      ],
      [
        { column: "track", value: "t2" },
        { column: "artist", value: "a1" },
      ],
    ]);
    // Which base record each of them belongs to, in the same order.
    expect(groups[0].links).toEqual(["t1", "t2"]);
  });

  it("keeps records apart when they disagree on anything else", () => {
    const groups = groupChildRows(
      [
        credit("t1", "a1", "Beyoncé", "1", null),
        // The same artist on the same track, at a different order: a different
        // thing to say, so a row of its own.
        credit("t2", "a1", "Beyoncé", "2", null),
        credit("t2", "a2", "Jack White", "2", "featured"),
      ],
      LAYOUT,
    );
    expect(groups.map((g) => g.keys.length)).toEqual([1, 1, 1]);
    expect(groups.map((g) => g.cells[0])).toEqual([
      "Beyoncé",
      "Beyoncé",
      "Jack White",
    ]);
  });

  it("is an identity for the records of a single base record", () => {
    // Two records of one parent must differ in some key column, and every key
    // column is compared — so nothing collapses, whatever else they share.
    const groups = groupChildRows(
      [
        credit("t1", "a1", "Beyoncé", "1", null),
        credit("t1", "a2", "Jack White", "1", null),
      ],
      LAYOUT,
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.keys.length === 1)).toBe(true);
  });

  it("keeps the order the query returned, each row placed at its first record", () => {
    const groups = groupChildRows(
      [
        credit("t1", "a2", "Jack White", "1", null),
        credit("t1", "a1", "Beyoncé", "2", null),
        credit("t2", "a2", "Jack White", "1", null),
      ],
      LAYOUT,
    );
    expect(groups.map((g) => g.cells[0])).toEqual(["Jack White", "Beyoncé"]);
    expect(groups[0].keys).toHaveLength(2);
  });

  it("tells a NULL apart from an empty string", () => {
    const groups = groupChildRows(
      [
        credit("t1", "a1", "Beyoncé", "1", null),
        credit("t2", "a1", "Beyoncé", "1", ""),
      ],
      LAYOUT,
    );
    expect(groups).toHaveLength(2);
  });

  it("carries an empty preview through for the caller to fall back from", () => {
    const groups = groupChildRows(
      [
        ["t1", "2016-04-24", "t1", "2016-04-24"],
        ["t2", "2016-04-24", "t2", "2016-04-24"],
      ],
      {
        keyColumns: ["track", "timestamp"],
        previewWidth: 0,
        columns: ["track", "timestamp"],
        linkColumn: "track",
      },
    );
    // Two plays at the same moment on two tracks: one row, no preview cells.
    expect(groups).toHaveLength(1);
    expect(groups[0].cells).toEqual([]);
    expect(groups[0].links).toEqual(["t1", "t2"]);
  });
});
