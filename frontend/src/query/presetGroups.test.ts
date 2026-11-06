import { describe, expect, it } from "vitest";
import type { Preset } from "api-client";
import { groupPresets, presetTables } from "./presetGroups";

const preset = (name: string, baseTable: string, section: string): Preset => ({
  id: `${baseTable}-${section}-${name}`,
  name,
  baseTable,
  section,
  definition: "",
  isDefault: false,
  createdAt: 0,
  modifiedAt: 0,
});

const PRESETS = [
  preset("Vetted", "track", "filter"),
  preset("by year", "album", "sort"),
  preset("art", "track", "filter"),
  preset("Compact", "track", "display"),
];

/** The groups as `table/section: names`, empty sections left out. */
const shape = (presets: readonly Preset[], tables: string[] = []) =>
  groupPresets(presets, tables).flatMap((g) =>
    g.sections
      .filter((s) => s.presets.length > 0)
      .map(
        (s) =>
          `${g.table}/${s.section}: ${s.presets.map((p) => p.name).join(", ")}`,
      ),
  );

describe("groupPresets", () => {
  it("orders by table, then section, then name", () => {
    expect(shape(PRESETS)).toEqual([
      "album/sort: by year",
      "track/filter: art, Vetted",
      "track/display: Compact",
    ]);
  });

  it("lists every section of a table, even an empty one", () => {
    const album = groupPresets(PRESETS, [])[0];
    expect(album.sections.map((s) => [s.section, s.presets.length])).toEqual([
      ["filter", 0],
      ["sort", 1],
      ["display", 0],
    ]);
  });

  it("lists every table given, with or without presets", () => {
    expect(
      groupPresets(PRESETS, ["track", "artist"]).map((g) => [g.table, g.count]),
    ).toEqual([
      ["album", 1],
      ["artist", 0],
      ["track", 3],
    ]);
  });

  it("sorts a preset by its listed name, when it has one", () => {
    const named = (id: string) => ({ ...PRESETS[0], id, name: id });
    const [group] = groupPresets([named("a"), named("b")], [], { b: "" });
    const section = group.sections.find((x) => x.presets.length > 0);
    expect(section?.presets.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("presetTables", () => {
  it("adds the tables presets are for to those given, in name order", () => {
    expect(presetTables(PRESETS, ["Genre", "track"])).toEqual([
      "album",
      "Genre",
      "track",
    ]);
  });
});
