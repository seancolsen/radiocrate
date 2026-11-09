import { describe, expect, it } from "vitest";
import {
  contextDefinitions,
  contextFields,
  contextKeyColumn,
  contextRowsQuery,
  contextTabDefinition,
  isRunnable,
  linkPath,
  listableTables,
  sectionText,
  seedDefinition,
  seedFilter,
  withSectionText,
  type ContextualQuery,
} from "./contextualQuery";
import { emptyDefinition, type QueryDefinition } from "./definition";
import type { SchemaTable } from "./schema";

const col = (name: string, type: string, nullable = false) => ({
  name,
  type,
  nullable,
});
const TABLES: SchemaTable[] = [
  {
    name: "artist",
    columns: [col("id", "UUID"), col("name", "VARCHAR")],
    uniqueConstraints: [["id"]],
  },
  {
    name: "credit",
    columns: [
      col("id", "UUID"),
      col("track", "UUID"),
      col("artist", "UUID"),
      col("role", "VARCHAR", true),
    ],
    uniqueConstraints: [["id"]],
  },
  {
    name: "track",
    columns: [col("id", "UUID"), col("title", "VARCHAR")],
    uniqueConstraints: [["id"]],
  },
  // Keyed by a pair: its records can't be told apart by one value for `@id`.
  {
    name: "track_tag",
    columns: [col("track", "UUID"), col("tag", "VARCHAR")],
    uniqueConstraints: [["track", "tag"]],
  },
  // No key at all.
  { name: "log", columns: [col("line", "VARCHAR")], uniqueConstraints: [] },
];

const credits = (filter = "artist:=@id"): QueryDefinition => ({
  ...emptyDefinition(),
  base: "credit",
  filter: { custom: filter, presets: [] },
  sort: { custom: "\\\\role" },
  display: { custom: "$track.title $role" },
});

const query = (
  id: string,
  tableName: string,
  name: string,
  definition = credits(),
): ContextualQuery => ({ id, tableName, name, definition });

describe("contextFields", () => {
  it("lists a table's queries by name, each over the table it lists", () => {
    const queries = [
      query("q2", "artist", "credits"),
      query("q1", "artist", "Appearances"),
      query("q3", "track", "credits"),
    ];
    expect(contextFields(TABLES, "artist", queries)).toEqual([
      {
        kind: "contextQuery",
        key: "@q1",
        label: "Appearances",
        queryId: "q1",
        table: "credit",
        keyColumns: ["id"],
      },
      {
        kind: "contextQuery",
        key: "@q2",
        label: "credits",
        queryId: "q2",
        table: "credit",
        keyColumns: ["id"],
      },
    ]);
  });

  it("gives a table without a single-column key none", () => {
    const queries = [query("q", "track_tag", "x"), query("r", "log", "y")];
    expect(contextFields(TABLES, "track_tag", queries)).toEqual([]);
    expect(contextFields(TABLES, "log", queries)).toEqual([]);
    expect(contextKeyColumn(TABLES, "track_tag")).toBeUndefined();
    expect(contextKeyColumn(TABLES, "artist")).toBe("id");
  });

  it("offers only tables whose records can be told apart to list", () => {
    expect(listableTables(TABLES).map((t) => t.name)).toEqual([
      "artist",
      "credit",
      "track",
      "track_tag",
    ]);
  });
});

describe("contextDefinitions", () => {
  it("defines @id after the prelude, so it wins over one there", () => {
    expect(contextDefinitions("#track.year = album.year", "a1")).toBe(
      "#track.year = album.year\n@id = 'a1'",
    );
    expect(contextDefinitions("  ", "a1")).toBe("@id = 'a1'");
  });

  it("escapes quotes and backslashes in the value", () => {
    expect(contextDefinitions("", "it's a \\ value")).toBe(
      "@id = 'it\\'s a \\\\ value'",
    );
  });
});

describe("sections", () => {
  it("runs only with a filter, written or a preset", () => {
    expect(isRunnable(credits())).toBe(true);
    expect(isRunnable(credits("  \n"))).toBe(false);
    expect(
      isRunnable({ ...credits(""), filter: { custom: "", presets: ["p"] } }),
    ).toBe(true);
  });

  it("reads and writes one section's Querydown", () => {
    const def = credits();
    expect(sectionText(def, "filter")).toBe("artist:=@id");
    expect(sectionText(def, "display")).toBe("$track.title $role");
    expect(sectionText({ ...def, sort: { preset: "p" } }, "sort")).toBe("");

    const next = withSectionText(def, "sort", "\\\\track.title");
    expect(next.sort).toEqual({ custom: "\\\\track.title" });
    expect(next.filter).toBe(def.filter);
    expect(withSectionText(def, "filter", "role:x").filter).toEqual({
      custom: "role:x",
      presets: [],
    });
    // The definition it was given is left as it was.
    expect(def.sort).toEqual({ custom: "\\\\role" });
  });

  it("seeds a new query's sort and display as an embedded record's", () => {
    expect(seedDefinition(TABLES, "track", "artist")).toEqual({
      ...emptyDefinition(),
      base: "artist",
      filter: { custom: "++#credit{track.id:@id}", presets: [] },
      sort: { custom: "\\\\name \\\\id" },
      display: { custom: "$name" },
    });
  });
});

// The links of RadioCrate's own schema, give or take: a UUID column named after
// a table links to it. (`credit` is keyed by `id` here, so that it can have
// contextual queries.)
const uuid = (name: string) => col(name, "UUID", name !== "id");
const keyed = (name: string, ...columns: SchemaTable["columns"]) => ({
  name,
  columns: [col("id", "UUID"), ...columns],
  uniqueConstraints: [["id"]],
});
const LINKED: SchemaTable[] = [
  keyed("album", col("title", "VARCHAR")),
  keyed("artist", col("name", "VARCHAR")),
  keyed("credit", uuid("track"), uuid("artist")),
  keyed("file", col("path", "VARCHAR")),
  keyed("playlist", col("name", "VARCHAR")),
  keyed("playlist_track", uuid("playlist"), uuid("track")),
  keyed("preset", col("name", "VARCHAR")),
  keyed("track", uuid("file"), uuid("album"), col("title", "VARCHAR")),
  {
    name: "setting",
    columns: [col("key", "VARCHAR"), uuid("track")],
    uniqueConstraints: [["key"]],
  },
];

describe("linkPath", () => {
  it("walks links either way, by the shortest way there is", () => {
    expect(linkPath(LINKED, "album", "artist")).toEqual([
      { kind: "in", table: "track" },
      { kind: "in", table: "credit" },
      { kind: "out", column: "artist" },
    ]);
    expect(linkPath(LINKED, "credit", "album")).toEqual([
      { kind: "out", column: "track" },
      { kind: "out", column: "album" },
    ]);
    expect(linkPath(LINKED, "track", "track")).toEqual([]);
    expect(linkPath(LINKED, "track", "preset")).toBeUndefined();
  });

  it("tries a table's own links ahead of those to it", () => {
    // Both two links long: through the track's file, or through a credit.
    const tables = [...LINKED, keyed("label", uuid("file"), uuid("artist"))];
    expect(linkPath(tables, "track", "label")).toEqual([
      { kind: "out", column: "file" },
      { kind: "in", table: "label" },
    ]);
  });
});

describe("seedFilter", () => {
  it("follows a link out of the base", () => {
    expect(seedFilter(LINKED, "track", "credit")).toBe("track.id:@id");
    expect(seedFilter(LINKED, "album", "credit")).toBe("track.album.id:@id");
  });

  it("follows a link into the base", () => {
    expect(seedFilter(LINKED, "credit", "track")).toBe("++#credit{id:@id}");
  });

  it("nests the links it follows", () => {
    expect(seedFilter(LINKED, "artist", "album")).toBe(
      "++#track{++#credit{artist.id:@id}}",
    );
    expect(seedFilter(LINKED, "playlist", "credit")).toBe(
      "track{++#playlist_track{playlist.id:@id}}",
    );
    expect(seedFilter(LINKED, "playlist", "album")).toBe(
      "++#track{++#playlist_track{playlist.id:@id}}",
    );
  });

  it("matches a text key exactly", () => {
    expect(seedFilter(LINKED, "setting", "track")).toBe("++#setting{key:=@id}");
  });

  it("leaves the filter to the user when there's no guess to make", () => {
    // Nothing connects them.
    expect(seedFilter(LINKED, "track", "preset")).toBe("");
    // The only track connected to the track is itself.
    expect(seedFilter(LINKED, "track", "track")).toBe("");
    // No key for `@id` to hold.
    expect(seedFilter(TABLES, "track_tag", "track")).toBe("");
  });
});

describe("contextRowsQuery", () => {
  it("displays each record's key ahead of what the query displays", () => {
    expect(
      contextRowsQuery(credits(), [], ["id"], "@id = 'a1'", "$role"),
    ).toEqual({
      base: "credit",
      filter: "artist:=@id",
      sort: "\\\\role",
      display: "$id\n$track.title $role",
      definitions: "@id = 'a1'",
    });
  });

  it("shows what an embedded record would for a query displaying nothing", () => {
    const def = { ...credits(), display: { custom: "" } };
    expect(contextRowsQuery(def, [], ["id"], "", "$role").display).toBe(
      "$id\n$role",
    );
  });

  it("refuses a full Querydown query", () => {
    const def = { ...credits(), full: "#credit\nartist:=@id" };
    expect(() => contextRowsQuery(def, [], ["id"], "", "")).toThrow();
  });
});

describe("contextTabDefinition", () => {
  it("writes the query out whole, with @id defined ahead of it", () => {
    expect(contextTabDefinition(credits(), [], "a1")).toEqual({
      ...emptyDefinition(),
      base: "credit",
      full: "@id = 'a1'\n#credit\nartist:=@id\n\\\\role\n$track.title $role",
    });
  });
});
