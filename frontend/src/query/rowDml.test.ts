import { describe, expect, it } from "vitest";
import { narrowedDefinition, type RowRecord } from "./rowDml";
import { emptyDefinition, type QueryDefinition } from "./definition";

// The half of the row re-read that's decidable without a backend: whether a
// query can be narrowed to one record at all, and what that narrowed query is.
// (Running it, and the whole-query search that stands in when it can't be built,
// need a compiler and an API.)

function definition(over: Partial<QueryDefinition> = {}): QueryDefinition {
  return { ...emptyDefinition(), base: "track", ...over };
}

const track: RowRecord = {
  table: "track",
  key: [{ column: "id", value: "t-1" }],
};
const album: RowRecord = {
  table: "album",
  key: [{ column: "id", value: "a-1" }],
};

describe("narrowedDefinition", () => {
  it("replaces the filter with the base record's key and drops the sort", () => {
    const def = definition({
      filter: { custom: "#play|le(10)", presets: ["p1"] },
      sort: { custom: "\\\\title" },
      display: { custom: "$title $#play" },
    });
    expect(narrowedDefinition(def, [track, album])).toEqual({
      base: "track",
      filter: { custom: 'id:="t-1"', presets: [] },
      sort: { custom: "" },
      display: { custom: "$title $#play" },
    });
  });

  it("keeps a display that's a preset reference, so the columns stay the same", () => {
    const def = definition({ display: { preset: "display-preset-id" } });
    expect(narrowedDefinition(def, [track])?.display).toEqual({
      preset: "display-preset-id",
    });
  });

  it("names every column of a composite key", () => {
    const credit: RowRecord = {
      table: "credit",
      key: [
        { column: "track", value: "t-1" },
        { column: "artist", value: "a-9" },
      ],
    };
    expect(
      narrowedDefinition(definition({ base: "credit" }), [credit])?.filter,
    ).toEqual({ custom: 'track:="t-1"\nartist:="a-9"', presets: [] });
  });

  it("gives up on a hand-written whole query — there are no sections to replace", () => {
    const def = definition({ full: '#track{id:="t-1"} $title' });
    expect(narrowedDefinition(def, [track])).toBeUndefined();
  });

  it("gives up when the row identifies no record of the base table", () => {
    expect(narrowedDefinition(definition(), [album])).toBeUndefined();
    expect(narrowedDefinition(definition(), [])).toBeUndefined();
  });

  it("gives up without a base table", () => {
    expect(
      narrowedDefinition(definition({ base: "  " }), [track]),
    ).toBeUndefined();
  });
});
