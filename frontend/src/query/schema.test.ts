import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addInferredLinks,
  identifyingColumns,
  INTROSPECTION_SQL,
  parseOtherSchemaTables,
  parseSchemaTables,
  primaryKey,
  qualifiedTableName,
  querydownTableName,
  readSchemaTables,
  rowTable,
  splitTableName,
  tableLabel,
  tableRef,
  type SchemaTable,
} from "./schema";

// Mirrors the Rust tests for `add_inferred_links` (`introspection/src/lib.rs`),
// guarding this TS port against drift from the shared crate that also backs
// the backend's DML validator. `SAMPLE` is the same fixture.
const SAMPLE = `{
  "tables": [
    { "name": "track", "unique_constraints": [["id"]], "columns": [
      { "name": "id", "type": "UUID", "nullable": false },
      { "name": "title", "type": "VARCHAR", "nullable": true },
      { "name": "album", "type": "UUID", "nullable": true }
    ] },
    { "name": "album", "unique_constraints": [["id"]], "columns": [
      { "name": "id", "type": "UUID", "nullable": false }
    ] },
    { "name": "credit", "unique_constraints": [["track", "artist"]], "columns": [
      { "name": "track", "type": "UUID", "nullable": false },
      { "name": "artist", "type": "UUID", "nullable": false },
      { "name": "ord", "type": "FLOAT", "nullable": true }
    ] }
  ],
  "links": []
}`;

interface Link {
  from: { table: string; schema?: string[]; column: string };
  to: { table: string; schema?: string[]; column: string };
  unique: boolean;
}

describe("INTROSPECTION_SQL", () => {
  it("is the shared crate's query, without its comments", () => {
    const shared = readFileSync(
      new URL("../../../introspection/resources/duckdb.sql", import.meta.url),
      "utf8",
    );
    const uncommented = shared
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .trim();
    expect(INTROSPECTION_SQL).toBe(uncommented);
  });
});

// The same fixture as the Rust `SCHEMAS`: the app's `track` and `album`, a
// `metadata` table named like one of them, and a table of another schema that
// refers to the app's `track` and to its own schema's `album`.
const SCHEMAS = `{
  "tables": [
    { "name": "track", "unique_constraints": [["id"]], "columns": [
      { "name": "id", "type": "UUID", "nullable": false },
      { "name": "album", "type": "UUID", "nullable": true }
    ] },
    { "name": "album", "unique_constraints": [["id"]], "columns": [
      { "name": "id", "type": "UUID", "nullable": false }
    ] },
    { "name": "track", "schema": ["metadata"], "columns": [
      { "name": "note", "type": "VARCHAR", "nullable": true }
    ] },
    { "name": "album", "schema": ["lastfm"], "columns": [
      { "name": "id", "type": "UUID", "nullable": false }
    ] },
    { "name": "scrobble", "schema": ["lastfm"], "columns": [
      { "name": "track", "type": "UUID", "nullable": false },
      { "name": "album", "type": "UUID", "nullable": true }
    ] }
  ],
  "links": []
}`;

describe("schemas", () => {
  it("links a column to its own schema's table, then the current schema's", () => {
    expect(linksOf(addInferredLinks(SCHEMAS))).toEqual([
      {
        from: { table: "track", column: "album" },
        to: { table: "album", column: "id" },
        unique: false,
      },
      {
        from: { table: "scrobble", schema: ["lastfm"], column: "track" },
        to: { table: "track", column: "id" },
        unique: false,
      },
      {
        from: { table: "scrobble", schema: ["lastfm"], column: "album" },
        to: { table: "album", schema: ["lastfm"], column: "id" },
        unique: false,
      },
    ]);
  });

  it("keeps every schema's tables in the compiler's JSON", () => {
    const out = JSON.parse(addInferredLinks(SCHEMAS)) as {
      tables: { name: string; schema?: string[] }[];
    };
    expect(out.tables.map((t) => [t.schema ?? [], t.name])).toEqual([
      [[], "track"],
      [[], "album"],
      [["metadata"], "track"],
      [["lastfm"], "album"],
      [["lastfm"], "scrobble"],
    ]);
  });

  it("parses only the current schema's tables for the app", () => {
    const tables = parseSchemaTables(SCHEMAS);
    expect(tables.map((t) => t.name)).toEqual(["track", "album"]);
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(["id", "album"]);
  });
});
const linksOf = (json: string): Link[] =>
  (JSON.parse(json) as { links: Link[] }).links;

describe("addInferredLinks", () => {
  it("infers a link from a UUID column matching a table name", () => {
    const links = linksOf(addInferredLinks(SAMPLE));
    // track.album -> album.id, credit.track -> track.id
    // (credit.artist has no `artist` table here).
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({
      from: { table: "track", column: "album" },
      to: { table: "album", column: "id" },
      unique: false,
    });
    expect(
      links.some(
        (l) =>
          l.from.table === "credit" &&
          l.from.column === "track" &&
          l.to.table === "track",
      ),
    ).toBe(true);
  });

  it("ignores non-UUID and non-matching columns", () => {
    const input = `{ "tables": [
      { "name": "track", "columns": [
        { "name": "id", "type": "UUID" },
        { "name": "title", "type": "VARCHAR" },
        { "name": "track", "type": "VARCHAR" }
      ] }
    ], "links": [] }`;
    expect(linksOf(addInferredLinks(input))).toHaveLength(0);
  });

  it("matches UUID case-insensitively", () => {
    const input = `{ "tables": [
      { "name": "album", "columns": [{ "name": "id", "type": "uuid" }] },
      { "name": "track", "columns": [{ "name": "album", "type": "uuid" }] }
    ], "links": [] }`;
    const links = linksOf(addInferredLinks(input));
    expect(links).toHaveLength(1);
    expect(links[0].from).toEqual({ table: "track", column: "album" });
  });

  it("preserves other fields and overwrites links", () => {
    const input = `{ "tables": [], "links": [{ "stale": true }], "extra": 1 }`;
    const out = JSON.parse(addInferredLinks(input)) as {
      links: unknown[];
      extra: number;
    };
    expect(out.links).toHaveLength(0);
    expect(out.extra).toBe(1);
  });

  it("throws on JSON without tables", () => {
    expect(() => addInferredLinks(`{ "nope": 1 }`)).toThrow();
  });
});

describe("parseSchemaTables", () => {
  it("reads columns and unique constraints", () => {
    const tables = parseSchemaTables(SAMPLE);
    expect(tables.map((t) => t.name)).toEqual(["track", "album", "credit"]);
    const track = tables[0];
    expect(track.uniqueConstraints).toEqual([["id"]]);
    expect(track.columns[0]).toEqual({
      name: "id",
      type: "UUID",
      nullable: false,
    });
  });

  it("degrades to no tables on a malformed document", () => {
    expect(parseSchemaTables(`{ "nope": 1 }`)).toEqual([]);
    expect(parseSchemaTables("not json")).toEqual([]);
  });
});

describe("primaryKey / identifyingColumns", () => {
  const table = (name: string): SchemaTable =>
    parseSchemaTables(SAMPLE).find((t) => t.name === name)!;

  it("takes a single-column key", () => {
    expect(primaryKey(table("track"))).toBe("id");
    expect(identifyingColumns(table("track"))).toEqual(["id"]);
  });

  it("has no single key for a composite-keyed table", () => {
    expect(primaryKey(table("credit"))).toBeUndefined();
    // …but the composite still identifies a record.
    expect(identifyingColumns(table("credit"))).toEqual(["track", "artist"]);
  });

  it("prefers `id` over another single-column unique constraint", () => {
    const t: SchemaTable = {
      name: "track",
      columns: [
        { name: "slug", type: "VARCHAR", nullable: false },
        { name: "id", type: "UUID", nullable: false },
      ],
      uniqueConstraints: [["slug"], ["id"]],
    };
    expect(primaryKey(t)).toBe("id");
  });

  it("ignores a nullable unique column", () => {
    const t: SchemaTable = {
      name: "track",
      columns: [{ name: "isrc", type: "VARCHAR", nullable: true }],
      uniqueConstraints: [["isrc"]],
    };
    expect(primaryKey(t)).toBeUndefined();
    expect(identifyingColumns(t)).toEqual(["isrc"]);
  });

  it("identifies nothing in a table with no unique constraint", () => {
    const t: SchemaTable = {
      name: "log",
      columns: [{ name: "message", type: "VARCHAR", nullable: true }],
      uniqueConstraints: [],
    };
    expect(identifyingColumns(t)).toEqual([]);
  });
});

describe("naming a table across schemas", () => {
  it("names the current schema's tables alone, and the others' by schema", () => {
    expect(qualifiedTableName("main", "track")).toBe("track");
    expect(qualifiedTableName("lastfm", "scrobble")).toBe("/lastfm/scrobble");
    expect(splitTableName("track")).toEqual({ schema: "main", table: "track" });
    expect(splitTableName("/lastfm/scrobble")).toEqual({
      schema: "lastfm",
      table: "scrobble",
    });
    expect(tableLabel("/lastfm/scrobble")).toBe("scrobble");
    expect(tableLabel("track")).toBe("track");
  });

  it("hands the compiler a path for another schema's table", () => {
    expect(querydownTableName("track")).toBe("track");
    expect(querydownTableName("/metadata/field")).toEqual([
      "metadata",
      "field",
    ]);
  });

  it("goes over the wire as a schema and a name, and back", () => {
    expect(tableRef("/lastfm/artist")).toEqual({
      tableSchema: "lastfm",
      tableName: "artist",
    });
    expect(tableRef("artist")).toEqual({
      tableSchema: "main",
      tableName: "artist",
    });
    expect(rowTable(tableRef("/lastfm/artist"))).toBe("/lastfm/artist");
    expect(rowTable(tableRef("artist"))).toBe("artist");
  });
});

describe("parseOtherSchemaTables", () => {
  const json = JSON.stringify({
    tables: [
      { name: "artist", columns: [{ name: "id", type: "UUID" }] },
      {
        name: "artist",
        schema: ["lastfm"],
        columns: [{ name: "mbid", type: "VARCHAR", nullable: false }],
        unique_constraints: [["mbid"]],
      },
      { name: "field", schema: ["metadata"], columns: [] },
      // Another attached database's is left to the compiler.
      { name: "t", schema: ["other_db", "main"], columns: [] },
    ],
    links: [],
  });

  it("lists the other schemas' tables, named by schema, and none of the app's", () => {
    expect(parseOtherSchemaTables(json)).toEqual([
      {
        name: "/lastfm/artist",
        columns: [{ name: "mbid", type: "VARCHAR", nullable: false }],
        uniqueConstraints: [["mbid"]],
      },
      { name: "/metadata/field", columns: [], uniqueConstraints: [] },
    ]);
    expect(parseSchemaTables(json).map((t) => t.name)).toEqual(["artist"]);
  });

  it("lists every table together, the app's first", () => {
    const { tables, otherTables, allTables } = readSchemaTables(json);
    expect(allTables).toEqual([...tables, ...otherTables]);
    expect(allTables.map((t) => t.name)).toEqual([
      "artist",
      "/lastfm/artist",
      "/metadata/field",
    ]);
  });
});
