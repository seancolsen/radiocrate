import { describe, expect, it } from "vitest";
import type { ContextualQuery } from "./contextualQuery";
import { emptyDefinition } from "./definition";
import { fieldRefKey } from "./fieldMetadata";
import { queryEditorSections } from "./fieldQuery";
import type { SchemaTable } from "./schema";
import {
  columnStatsLabel,
  countLabel,
  isFieldExpandable,
  presetSectionPath,
  structureFieldKind,
  structureFields,
} from "./structure";

const column = (name: string, type = "VARCHAR", nullable = true) => ({
  name,
  type,
  nullable,
});

const TABLES: SchemaTable[] = [
  {
    name: "album",
    columns: [column("id", "UUID", false), column("title")],
    uniqueConstraints: [["id"]],
  },
  {
    name: "track",
    columns: [
      column("id", "UUID", false),
      column("title"),
      column("album", "UUID"),
    ],
    uniqueConstraints: [["id"]],
  },
  {
    // Kept in an order of the user's own.
    name: "credit",
    columns: [
      column("id", "UUID", false),
      column("track", "UUID", false),
      column("order", "FLOAT"),
    ],
    uniqueConstraints: [["id"]],
  },
  {
    // No way to tell its records apart.
    name: "play",
    columns: [column("track", "UUID", false), column("timestamp", "TIMESTAMP")],
    uniqueConstraints: [],
  },
];

const QUERY: ContextualQuery = {
  id: "q1",
  tableName: "track",
  name: "same album",
  definition: { ...emptyDefinition(), base: "track" },
};

describe("structureFields", () => {
  it("lists columns, referring tables and contextual queries", () => {
    const fields = structureFields(TABLES, "track", [QUERY], {});
    expect(fields.map((f) => [f.label, structureFieldKind(f)])).toEqual([
      ["id", "column"],
      ["title", "column"],
      ["album", "column"],
      ["credits", "related"],
      ["plays", "related"],
      ["same album", "query"],
    ]);
  });

  it("keeps hidden fields, in the order the user arranged", () => {
    const fields = structureFields(TABLES, "track", [QUERY], {
      [fieldRefKey({ columnName: "title" })]: {
        visible: false,
        order: 2,
        display: null,
        sorting: null,
      },
      [fieldRefKey({ contextualQuery: "q1" })]: {
        visible: true,
        order: 1,
        display: null,
        sorting: null,
      },
    });
    expect(fields.map((f) => f.label).slice(0, 3)).toEqual([
      "same album",
      "title",
      "id",
    ]);
  });

  it("lists nothing for a table the schema doesn't have", () => {
    expect(structureFields(TABLES, "nope", [], {})).toEqual([]);
  });
});

describe("what a field opens into", () => {
  const fields = structureFields(TABLES, "track", [QUERY], {});
  const named = (label: string) => fields.find((f) => f.label === label)!;

  it("is nothing for a column, linked or not", () => {
    expect(isFieldExpandable(named("title"))).toBe(false);
    expect(isFieldExpandable(named("album"))).toBe(false);
  });

  it("is the whole query for a contextual query", () => {
    expect(isFieldExpandable(named("same album"))).toBe(true);
    expect(queryEditorSections(named("same album"))).toEqual([
      "filter",
      "sort",
      "display",
    ]);
  });

  it("leaves out the sorting of records kept in their own order", () => {
    expect(queryEditorSections(named("credits"))).toEqual(["display"]);
  });

  it("is nothing for records that are only counted", () => {
    expect(queryEditorSections(named("plays"))).toEqual([]);
    expect(isFieldExpandable(named("plays"))).toBe(false);
  });

  it("is sorting and display for any other related records", () => {
    const tracks = structureFields(TABLES, "album", [], {}).find(
      (f) => f.label === "tracks",
    )!;
    expect(queryEditorSections(tracks)).toEqual(["sort", "display"]);
  });
});

describe("presetSectionPath", () => {
  it("opens every item down to the section", () => {
    expect(presetSectionPath("track", "sort")).toEqual([
      "tables",
      "table:track",
      "table:track/query",
      "table:track/query/sort",
    ]);
    expect(presetSectionPath("track")).toHaveLength(3);
  });
});

describe("countLabel", () => {
  it("counts, singular or plural, with thousands separated", () => {
    expect(countLabel(12509, "row", "rows")).toBe("12,509 rows");
    expect(countLabel(1, "column", "columns")).toBe("1 column");
    expect(countLabel(0, "row", "rows")).toBe("0 rows");
  });
});

describe("columnStatsLabel", () => {
  const stats = (approxUnique: number, nullPercentage: number | null) => ({
    name: "c",
    approxUnique,
    nullPercentage,
  });

  it("reads as distinct values and the share of NULLs", () => {
    expect(columnStatsLabel(stats(45, 20), 100)).toBe("45 distinct, 20% NULL");
    expect(columnStatsLabel(stats(12034, 33.33), 20000)).toBe(
      "12,034 distinct, 33% NULL",
    );
  });

  it("holds an overshooting estimate to the rows there are", () => {
    expect(columnStatsLabel(stats(1012, 0), 1000)).toBe(
      "1,000 distinct, 0% NULL",
    );
  });

  it("doesn't round a few NULLs, or a few values, away", () => {
    expect(columnStatsLabel(stats(9, 0.04), 10000)).toBe(
      "9 distinct, 0.04% NULL",
    );
    expect(columnStatsLabel(stats(3, 99.97), 10000)).toBe(
      "3 distinct, 99.97% NULL",
    );
    expect(columnStatsLabel(stats(0, 100), 10)).toBe("0 distinct, 100% NULL");
  });

  it("reports no share of NULLs for a table with no rows", () => {
    expect(columnStatsLabel(stats(0, null), 0)).toBe("0 distinct");
  });
});
