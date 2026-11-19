import { describe, expect, it } from "vitest";
import { FIXTURE_SCHEMA_JSON } from "../dev/recordFixture";
import { parseSchemaTables, type SchemaTable } from "./schema";
import { locate } from "./sourceMap";
import {
  anyTableHidden,
  builtInSetting,
  composePrelude,
  defaultTableSettings,
  effectiveSetting,
  groupTableSettings,
  listedTables,
  orderTables,
  settingCheck,
  tableMoveOrders,
  tablePrelude,
  type TableSettings,
  type TableSettingsByTable,
} from "./tableSettings";

const TABLES = parseSchemaTables(FIXTURE_SCHEMA_JSON);

const settings = (
  over: Record<string, Partial<TableSettings>>,
): TableSettingsByTable =>
  Object.fromEntries(
    Object.entries(over).map(([table, s]) => [
      table,
      { ...defaultTableSettings(), ...s },
    ]),
  );

const named = (...names: string[]): SchemaTable[] =>
  names.map((name) => ({ name, columns: [], uniqueConstraints: [] }));

describe("groupTableSettings", () => {
  it("keys each row by its table", () => {
    const grouped = groupTableSettings([
      {
        tableName: "track",
        visible: false,
        order: 2,
        defaultTextSearch: "title:@x",
        linkedRecordComparison: null,
        recordPickerSorting: null,
        recordPickerDisplay: "$title",
      },
    ]);
    expect(grouped).toEqual({
      track: {
        visible: false,
        order: 2,
        defaultTextSearch: "title:@x",
        linkedRecordComparison: null,
        recordPickerSorting: null,
        recordPickerDisplay: "$title",
      },
    });
  });
});

describe("effectiveSetting", () => {
  it("is the user's expression where they've written one", () => {
    const s = settings({ track: { defaultTextSearch: "title:@x" } });
    expect(effectiveSetting(s.track, "track", "defaultTextSearch")).toBe(
      "title:@x",
    );
  });

  it("is the app's default without a row, or with a null or blank cell", () => {
    const def = builtInSetting("track", "defaultTextSearch");
    expect(def).toContain("++#artist{name:@x}");
    expect(effectiveSetting(undefined, "track", "defaultTextSearch")).toBe(def);
    for (const blank of [null, "", "  \n"]) {
      const s = settings({ track: { defaultTextSearch: blank } });
      expect(effectiveSetting(s.track, "track", "defaultTextSearch")).toBe(def);
    }
  });

  it("is nothing for a table with neither", () => {
    expect(effectiveSetting(undefined, "role", "defaultTextSearch")).toBe(null);
    expect(effectiveSetting(undefined, "track", "linkedRecordComparison")).toBe(
      "title:@x",
    );
  });

  it("doesn't take a table's default from the object prototype", () => {
    expect(builtInSetting("constructor", "defaultTextSearch")).toBe(null);
  });
});

describe("tablePrelude", () => {
  it("defines each table's settings, for the tables the database has", () => {
    const prelude = tablePrelude(
      named("rating", "track", "role"),
      settings({ rating: { linkedRecordComparison: "symbol:@x" } }),
    );
    expect(prelude.text).toBe(
      [
        "#rating.__querydown_linked_record_comparison:@x = symbol:@x",
        "#track.__querydown_default_text_search:@x = [",
        "  title:@x",
        "  album.title:@x",
        "  ++#artist{name:@x}",
        "  ++#tag{name:@x}",
        "]",
        "#track.__querydown_linked_record_comparison:@x = title:@x",
      ].join("\n"),
    );
  });

  it("traces each expression to its setting", () => {
    const prelude = tablePrelude(named("rating"), {});
    const at = prelude.text.indexOf("value");
    expect(locate(prelude, at)).toMatchObject({
      offset: 0,
      segment: {
        origin: {
          kind: "tableSetting",
          table: "rating",
          setting: "linkedRecordComparison",
        },
        source: "value:@x",
      },
    });
  });

  it("leaves out the setting asked to", () => {
    expect(
      tablePrelude(
        named("track"),
        {},
        {
          table: "track",
          setting: "defaultTextSearch",
        },
      ).text,
    ).toBe("#track.__querydown_linked_record_comparison:@x = title:@x");
  });
});

describe("composePrelude", () => {
  it("puts the tables' definitions ahead of the user's prelude", () => {
    const generated = tablePrelude(named("album"), {});
    const prelude = composePrelude(generated, "#track.year = album.year");
    expect(prelude.text).toBe(
      "#album.__querydown_linked_record_comparison:@x = title:@x\n#track.year = album.year",
    );
    // A position in the user's prelude is one in its own text.
    expect(locate(prelude, prelude.text.indexOf("album.year"))).toMatchObject({
      offset: "#track.year = ".length,
      segment: { origin: { kind: "prelude" } },
    });
  });

  it("is either part alone when the other is empty", () => {
    expect(composePrelude(tablePrelude([], {}), "x").text).toBe("x");
    expect(composePrelude(tablePrelude(named("album"), {}), "").text).toBe(
      "#album.__querydown_linked_record_comparison:@x = title:@x",
    );
  });
});

describe("settingCheck", () => {
  it("searches the table with a string, for a text search", () => {
    const check = settingCheck(
      TABLES,
      "track",
      "defaultTextSearch",
      "title:@x",
      "",
    );
    expect(check).toMatchObject({ base: "track", filter: '"test"' });
    expect(check.definitions.text).toBe(
      "\n#track.__querydown_default_text_search:@x = title:@x",
    );
  });

  it("compares a link to the table, for a linked record comparison", () => {
    const check = settingCheck(
      TABLES,
      "album",
      "linkedRecordComparison",
      "title:@x",
      "",
    );
    expect(check).toMatchObject({ base: "track", filter: 'album:"test"' });
  });

  it("has nothing to compare for a table nothing links to", () => {
    const check = settingCheck(
      TABLES,
      "play",
      "linkedRecordComparison",
      "timestamp:@x",
      "",
    );
    expect(check).toMatchObject({ base: "play", filter: "" });
  });
});

describe("listing tables", () => {
  const tables = named("track", "Album", "artist", "role");

  it("lists them by name until they're arranged", () => {
    expect(listedTables(tables, {}).map((t) => t.name)).toEqual([
      "Album",
      "artist",
      "role",
      "track",
    ]);
  });

  it("puts arranged tables first, by their keys, and leaves out hidden ones", () => {
    const s = settings({
      track: { order: 1 },
      role: { order: 2, visible: false },
    });
    expect(listedTables(tables, s).map((t) => t.name)).toEqual([
      "track",
      "Album",
      "artist",
    ]);
    expect(
      listedTables(tables, s, { showHidden: true }).map((t) => t.name),
    ).toEqual(["track", "role", "Album", "artist"]);
    expect(
      listedTables(tables, s, { keep: "role" }).map((t) => t.name),
    ).toEqual(["track", "role", "Album", "artist"]);
    expect(anyTableHidden(s)).toBe(true);
  });

  it("orders anything standing for a table", () => {
    const s = settings({ b: { order: 1 } });
    expect(
      orderTables([{ t: "a" }, { t: "b" }], (x) => x.t, s).map((x) => x.t),
    ).toEqual(["b", "a"]);
  });
});

describe("tableMoveOrders", () => {
  const names = ["album", "artist", "track"];

  it("numbers every table the first time they're arranged", () => {
    expect(tableMoveOrders(names, {}, "track", undefined, "album")).toEqual([
      { tableName: "track", order: 1 },
      { tableName: "album", order: 2 },
      { tableName: "artist", order: 3 },
    ]);
  });

  it("gives only the moved table a key once they all have one", () => {
    const s = settings({
      album: { order: 1 },
      artist: { order: 2 },
      track: { order: 3 },
    });
    expect(tableMoveOrders(names, s, "track", "album", "artist")).toEqual([
      { tableName: "track", order: 1.5 },
    ]);
  });

  it("moves nothing for a drop beside itself", () => {
    expect(tableMoveOrders(names, {}, "album", undefined, "artist")).toEqual(
      [],
    );
  });
});
