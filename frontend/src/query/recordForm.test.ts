import { describe, expect, it } from "vitest";
import {
  buildFormFields,
  keyConditions,
  keySignature,
  quoteValue,
  recordDataQuery,
  valueTypeOf,
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
      readOnly: false,
    });
  });

  it("marks a primitive field read-only when it's the table's primary key", () => {
    const fields = buildFormFields(TABLES, "track");
    expect(fields.find((f) => f.key === "id")).toMatchObject({
      column: "id",
      readOnly: true,
    });
    // A composite-keyed table (`credit`, keyed on `(track, artist)`) has no
    // single primary key, so nothing in it is read-only on that account.
    expect(
      buildFormFields(TABLES, "credit").find((f) => f.key === "role"),
    ).toMatchObject({ readOnly: false });
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
        [
          { column: "track", value: "t1" },
          { column: "artist", value: "a1" },
        ],
      ]),
    ).toBe(`track:="t1"\nartist:="a1"`);
  });

  it("matches several records as alternatives, each key a group of its own", () => {
    expect(
      keyConditions([
        [{ column: "id", value: "t1" }],
        [{ column: "id", value: "t2" }],
      ]),
    ).toBe(`[\n  {\n    id:="t1"\n  }\n  {\n    id:="t2"\n  }\n]`);
    // A composite key stays one alternative: its columns are AND-ed inside the
    // group, and the groups are OR-ed.
    expect(
      keyConditions([
        [
          { column: "track", value: "t1" },
          { column: "artist", value: "a1" },
        ],
        [
          { column: "track", value: "t2" },
          { column: "artist", value: "a2" },
        ],
      ]),
    ).toBe(
      `[\n  {\n    track:="t1"\n    artist:="a1"\n  }\n` +
        `  {\n    track:="t2"\n    artist:="a2"\n  }\n]`,
    );
  });

  it("loads a record's values and its related-record counts in one query", () => {
    const fields = buildFormFields(TABLES, "track");
    expect(
      recordDataQuery("track", fields, [[{ column: "id", value: "t1" }]]),
    ).toEqual({
      base: "track",
      filter: `id:="t1"`,
      sort: "",
      // The key column leads, so a row can be matched back to its record; that
      // it's a field too just displays it twice.
      display: "$id $id $title $album $track_number $#credit $#play",
    });
  });

  it("loads every record the form is on in one query", () => {
    const fields = buildFormFields(TABLES, "credit", ["track"]);
    const query = recordDataQuery("credit", fields, [
      [
        { column: "track", value: "t1" },
        { column: "artist", value: "a1" },
      ],
      [
        { column: "track", value: "t2" },
        { column: "artist", value: "a2" },
      ],
    ]);
    expect(query.display).toBe("$track $artist $artist $ord $role");
    expect(query.filter).toContain(`track:="t2"`);
  });

  it("signs a key the same way whichever side of the query it comes from", () => {
    expect(keySignature(["t1", "a1"])).toBe(keySignature(["t1", "a1"]));
    expect(keySignature(["t1", "a1"])).not.toBe(keySignature(["t1", "a2"]));
    // A NULL cell is not the empty string, and a key isn't run together.
    expect(keySignature([null])).not.toBe(keySignature([""]));
    expect(keySignature(["a", "b"])).not.toBe(keySignature(["ab"]));
  });
});
