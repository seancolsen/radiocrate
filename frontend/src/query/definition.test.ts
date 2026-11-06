import { describe, expect, it } from "vitest";
import type { Preset } from "api-client";
import {
  appendCustom,
  definitionForBase,
  emptyDefinition,
  presetSectionIn,
  rebasedDefinition,
  toFullQuery,
  withoutPresets,
  type QueryDefinition,
} from "./definition";

// What changing a query's base table (and flattening it into one hand-written
// query) does to the stored definition — the pure half of both wrench-menu
// actions.

function preset(over: Partial<Preset> & { id: string }): Preset {
  return {
    name: over.id,
    baseTable: "track",
    section: "filter",
    definition: "",
    isDefault: false,
    createdAt: 0,
    modifiedAt: 0,
    ...over,
  };
}

const PRESETS: Preset[] = [
  preset({ id: "track-filter", definition: "rating:>=4", isDefault: true }),
  preset({
    id: "track-sort",
    section: "sort",
    definition: "\\\\title",
    isDefault: true,
  }),
  preset({
    id: "album-display",
    baseTable: "album",
    section: "display",
    definition: "$title $year",
    isDefault: true,
  }),
  preset({ id: "album-filter", baseTable: "album", definition: "year:>1990" }),
];

function definition(over: Partial<QueryDefinition> = {}): QueryDefinition {
  return { ...emptyDefinition(), base: "track", ...over };
}

describe("definitionForBase", () => {
  it("seeds the chosen table's default presets", () => {
    expect(definitionForBase("track", PRESETS)).toEqual({
      base: "track",
      filter: { custom: "", presets: ["track-filter"] },
      sort: { preset: "track-sort" },
      display: { custom: "" },
    });
  });

  it("ignores defaults belonging to other tables, and non-default presets", () => {
    expect(definitionForBase("album", PRESETS).filter.presets).toEqual([]);
  });

  it("seeds the default display", () => {
    expect(definitionForBase("album", PRESETS).display).toEqual({
      preset: "album-display",
    });
  });

  it("leaves a table with no defaults empty", () => {
    expect(definitionForBase("artist", PRESETS)).toEqual({
      ...emptyDefinition(),
      base: "artist",
    });
  });
});

describe("rebasedDefinition", () => {
  it("keeps the hand-written filter and reseeds everything else", () => {
    const def = definition({
      base: "album",
      filter: { custom: "year:>1990", presets: ["album-filter"] },
      sort: { custom: "\\\\year" },
      display: { custom: "$title" },
    });
    expect(rebasedDefinition(def, "track", PRESETS)).toEqual({
      base: "track",
      filter: { custom: "year:>1990", presets: ["track-filter"] },
      sort: { preset: "track-sort" },
      display: { custom: "" },
    });
  });

  it("drops a full-mode query back to sections", () => {
    const def = definition({ full: "#album $title" });
    expect(rebasedDefinition(def, "album", PRESETS).full).toBeUndefined();
  });
});

describe("toFullQuery", () => {
  it("flattens the sections into one query, resolving presets", () => {
    const def = definition({
      filter: { custom: "jazz", presets: ["track-filter"] },
      sort: { preset: "track-sort" },
      display: { custom: "$title $#play" },
    });
    expect(toFullQuery(def, PRESETS)).toBe(
      "#track\njazz\nrating:>=4\n\\\\title\n$title $#play",
    );
  });

  it("omits empty sections and dangling preset references", () => {
    const def = definition({ filter: { custom: "  ", presets: ["gone"] } });
    expect(toFullQuery(def, PRESETS)).toBe("#track");
  });

  it("resolves the built-in shuffle to its Querydown", () => {
    const def = definition({
      sort: { builtin: { preset: "shuffle", seed: "s" } },
    });
    expect(toFullQuery(def, PRESETS)).toBe("#track\n\\\\id|concat('s')|md5");
  });

  it("returns an already-full query unchanged", () => {
    expect(toFullQuery(definition({ full: "#album $title" }), PRESETS)).toBe(
      "#album $title",
    );
  });
});

describe("withoutPresets", () => {
  const def: QueryDefinition = {
    base: "track",
    filter: { custom: "jazz", presets: ["kept", "gone"] },
    sort: { preset: "gone" },
    display: { preset: "kept" },
  };
  const gone = (id: string) => id === "gone";

  it("takes a reference out of the filter, and puts back a section's fallback", () => {
    expect(
      withoutPresets(def, gone, {
        sort: { custom: "\\\\title" },
        display: { custom: "" },
      }),
    ).toEqual({
      base: "track",
      filter: { custom: "jazz", presets: ["kept"] },
      sort: { custom: "\\\\title" },
      display: { preset: "kept" },
    });
  });

  it("hands back the definition itself when it has none", () => {
    const clean = emptyDefinition();
    expect(withoutPresets(clean, gone, clean)).toBe(clean);
  });
});

describe("presetSectionIn", () => {
  const def: QueryDefinition = {
    base: "track",
    filter: { custom: "", presets: ["f"] },
    sort: { preset: "s" },
    display: { preset: "d" },
  };

  it("names the section that holds the preset", () => {
    expect(presetSectionIn(def, "f")).toBe("filter");
    expect(presetSectionIn(def, "s")).toBe("sort");
    expect(presetSectionIn(def, "d")).toBe("display");
    expect(presetSectionIn(def, "other")).toBeNull();
  });

  it("finds none in a full query, which ignores its sections", () => {
    expect(presetSectionIn({ ...def, full: "#track" }, "f")).toBeNull();
  });
});

describe("appendCustom", () => {
  it("adds text after what's there, on a line of its own", () => {
    expect(appendCustom("year:1999", "  title:x\n")).toBe("year:1999\ntitle:x");
  });

  it("takes the place of nothing but blank", () => {
    expect(appendCustom("", "title:x")).toBe("title:x");
    expect(appendCustom(" \n", "title:x")).toBe("title:x");
  });

  it("adds nothing for blank text", () => {
    expect(appendCustom("year:1999", " ")).toBe("year:1999");
  });
});
