import { describe, expect, it } from "vitest";
import {
  buildFormFields,
  childRecordsQuery,
  keyConditions,
  quoteValue,
  recordDataQuery,
  valueTypeOf,
  type MultiRecordField,
} from "./recordForm";
import type { SchemaTable } from "./schema";

/** A cut of the RadioCrate schema with all the shapes the form has to handle: a
 * table with FKs both ways (`track`), a nullable FK (`track.album`), a
 * composite-keyed referencing table (`credit`), and one referencing table that
 * sorts after another alphabetically (`play`). */
const col = (name: string, type: string, nullable = false) => ({
  name,
  type,
  nullable,
});
const TABLES: SchemaTable[] = [
  {
    name: "album",
    columns: [col("id", "UUID"), col("title", "VARCHAR", true)],
    uniqueConstraints: [["id"]],
  },
  {
    name: "artist",
    columns: [col("id", "UUID"), col("name", "VARCHAR")],
    uniqueConstraints: [["id"], ["name"]],
  },
  {
    name: "credit",
    columns: [
      col("track", "UUID"),
      col("artist", "UUID"),
      col("ord", "FLOAT", true),
      col("role", "VARCHAR", true),
    ],
    uniqueConstraints: [["track", "artist"]],
  },
  {
    name: "play",
    columns: [col("track", "UUID"), col("timestamp", "TIMESTAMP_S")],
    uniqueConstraints: [["track", "timestamp"]],
  },
  {
    name: "track",
    columns: [
      col("id", "UUID"),
      col("title", "VARCHAR"),
      col("album", "UUID", true),
      col("track_number", "UTINYINT", true),
    ],
    uniqueConstraints: [["id"]],
  },
];

const keysOf = (table: string, hidden?: string[]) =>
  buildFormFields(TABLES, table, hidden).map((f) => f.key);

describe("valueTypeOf", () => {
  it("classifies the types the form renders differently", () => {
    expect(valueTypeOf("UUID")).toBe("uuid");
    expect(valueTypeOf("VARCHAR")).toBe("text");
    expect(valueTypeOf("varchar(20)")).toBe("text");
    expect(valueTypeOf("UTINYINT")).toBe("number");
    expect(valueTypeOf("DECIMAL(4,2)")).toBe("number");
    expect(valueTypeOf("TIMESTAMP_S")).toBe("timestamp");
    expect(valueTypeOf("BOOLEAN")).toBe("boolean");
  });

  it("falls back to `other` for an unknown type (e.g. a user ENUM)", () => {
    expect(valueTypeOf("format")).toBe("other");
    expect(valueTypeOf(undefined)).toBe("other");
  });
});

describe("buildFormFields", () => {
  it("lists intrinsic fields in introspection order, then referencing tables alphabetically", () => {
    expect(keysOf("track")).toEqual([
      "id",
      "title",
      "album",
      "track_number",
      "#credit",
      "#play",
    ]);
  });

  it("makes a foreign-key column a scalar linked record field", () => {
    const fields = buildFormFields(TABLES, "track");
    expect(fields.find((f) => f.key === "album")).toEqual({
      kind: "scalarLink",
      key: "album",
      label: "album",
      column: "album",
      table: "album",
      keyColumn: "id",
      nullable: true,
    });
  });

  it("makes a referencing table a multi-record field carrying its key", () => {
    const fields = buildFormFields(TABLES, "track");
    expect(fields.find((f) => f.key === "#credit")).toEqual({
      kind: "multiRecord",
      key: "#credit",
      label: "credit",
      table: "credit",
      column: "track",
      keyColumns: ["track", "artist"],
    });
  });

  it("classifies every other column as a primitive field", () => {
    const fields = buildFormFields(TABLES, "track");
    expect(fields.find((f) => f.key === "title")).toEqual({
      kind: "primitive",
      key: "title",
      label: "title",
      column: "title",
      valueType: "text",
      nullable: false,
    });
  });

  it("hides the contextual filter column of a record reached through a list", () => {
    // A credit listed under a track: its `track` field would say the same thing
    // for every sibling, so it's dropped.
    expect(keysOf("credit", ["track"])).toEqual(["artist", "ord", "role"]);
  });

  it("has no fields for a table the schema doesn't know", () => {
    expect(buildFormFields(TABLES, "nope")).toEqual([]);
  });
});

describe("Querydown generation", () => {
  it("escapes quotes and backslashes in a value", () => {
    expect(quoteValue(`a"b\\c`)).toBe(`"a\\"b\\\\c"`);
  });

  it("matches a record on every column of its key, exactly", () => {
    expect(
      keyConditions([
        { column: "track", value: "t1" },
        { column: "artist", value: "a1" },
      ]),
    ).toBe(`track:="t1"\nartist:="a1"`);
  });

  it("loads a record's values and its related-record counts in one query", () => {
    const fields = buildFormFields(TABLES, "track");
    expect(
      recordDataQuery("track", fields, [{ column: "id", value: "t1" }]),
    ).toEqual({
      base: "track",
      filter: `id:="t1"`,
      sort: "",
      display: "$id $title $album $track_number $#credit $#play",
    });
  });

  it("lists a multi-record field's records by key, in key order", () => {
    const field = buildFormFields(TABLES, "track").find(
      (f) => f.key === "#credit",
    ) as MultiRecordField;
    expect(childRecordsQuery(field, "t1")).toEqual({
      base: "credit",
      filter: `track:="t1"`,
      sort: "\\\\track \\\\artist",
      display: "$track $artist",
    });
  });
});
