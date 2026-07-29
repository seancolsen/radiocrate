import { describe, expect, it } from "vitest";
import type { Preset } from "api-client";
import {
  definitionForBase,
  emptyDefinition,
  rebasedDefinition,
  toFullQuery,
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
  preset({
    id: "album-display-2",
    baseTable: "album",
    section: "display",
    definition: "$title",
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

  it("takes only the first default for a section that holds one thing", () => {
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
