import { describe, expect, it } from "vitest";
import {
  canIgnore,
  ignoreOperations,
  ignoreSpare,
  loadIgnoreInfo,
  type IgnoreInfo,
} from "./ignoreAlbum";

const keys = (...ids: string[]) =>
  ids.map((value) => [{ column: "id", value }]);

const tables = (...names: string[]) => names.map((name) => ({ name }));
const ALL = tables(
  "album",
  "track",
  "credit",
  "ignored_album",
  "artist_ignored_album",
);

describe("canIgnore", () => {
  it("offers to ignore albums, in a library with the tables for it", () => {
    expect(canIgnore("album", ALL)).toBe(true);
    expect(canIgnore("track", ALL)).toBe(false);
    expect(canIgnore("album", tables("album", "track", "credit"))).toBe(false);
  });
});

describe("loadIgnoreInfo", () => {
  it("reads each album's artists, and which are ignored already", async () => {
    const asked: string[] = [];
    const info = await loadIgnoreInfo(keys("a1", "a2"), (sql) => {
      asked.push(sql);
      return Promise.resolve(
        sql.includes("main.credit")
          ? [
              ["a1", "x1"],
              ["a1", "x2"],
              ["a2", "x1"],
            ]
          : [["a2"]],
      );
    });
    expect(info.artists).toEqual(
      new Map([
        ["a1", ["x1", "x2"]],
        ["a2", ["x1"]],
      ]),
    );
    expect(info.ignored).toEqual(new Set(["a2"]));
    expect(asked.every((sql) => sql.includes("IN ('a1', 'a2')"))).toBe(true);
    expect(ignoreSpare(info)).toEqual({ artist: new Set(["x1", "x2"]) });
  });
});

describe("ignoreOperations", () => {
  const info: IgnoreInfo = {
    artists: new Map([
      ["a1", ["x1", "x2"]],
      ["a3", ["x3"]],
    ]),
    ignored: new Set(["a3"]),
  };

  it("records each album with its artists, after the deletion", () => {
    expect(
      ignoreOperations(
        keys("a1", "a2", "a3"),
        info,
        "  Too slick  ",
        "2026-01-15 12:00:00",
      ),
    ).toEqual([
      {
        operation: "insert",
        id: "ignore0",
        table: "ignored_album",
        values: {
          album: "a1",
          timestamp: "2026-01-15 12:00:00",
          reason: "Too slick",
        },
      },
      {
        operation: "insert",
        id: "ignore0.artist0",
        table: "artist_ignored_album",
        values: { artist: "x1", ignored_album: { id: "ignore0" } },
      },
      {
        operation: "insert",
        id: "ignore0.artist1",
        table: "artist_ignored_album",
        values: { artist: "x2", ignored_album: { id: "ignore0" } },
      },
      // An album with no credits left to read is still recorded; one ignored
      // already keeps the record it has.
      {
        operation: "insert",
        id: "ignore1",
        table: "ignored_album",
        values: {
          album: "a2",
          timestamp: "2026-01-15 12:00:00",
          reason: "Too slick",
        },
      },
    ]);
  });

  it("records no reason for a blank one", () => {
    const [op] = ignoreOperations(keys("a2"), info, " ", "2026-01-15 12:00:00");
    expect(op).toMatchObject({ values: { reason: null } });
  });
});
