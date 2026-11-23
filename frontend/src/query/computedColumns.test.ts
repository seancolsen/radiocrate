import { describe, expect, it } from "vitest";
import type { ComputedColumnRow } from "api-client";
import {
  availableComputedName,
  BUILT_IN_COMPUTED_COLUMNS,
  builtInExpression,
  computedColumn,
  computedDisplay,
  computedFieldKey,
  computedFields,
  computedPrelude,
  isComputedCustomized,
  isComputedDefined,
  legalComputedName,
  tableComputedColumns,
  takenComputedNames,
  withComputedExpression,
} from "./computedColumns";
import type { SchemaTable } from "./schema";
import { locate } from "./sourceMap";

const table = (name: string, ...columns: string[]): SchemaTable => ({
  name,
  columns: columns.map((column) => ({
    name: column,
    type: "VARCHAR",
    nullable: true,
  })),
  uniqueConstraints: [],
});

const row = (
  tableName: string,
  name: string,
  expression: string | null,
): ComputedColumnRow => ({ schemaName: "main", tableName, name, expression });

const TABLES = [table("role", "id", "title"), table("track", "id", "title")];

describe("the app's own computed columns", () => {
  it("are the ones the app defines for tracks, artists and albums", () => {
    expect(BUILT_IN_COMPUTED_COLUMNS["track"]?.map((c) => c.name)).toEqual([
      "first_play",
      "last_play",
      "artists",
      "year",
      "added",
      "duration",
      "play_count",
      "tags",
    ]);
    expect(BUILT_IN_COMPUTED_COLUMNS["artist"]?.map((c) => c.name)).toEqual([
      "added",
      "first_play",
      "last_play",
      "play_count",
      "album_count",
      "track_count",
    ]);
    expect(BUILT_IN_COMPUTED_COLUMNS["album"]?.map((c) => c.name)).toEqual([
      "main_artists",
      "added",
      "first_play",
      "last_play",
      "play_count",
      "track_count",
    ]);
    expect(builtInExpression("track", "last_play")).toBe("#play.timestamp%max");
    // Two backslashes ahead of each sort key, as Querydown writes them.
    expect(builtInExpression("track", "artists")).toBe(
      "#credit.artist.name%list_all(\\\\order \\\\artist.name)",
    );
    // A single backslash ahead of a flag.
    expect(builtInExpression("track", "tags")).toBe("#tag.name%list(\\s)");
    expect(builtInExpression("album", "main_artists")).toBe(
      "#credit.artist.name%top(\\\\%count \\d)",
    );
  });

  it("are no other table's, nor the object prototype's", () => {
    expect(builtInExpression("role", "last_play")).toBeNull();
    expect(builtInExpression("constructor", "name")).toBeNull();
    expect(builtInExpression("track", "nope")).toBeNull();
  });
});

describe("tableComputedColumns", () => {
  it("lists the app's as the app has them, then the user's by name", () => {
    const columns = tableComputedColumns("track", [
      row("track", "zeta", "title"),
      row("track", "alpha", "id"),
      row("role", "other", "title"),
    ]);
    expect(columns.map((c) => c.name)).toEqual([
      ...BUILT_IN_COMPUTED_COLUMNS["track"].map((c) => c.name),
      "alpha",
      "zeta",
    ]);
    expect(columns[0]).toEqual({
      table: "track",
      name: "first_play",
      expression: "#play.timestamp%min",
      builtIn: true,
      customized: false,
    });
    expect(columns[columns.length - 1]).toEqual({
      table: "track",
      name: "zeta",
      expression: "title",
      builtIn: false,
      customized: true,
    });
  });

  it("goes by the user's expression for one of the app's, until it's blank", () => {
    const year = (expression: string | null) =>
      computedColumn("track", [row("track", "year", expression)], "year");
    expect(year("album.year + 1")).toMatchObject({
      expression: "album.year + 1",
      builtIn: true,
      customized: true,
    });
    for (const blank of [null, "", "  \n"]) {
      expect(year(blank)).toMatchObject({
        expression: "album.year",
        customized: false,
      });
    }
  });

  it("leaves a column of the user's with no expression undefined", () => {
    expect(
      computedColumn("role", [row("role", "decade", "")], "decade"),
    ).toEqual({
      table: "role",
      name: "decade",
      expression: "",
      builtIn: false,
      customized: false,
    });
  });

  it("has none for a table with nothing defined", () => {
    expect(tableComputedColumns("role", [])).toEqual([]);
  });

  it("says which have an expression, and whose", () => {
    const rows = [
      row("track", "year", "1999"),
      row("track", "added", " "),
      row("role", "decade", ""),
      row("role", "era", "x"),
    ];
    const state = (table: string, name: string) => [
      isComputedDefined(rows, table, name),
      isComputedCustomized(rows, table, name),
    ];
    expect(state("track", "year")).toEqual([true, true]);
    expect(state("track", "added")).toEqual([true, false]);
    expect(state("track", "last_play")).toEqual([true, false]);
    expect(state("role", "decade")).toEqual([false, false]);
    expect(state("role", "era")).toEqual([true, true]);
    expect(state("role", "nope")).toEqual([false, false]);
  });
});

describe("computedFields", () => {
  it("makes a field of each, keyed apart from every other kind", () => {
    const fields = computedFields(TABLES, "role", [
      row("role", "decade", "year"),
    ]);
    expect(fields).toEqual([
      {
        kind: "computed",
        key: "=decade",
        label: "decade",
        name: "decade",
        builtIn: false,
      },
    ]);
    expect(computedFieldKey("decade")).toBe("=decade");
  });

  it("marks the app's own", () => {
    const fields = computedFields(TABLES, "track", []);
    expect(fields.every((field) => field.builtIn)).toBe(true);
    expect(fields).toHaveLength(BUILT_IN_COMPUTED_COLUMNS["track"].length);
  });

  it("has none for a table the schema hasn't got", () => {
    expect(computedFields([table("role")], "track", [])).toEqual([]);
  });
});

describe("a computed column's name", () => {
  it("is made into an identifier", () => {
    expect(legalComputedName("  last play ")).toBe("last_play");
    expect(legalComputedName("plays (30d)!")).toBe("plays_30d");
    expect(legalComputedName("_private")).toBe("_private");
    expect(legalComputedName("2nd")).toBe("_2nd");
    expect(legalComputedName("Année")).toBe("Ann_e");
  });

  it("falls back to the default when nothing is left of it", () => {
    expect(legalComputedName("")).toBe("computed");
    expect(legalComputedName(" ?! ")).toBe("computed");
  });

  it("can't be a column's, nor another computed column's", () => {
    const taken = takenComputedNames(
      TABLES,
      [row("track", "Decade", "x")],
      "track",
    );
    expect(taken.has("title")).toBe(true);
    expect(taken.has("decade")).toBe(true);
    expect(taken.has("last_play")).toBe(true);
    expect(availableComputedName("title", taken)).toBe("title_2");
    expect(availableComputedName("DECADE", taken)).toBe("DECADE_2");
    expect(availableComputedName("fresh", taken)).toBe("fresh");
  });

  it("is numbered past the names already numbered", () => {
    expect(availableComputedName("a", new Set(["a", "a_2", "a_3"]))).toBe(
      "a_4",
    );
  });

  it("leaves the column being renamed out of what's taken", () => {
    const rows = [row("role", "decade", "x")];
    expect(takenComputedNames(TABLES, rows, "role").has("decade")).toBe(true);
    expect(
      takenComputedNames(TABLES, rows, "role", "decade").has("decade"),
    ).toBe(false);
  });
});

describe("computedPrelude", () => {
  it("defines each column with an expression, for the tables the database has", () => {
    const prelude = computedPrelude(
      [table("rating", "id"), table("role", "id")],
      [
        row("rating", "decade", "year / 10"),
        row("rating", "unwritten", ""),
        row("gone", "left_behind", "id"),
        row("role", "upper", "name|upper"),
      ],
    );
    expect(prelude.text).toBe(
      ["#rating.decade = year / 10", "#role.upper = name|upper"].join("\n"),
    );
  });

  it("defines the app's own, with the user's expression where they wrote one", () => {
    const prelude = computedPrelude(
      [table("track", "id")],
      [row("track", "year", "album.year + 1"), row("track", "mine", "id")],
    );
    expect(prelude.text.split("\n")).toEqual([
      "#track.first_play = #play.timestamp%min",
      "#track.last_play = #play.timestamp%max",
      "#track.artists = #credit.artist.name%list_all(\\\\order \\\\artist.name)",
      "#track.year = album.year + 1",
      "#track.added = file.added",
      "#track.duration = file.duration",
      "#track.play_count = #play",
      "#track.tags = #tag.name%list(\\s)",
      "#track.mine = id",
    ]);
  });

  it("traces each expression to its column", () => {
    const prelude = computedPrelude(
      [table("role", "id")],
      [row("role", "decade", "year / 10")],
    );
    expect(locate(prelude, prelude.text.indexOf("/"))).toMatchObject({
      offset: 5,
      segment: {
        origin: { kind: "computedColumn", table: "role", name: "decade" },
        source: "year / 10",
      },
    });
  });

  it("leaves out the column asked to", () => {
    expect(
      computedPrelude(
        [table("role", "id")],
        [row("role", "a", "id"), row("role", "b", "id")],
        { table: "role", name: "a" },
      ).text,
    ).toBe("#role.b = id");
  });
});

describe("withComputedExpression", () => {
  it("sets the expression of the row there is", () => {
    const rows = [row("role", "a", "id"), row("track", "a", "id")];
    expect(withComputedExpression(rows, "track", "a", "title")).toEqual([
      row("role", "a", "id"),
      row("track", "a", "title"),
    ]);
    // A new array: what a selector held isn't written to.
    expect(rows[1]?.expression).toBe("id");
  });

  it("makes the row of one of the app's columns customized for the first time", () => {
    expect(withComputedExpression([], "track", "year", "1999")).toEqual([
      row("track", "year", "1999"),
    ]);
  });
});

describe("computedDisplay", () => {
  it("displays the records' keys, then the columns", () => {
    expect(computedDisplay(["track", "artist"], ["a", "b"])).toBe(
      "$track $artist $a $b",
    );
  });
});
