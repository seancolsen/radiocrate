import { describe, expect, it } from "vitest";
import {
  contextDefinitions,
  contextFields,
  contextKeyColumn,
  contextRowsQuery,
  contextTabDefinition,
  isRunnable,
  listableTables,
  sectionText,
  seedDefinition,
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
    expect(seedDefinition(TABLES, "artist")).toEqual({
      ...emptyDefinition(),
      base: "artist",
      sort: { custom: "\\\\name \\\\id" },
      display: { custom: "$name" },
    });
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
