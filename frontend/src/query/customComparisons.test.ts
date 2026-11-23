import { describe, expect, it } from "vitest";
import type { CustomComparisonRow } from "api-client";
import {
  availableComparisonName,
  builtInComparison,
  comparisonPrelude,
  isComparisonCustomized,
  tableComparisons,
  takenComparisonNames,
  withComparisonExpression,
} from "./customComparisons";
import type { SchemaTable } from "./schema";
import { locate } from "./sourceMap";

const table = (name: string): SchemaTable => ({
  name,
  columns: [{ name: "id", type: "VARCHAR", nullable: false }],
  uniqueConstraints: [],
});

const row = (
  tableName: string,
  name: string,
  expression: string | null,
): CustomComparisonRow => ({
  tableSchema: "main",
  tableName,
  name,
  expression,
});

describe("the app's own custom comparisons", () => {
  it("compare tracks by artist", () => {
    expect(builtInComparison("track", "artist")).toBe("++#artist{name:@x}");
  });

  it("are no other table's, nor the object prototype's", () => {
    expect(builtInComparison("album", "artist")).toBeNull();
    expect(builtInComparison("constructor", "artist")).toBeNull();
  });
});

describe("tableComparisons", () => {
  it("lists the app's, with the user's condition where they wrote one, then the user's by name", () => {
    const rows = [
      row("track", "zeta", "title:@x"),
      row("track", "artist", "++#artist{name:=@x}"),
      row("track", "alpha", null),
      row("album", "beta", "title:@x"),
    ];
    expect(tableComparisons("track", rows)).toEqual([
      {
        table: "track",
        name: "artist",
        expression: "++#artist{name:=@x}",
        builtIn: true,
        customized: true,
      },
      {
        table: "track",
        name: "alpha",
        expression: "",
        builtIn: false,
        customized: false,
      },
      {
        table: "track",
        name: "zeta",
        expression: "title:@x",
        builtIn: false,
        customized: true,
      },
    ]);
  });

  it("goes by the app's condition where the user's is null or blank", () => {
    for (const expression of [null, "  "]) {
      const [artist] = tableComparisons("track", [
        row("track", "artist", expression),
      ]);
      expect(artist.expression).toBe("++#artist{name:@x}");
      expect(artist.customized).toBe(false);
      expect(
        isComparisonCustomized(
          [row("track", "artist", expression)],
          "track",
          "artist",
        ),
      ).toBe(false);
    }
  });
});

describe("names", () => {
  it("are identifiers, numbered past the table's other comparisons", () => {
    const taken = takenComparisonNames([row("track", "genre", "x")], "track");
    expect([...taken].sort()).toEqual(["artist", "genre"]);
    expect(availableComparisonName("Genre", taken)).toBe("Genre_2");
    expect(availableComparisonName("by label", taken)).toBe("by_label");
    expect(availableComparisonName("", taken)).toBe("comparison");
  });

  it("leave out the one being renamed", () => {
    const taken = takenComparisonNames(
      [row("track", "genre", "x")],
      "track",
      "genre",
    );
    expect(availableComparisonName("genre", taken)).toBe("genre");
  });
});

describe("comparisonPrelude", () => {
  it("defines each comparison with a condition, for the tables the database has", () => {
    const prelude = comparisonPrelude(
      [table("album"), table("track")],
      [
        row("album", "label", "label.name:@x"),
        row("album", "blank", ""),
        row("gone", "x", "id:@x"),
      ],
    );
    expect(prelude.text.split("\n")).toEqual([
      "#album.label:@x = label.name:@x",
      "#track.artist:@x = ++#artist{name:@x}",
    ]);
    expect(locate(prelude, prelude.text.indexOf("label.name"))).toMatchObject({
      offset: 0,
      segment: {
        origin: { kind: "customComparison", table: "album", name: "label" },
      },
    });
  });

  it("leaves out the one asked to", () => {
    expect(
      comparisonPrelude([table("track")], [], {
        table: "track",
        name: "artist",
      }).text,
    ).toBe("");
  });
});

describe("withComparisonExpression", () => {
  it("sets a row's condition, or adds a row for one that had none", () => {
    const rows = [row("track", "genre", "a")];
    expect(withComparisonExpression(rows, "track", "genre", "b")).toEqual([
      row("track", "genre", "b"),
    ]);
    expect(withComparisonExpression(rows, "track", "artist", "c")).toEqual([
      row("track", "genre", "a"),
      row("track", "artist", "c"),
    ]);
    expect(rows).toEqual([row("track", "genre", "a")]);
  });
});
