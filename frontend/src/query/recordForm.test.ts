import { describe, expect, it } from "vitest";
import {
  buildFormFields,
  keyConditions,
  keySignature,
  linkConditions,
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
      label: "credits",
      table: "credit",
      column: "track",
      keyColumns: ["track", "artist"],
      ordered: false,
    });
  });

  it("marks the records of a table with an `order` column as ordered", () => {
    const tables: SchemaTable[] = [
      ...TABLES.filter((t) => t.name !== "credit"),
      {
        name: "credit",
        columns: [
          col("track", "UUID"),
          col("artist", "UUID"),
          col("order", "FLOAT", true),
        ],
        uniqueConstraints: [["track", "artist"]],
      },
    ];
    const ordered = (table: string, key: string) => {
      const field = buildFormFields(tables, table).find((f) => f.key === key);
      return field?.kind === "multiRecord" && field.ordered;
    };
    expect(ordered("track", "#credit")).toBe(true);
    expect(ordered("track", "#play")).toBe(false);
  });

  it("finds a join table: two columns, both required links", () => {
    const joinOf = (tables: SchemaTable[], table: string, key: string) => {
      const field = buildFormFields(tables, table).find((f) => f.key === key);
      return field?.kind === "multiRecord" ? field.join : undefined;
    };
    const tag = {
      name: "tag",
      columns: [col("id", "UUID"), col("name", "VARCHAR")],
      uniqueConstraints: [["id"]],
    };
    const withTags = (...extra: ReturnType<typeof col>[]): SchemaTable[] => [
      ...TABLES,
      tag,
      {
        name: "track_tag",
        columns: [col("track", "UUID"), col("tag", "UUID"), ...extra],
        uniqueConstraints: [["track", "tag"]],
      },
    ];
    // Seen from either side, the join is to the other one.
    expect(joinOf(withTags(), "track", "#track_tag")).toEqual({
      column: "tag",
      table: "tag",
      keyColumn: "id",
    });
    expect(joinOf(withTags(), "tag", "#track_tag")).toEqual({
      column: "track",
      table: "track",
      keyColumn: "id",
    });
    // `play`'s other column is a timestamp, not a link.
    expect(joinOf(TABLES, "track", "#play")).toBeUndefined();
    // Any third column makes it a table with something of its own to say:
    // `credit` has a `role`, optional though it is.
    expect(joinOf(TABLES, "track", "#credit")).toBeUndefined();
    expect(joinOf(TABLES, "artist", "#credit")).toBeUndefined();
    expect(
      joinOf(withTags(col("note", "VARCHAR", true)), "track", "#track_tag"),
    ).toBeUndefined();
    expect(
      joinOf(withTags(col("id", "UUID")), "track", "#track_tag"),
    ).toBeUndefined();
    // And a link that may be empty isn't one a record stands for.
    const optional: SchemaTable[] = [
      ...TABLES,
      tag,
      {
        name: "track_tag",
        columns: [col("track", "UUID"), col("tag", "UUID", true)],
        uniqueConstraints: [["track", "tag"]],
      },
    ];
    expect(joinOf(optional, "track", "#track_tag")).toBeUndefined();
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
      unique: false,
    });
  });

  it("marks a primitive field unique when one column's constraint says so", () => {
    const unique = (table: string, key: string) => {
      const field = buildFormFields(TABLES, table).find((f) => f.key === key);
      return field?.kind === "primitive" && field.unique;
    };
    expect(unique("artist", "name")).toBe(true);
    expect(unique("album", "title")).toBe(false);
    // Part of a key across several columns, it can repeat.
    expect(unique("credit", "ord")).toBe(false);
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

  it("matches the records pointing at any one of several parents", () => {
    // Bare conditions inside `[…]` are alternatives: one condition is a whole
    // alternative here, unlike the columns of a composite key.
    expect(linkConditions("track", ["t1"])).toBe(`track:="t1"`);
    expect(linkConditions("track", ["t1", "t2"])).toBe(
      `[\n  track:="t1"\n  track:="t2"\n]`,
    );
    expect(linkConditions("track", [])).toBe("");
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
