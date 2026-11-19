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
): ComputedColumnRow => ({ tableName, name, expression });

const TABLES = [table("album", "id", "title"), table("track", "id", "title")];

describe("the app's own computed columns", () => {
  it("are the ones the app defines for tracks", () => {
    expect(BUILT_IN_COMPUTED_COLUMNS["track"]?.map((c) => c.name)).toEqual([
      "firstplay",
      "lastplay",
      "artists",
      "year",
      "added",
      "duration",
      "playcount",
    ]);
    expect(builtInExpression("track", "lastplay")).toBe("#play.timestamp%max");
    // Two backslashes ahead of each sort key, as Querydown writes them.
    expect(builtInExpression("track", "artists")).toBe(
      "#credit.artist.name%list_all(\\\\order \\\\artist.name)",
    );
  });

  it("are no other table's, nor the object prototype's", () => {
    expect(builtInExpression("album", "lastplay")).toBeNull();
    expect(builtInExpression("constructor", "name")).toBeNull();
    expect(builtInExpression("track", "nope")).toBeNull();
  });
});

describe("tableComputedColumns", () => {
  it("lists the app's as the app has them, then the user's by name", () => {
    const columns = tableComputedColumns("track", [
      row("track", "zeta", "title"),
      row("track", "alpha", "id"),
      row("album", "other", "title"),
    ]);
    expect(columns.map((c) => c.name)).toEqual([
      ...BUILT_IN_COMPUTED_COLUMNS["track"].map((c) => c.name),
      "alpha",
      "zeta",
    ]);
    expect(columns[0]).toEqual({
      table: "track",
      name: "firstplay",
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
      computedColumn("album", [row("album", "decade", "")], "decade"),
    ).toEqual({
      table: "album",
      name: "decade",
      expression: "",
      builtIn: false,
      customized: false,
    });
  });

  it("has none for a table with nothing defined", () => {
    expect(tableComputedColumns("album", [])).toEqual([]);
  });

  it("says which have an expression, and whose", () => {
    const rows = [
      row("track", "year", "1999"),
      row("track", "added", " "),
      row("album", "decade", ""),
      row("album", "era", "x"),
    ];
    const state = (table: string, name: string) => [
      isComputedDefined(rows, table, name),
      isComputedCustomized(rows, table, name),
    ];
    expect(state("track", "year")).toEqual([true, true]);
    expect(state("track", "added")).toEqual([true, false]);
    expect(state("track", "lastplay")).toEqual([true, false]);
    expect(state("album", "decade")).toEqual([false, false]);
    expect(state("album", "era")).toEqual([true, true]);
    expect(state("album", "nope")).toEqual([false, false]);
  });
});

describe("computedFields", () => {
  it("makes a field of each, keyed apart from every other kind", () => {
    const fields = computedFields(TABLES, "album", [
      row("album", "decade", "year"),
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
    expect(computedFields([table("album")], "track", [])).toEqual([]);
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
    expect(taken.has("lastplay")).toBe(true);
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
    const rows = [row("album", "decade", "x")];
    expect(takenComputedNames(TABLES, rows, "album").has("decade")).toBe(true);
    expect(
      takenComputedNames(TABLES, rows, "album", "decade").has("decade"),
    ).toBe(false);
  });
});

describe("computedPrelude", () => {
  it("defines each column with an expression, for the tables the database has", () => {
    const prelude = computedPrelude(
      [table("album", "id"), table("role", "id")],
      [
        row("album", "decade", "year / 10"),
        row("album", "unwritten", ""),
        row("gone", "left_behind", "id"),
        row("role", "upper", "name|upper"),
      ],
    );
    expect(prelude.text).toBe(
      ["#album.decade = year / 10", "#role.upper = name|upper"].join("\n"),
    );
  });

  it("defines the app's own, with the user's expression where they wrote one", () => {
    const prelude = computedPrelude(
      [table("track", "id")],
      [row("track", "year", "album.year + 1"), row("track", "mine", "id")],
    );
    expect(prelude.text.split("\n")).toEqual([
      "#track.firstplay = #play.timestamp%min",
      "#track.lastplay = #play.timestamp%max",
      "#track.artists = #credit.artist.name%list_all(\\\\order \\\\artist.name)",
      "#track.year = album.year + 1",
      "#track.added = file.added",
      "#track.duration = file.duration",
      "#track.playcount = #play",
      "#track.mine = id",
    ]);
  });

  it("traces each expression to its column", () => {
    const prelude = computedPrelude(
      [table("album", "id")],
      [row("album", "decade", "year / 10")],
    );
    expect(locate(prelude, prelude.text.indexOf("/"))).toMatchObject({
      offset: 5,
      segment: {
        origin: { kind: "computedColumn", table: "album", name: "decade" },
        source: "year / 10",
      },
    });
  });

  it("leaves out the column asked to", () => {
    expect(
      computedPrelude(
        [table("album", "id")],
        [row("album", "a", "id"), row("album", "b", "id")],
        { table: "album", name: "a" },
      ).text,
    ).toBe("#album.b = id");
  });
});

describe("withComputedExpression", () => {
  it("sets the expression of the row there is", () => {
    const rows = [row("album", "a", "id"), row("track", "a", "id")];
    expect(withComputedExpression(rows, "track", "a", "title")).toEqual([
      row("album", "a", "id"),
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
