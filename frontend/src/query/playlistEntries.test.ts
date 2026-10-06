import { describe, expect, it } from "vitest";
import {
  addEntriesWrites,
  appendPositions,
  createPlaylistWrites,
  deletePlaylistWrites,
  dropPositions,
  rearrangeMoves,
  removeEntriesWrites,
  renumberMoves,
  rowEntry,
  sequentialPositions,
  setPositionsWrites,
  sourceTimestamp,
  toDmlRequest,
  type PlaylistEntry,
} from "./playlistEntries";

import { buildResultFromStringRows } from "./result";

/** Ids `n0`, `n1`, … in the order they're asked for. */
function ids(): () => string {
  let next = 0;
  return () => `n${next++}`;
}

function entry(id: string, position: number, track = `t-${id}`): PlaylistEntry {
  return { id, track, position };
}

describe("positions", () => {
  it("append past the integer ceiling of the maximum", () => {
    expect(appendPositions(null, 3)).toEqual([1, 2, 3]);
    expect(appendPositions(7, 2)).toEqual([8, 9]);
    expect(appendPositions(6.25, 2)).toEqual([8, 9]);
    expect(appendPositions(-3.5, 1)).toEqual([-2]);
    expect(appendPositions(4, 0)).toEqual([]);
  });

  it("number a new playlist from 1", () => {
    expect(sequentialPositions(3)).toEqual([1, 2, 3]);
    expect(sequentialPositions(0)).toEqual([]);
  });

  it("space dropped entries evenly between their neighbors", () => {
    expect(dropPositions(6, 7, 3)).toEqual([6.25, 6.5, 6.75]);
    expect(dropPositions(1, 2, 1)).toEqual([1.5]);
  });

  it("drop at the top below the first row's integer floor", () => {
    expect(dropPositions(undefined, 1, 3)).toEqual([-2, -1, 0]);
    expect(dropPositions(undefined, 2.5, 2)).toEqual([0, 1]);
  });

  it("drop at the bottom above the last row's integer ceiling", () => {
    expect(dropPositions(9, undefined, 2)).toEqual([10, 11]);
    expect(dropPositions(9.5, undefined, 1)).toEqual([11]);
  });

  it("don't fit between adjacent doubles", () => {
    const next = 1 + Number.EPSILON;
    expect(dropPositions(1, next, 1)).toBeUndefined();
    // Room for one, but not for three.
    const roomy = 1 + 4 * Number.EPSILON;
    expect(dropPositions(1, roomy, 1)).toHaveLength(1);
    expect(dropPositions(1, roomy, 7)).toBeUndefined();
  });

  it("don't fit between equal or reversed neighbors, or no neighbors", () => {
    expect(dropPositions(3, 3, 1)).toBeUndefined();
    expect(dropPositions(4, 3, 1)).toBeUndefined();
    expect(dropPositions(undefined, undefined, 1)).toBeUndefined();
  });
});

describe("renumberMoves", () => {
  it("numbers entries 1…n in the order given, skipping those already there", () => {
    expect(
      renumberMoves([entry("c", 3), entry("a", 0.5), entry("b", 1.5)]),
    ).toEqual([
      { id: "c", from: 3, to: 1 },
      { id: "a", from: 0.5, to: 2 },
      { id: "b", from: 1.5, to: 3 },
    ]);
    expect(renumberMoves([entry("a", 1), entry("b", 2)])).toEqual([]);
  });

  it("keeps a duplicated track's entries apart", () => {
    expect(renumberMoves([entry("x2", 2, "t"), entry("x1", 1, "t")])).toEqual([
      { id: "x2", from: 2, to: 1 },
      { id: "x1", from: 1, to: 2 },
    ]);
  });
});

describe("rearrangeMoves", () => {
  const all = [entry("a", 6), entry("b", 7), entry("c", 8), entry("d", 9)];

  it("moves only the dragged entries between their neighbors", () => {
    const [a, b, c, d] = all;
    expect(rearrangeMoves(all, [d, c], a, b)).toEqual([
      { id: "d", from: 9, to: 6 + 1 / 3 },
      { id: "c", from: 8, to: 6 + 2 / 3 },
    ]);
  });

  it("moves to the top and the bottom", () => {
    const [a, b, c, d] = all;
    expect(rearrangeMoves(all, [c], undefined, a)).toEqual([
      { id: "c", from: 8, to: 5 },
    ]);
    expect(rearrangeMoves(all, [a, b], d, undefined)).toEqual([
      { id: "a", from: 6, to: 10 },
      { id: "b", from: 7, to: 11 },
    ]);
  });

  it("renumbers everything when the neighbors are too close", () => {
    const tight = [
      entry("a", 1),
      entry("b", 1 + Number.EPSILON),
      entry("c", 3),
    ];
    const [a, b, c] = tight;
    expect(rearrangeMoves(tight, [c], a, b)).toEqual([
      { id: "c", from: 3, to: 2 },
      { id: "b", from: 1 + Number.EPSILON, to: 3 },
    ]);
  });

  it("renumbers hidden entries too, keeping them where they were", () => {
    // `h` is filtered out, so the visible neighbors of the drop are `a` and
    // `b`, and `h` has no claim on the space between them.
    const withHidden = [
      entry("a", 1),
      entry("h", 1),
      entry("b", 1),
      entry("c", 2),
    ];
    const [a, , b, c] = withHidden;
    // The new order is a, c, h, b: `a` and `c` are already at 1 and 2.
    expect(rearrangeMoves(withHidden, [c], a, b)).toEqual([
      { id: "h", from: 1, to: 3 },
      { id: "b", from: 1, to: 4 },
    ]);
  });
});

describe("toDmlRequest", () => {
  it("numbers operations by a counter, not by row", () => {
    const { apply, revert } = removeEntriesWrites("p", [entry("a", 1)]);
    expect(
      toDmlRequest([...apply, ...revert]).operations.map((op) => op.id),
    ).toEqual(["e0", "e1"]);
  });
});

describe("createPlaylistWrites", () => {
  const playlist = {
    sourceId: "s1",
    playlistId: "p1",
    name: "2026-10-06 12:34",
    createdAt: Date.UTC(2026, 9, 6, 12, 34, 56) / 1000,
    folder: "f1",
    position: -1,
    definition: "{}",
  };

  it("inserts the playlist, then its source, then the entries", () => {
    const writes = createPlaylistWrites(
      playlist,
      [
        { track: "t1", position: 1 },
        { track: "t1", position: 2 },
      ],
      ids(),
    );
    expect(writes).toEqual([
      {
        operation: "insert",
        table: "playlist",
        values: { id: "p1", definition: "{}" },
      },
      {
        operation: "insert",
        table: "source",
        values: {
          id: "s1",
          name: "2026-10-06 12:34",
          created_at: "2026-10-06 12:34:56",
          modified_at: "2026-10-06 12:34:56",
          last_play: "2026-10-06 12:34:56",
          source_folder: "f1",
          position: -1,
          playlist: "p1",
        },
      },
      {
        operation: "insert",
        table: "playlist_track",
        values: { id: "n0", playlist: "p1", track: "t1", position: 1 },
      },
      {
        operation: "insert",
        table: "playlist_track",
        values: { id: "n1", playlist: "p1", track: "t1", position: 2 },
      },
    ]);
  });

  it("creates an empty playlist with no entries", () => {
    expect(createPlaylistWrites(playlist, [], ids())).toHaveLength(2);
  });
});

describe("sourceTimestamp", () => {
  it("reads epoch seconds as UTC civil time", () => {
    expect(sourceTimestamp(0)).toBe("1970-01-01 00:00:00");
    expect(sourceTimestamp(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000)).toBe(
      "2026-01-02 03:04:05",
    );
  });
});

describe("deletePlaylistWrites", () => {
  it("deletes the entries, then the source, then the playlist", () => {
    expect(
      deletePlaylistWrites({ sourceId: "s1", playlistId: "p1" }, ["a", "b"]),
    ).toEqual([
      { operation: "delete", table: "playlist_track", where: { id: "a" } },
      { operation: "delete", table: "playlist_track", where: { id: "b" } },
      { operation: "delete", table: "source", where: { id: "s1" } },
      { operation: "delete", table: "playlist", where: { id: "p1" } },
    ]);
  });

  it("deletes an empty playlist", () => {
    expect(
      deletePlaylistWrites({ sourceId: "s1", playlistId: "p1" }, []),
    ).toHaveLength(2);
  });
});

describe("addEntriesWrites", () => {
  it("appends in the given order, and is undone by deleting the new entries", () => {
    expect(addEntriesWrites("p1", ["t2", "t1", "t2"], 4.5, ids())).toEqual({
      apply: [
        {
          operation: "insert",
          table: "playlist_track",
          values: { id: "n0", playlist: "p1", track: "t2", position: 6 },
        },
        {
          operation: "insert",
          table: "playlist_track",
          values: { id: "n1", playlist: "p1", track: "t1", position: 7 },
        },
        {
          operation: "insert",
          table: "playlist_track",
          values: { id: "n2", playlist: "p1", track: "t2", position: 8 },
        },
      ],
      revert: [
        { operation: "delete", table: "playlist_track", where: { id: "n0" } },
        { operation: "delete", table: "playlist_track", where: { id: "n1" } },
        { operation: "delete", table: "playlist_track", where: { id: "n2" } },
      ],
    });
  });

  it("starts an empty playlist at 1", () => {
    const { apply } = addEntriesWrites("p1", ["t1"], null, ids());
    expect(apply[0]).toMatchObject({ values: { position: 1 } });
  });
});

describe("removeEntriesWrites", () => {
  it("is undone by re-inserting the whole records", () => {
    expect(removeEntriesWrites("p1", [entry("a", 2.5, "t1")])).toEqual({
      apply: [
        { operation: "delete", table: "playlist_track", where: { id: "a" } },
      ],
      revert: [
        {
          operation: "insert",
          table: "playlist_track",
          values: { id: "a", playlist: "p1", track: "t1", position: 2.5 },
        },
      ],
    });
  });
});

describe("setPositionsWrites", () => {
  it("is undone by moving the entries back", () => {
    expect(setPositionsWrites([{ id: "a", from: 3, to: 1 }])).toEqual({
      apply: [
        {
          operation: "update",
          table: "playlist_track",
          where: { id: "a" },
          values: { position: 1 },
        },
      ],
      revert: [
        {
          operation: "update",
          table: "playlist_track",
          where: { id: "a" },
          values: { position: 3 },
        },
      ],
    });
  });
});

describe("rowEntry", () => {
  it("reads a row's entry from the hidden id and position columns", () => {
    const result = buildResultFromStringRows(
      [
        ["e1", "6.25", "t1"],
        [null, "7", "t2"],
        ["e3", null, "t3"],
      ],
      [0, 1],
    );
    expect(rowEntry(result, 0)).toEqual({ id: "e1", position: 6.25 });
    expect(rowEntry(result, 1)).toBeUndefined();
    expect(rowEntry(result, 2)).toBeUndefined();
    expect(rowEntry(result, 3)).toBeUndefined();
  });
});
