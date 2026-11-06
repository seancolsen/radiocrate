import { describe, expect, it } from "vitest";
import {
  childRecordsTabName,
  recordDescriptor,
  relatedRecordsTabName,
  textColumns,
} from "./tabNames";

describe("recordDescriptor", () => {
  it("prefers a name, then a title, then any other text", () => {
    expect(
      recordDescriptor([
        { column: "note", value: "a note" },
        { column: "title", value: "A Title" },
        { column: "name", value: "A Name" },
      ]),
    ).toBe("A Name");
    expect(
      recordDescriptor([
        { column: "note", value: "a note" },
        { column: "Title", value: "A Title" },
      ]),
    ).toBe("A Title");
    expect(
      recordDescriptor([
        { column: "genre", value: "Pop" },
        { column: "note", value: "a note" },
      ]),
    ).toBe("Pop");
  });

  it("skips empty, missing and overlong text", () => {
    expect(
      recordDescriptor([
        { column: "name", value: null },
        { column: "title", value: "  " },
        { column: "lyrics", value: "x".repeat(100) },
        { column: "genre", value: "x".repeat(99) },
      ]),
    ).toBe("x".repeat(99));
  });

  it("has nothing to say without text", () => {
    expect(recordDescriptor([])).toBeUndefined();
    expect(recordDescriptor([{ column: "name", value: "" }])).toBeUndefined();
  });
});

describe("textColumns", () => {
  it("lists a table's text columns in order", () => {
    expect(
      textColumns({
        name: "track",
        uniqueConstraints: [],
        columns: [
          { name: "id", type: "UUID", nullable: false },
          { name: "title", type: "VARCHAR", nullable: false },
          { name: "length", type: "INTEGER", nullable: true },
          { name: "genre", type: "VARCHAR", nullable: true },
        ],
      }),
    ).toEqual(["title", "genre"]);
    expect(textColumns(undefined)).toEqual([]);
  });
});

describe("tab names", () => {
  it("puts the record after the table of a field's records", () => {
    expect(childRecordsTabName("credit", "When I'm Sixty Four")).toBe(
      "credits: When I'm Sixty Four",
    );
    expect(childRecordsTabName("credit", undefined)).toBe("credits");
  });

  it("puts the record before the table of related records", () => {
    expect(relatedRecordsTabName("album", "Pink Floyd")).toBe(
      "Pink Floyd: albums",
    );
    expect(relatedRecordsTabName("track", undefined)).toBe("tracks");
  });

  it("falls back to the raw name of a table it doesn't know", () => {
    expect(childRecordsTabName("my_table", "x")).toBe("my_table: x");
  });
});
