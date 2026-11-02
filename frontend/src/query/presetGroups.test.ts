import { describe, expect, it } from "vitest";
import type { Preset } from "api-client";
import { groupPresets } from "./presetGroups";

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
const shape = (presets: readonly Preset[], search = "") =>
  groupPresets(presets, search).flatMap((g) =>
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
    const album = groupPresets(PRESETS, "")[0];
    expect(album.sections.map((s) => [s.section, s.presets.length])).toEqual([
      ["filter", 0],
      ["sort", 1],
      ["display", 0],
    ]);
  });

  it("narrows by name, ignoring case", () => {
    expect(shape(PRESETS, "VET")).toEqual(["track/filter: Vetted"]);
  });

  it("narrows by table, dropping tables with nothing left", () => {
    expect(shape(PRESETS, "alb")).toEqual(["album/sort: by year"]);
  });
});
