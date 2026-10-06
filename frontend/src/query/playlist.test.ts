import { describe, expect, it, vi } from "vitest";
import type { Preset } from "api-client";
import { compilePlaylist } from "./compile";
import { definitionForBase, playlistOrderContent } from "./definition";
import {
  assemblePlaylist,
  newPlaylistDefinition,
  pageDefinitionToStored,
  pageDefsEqual,
  playlistDefinitionFromQuery,
  playlistDefinitionFromStored,
  playlistDefinitionToStored,
  playlistDefsEqual,
  playlistQuerydown,
  type PlaylistDefinition,
} from "./playlist";

// `compilePlaylist` hands the compiler the prelude and the generated text; what
// that text compiles to is the probe's business (specs/2026-10-playlists).
vi.mock("querydown-js", () => ({
  compile: vi.fn((_schema: string, _dialect: string, text: string) => ({
    sql: text,
  })),
  compile_sections: vi.fn(),
}));

const PLAYLIST = "d55b955b-6416-440d-bc12-9369c39806d0";

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
  preset({ id: "liked", definition: "rating:>=4", isDefault: true }),
  preset({ id: "recent", definition: "added:>2026-01-01" }),
  preset({
    id: "by-title",
    section: "sort",
    definition: "\\\\title",
    isDefault: true,
  }),
  preset({
    id: "album-display",
    baseTable: "album",
    section: "display",
    definition: "$title",
    isDefault: true,
  }),
  preset({
    id: "track-display",
    section: "display",
    definition: "$title\n$year",
    isDefault: true,
  }),
];

describe("newPlaylistDefinition", () => {
  it("applies only the default track display, with playlist order", () => {
    expect(newPlaylistDefinition(PRESETS)).toEqual({
      filter: { custom: "", presets: [] },
      sort: { builtin: { preset: "playlist_order" } },
      display: { preset: "track-display" },
    });
  });

  it("falls back to an empty display without a default", () => {
    expect(newPlaylistDefinition([]).display).toEqual({ custom: "" });
  });
});

describe("playlistDefinitionFromQuery", () => {
  it("copies a track query's display and nothing else", () => {
    const query = definitionForBase("track", PRESETS);
    query.filter.custom = "year:>1990";
    query.display = { custom: "$artists" };
    expect(playlistDefinitionFromQuery(query, PRESETS)).toEqual({
      filter: { custom: "", presets: [] },
      sort: playlistOrderContent(),
      display: { custom: "$artists" },
    });
  });

  it("uses the default display for a query of another table", () => {
    const query = definitionForBase("album", PRESETS);
    expect(playlistDefinitionFromQuery(query, PRESETS).display).toEqual({
      preset: "track-display",
    });
  });

  it("uses the default display for a full-mode query", () => {
    const query = definitionForBase("track", PRESETS);
    query.display = { custom: "$artists" };
    query.full = "#track $artists";
    expect(playlistDefinitionFromQuery(query, PRESETS).display).toEqual({
      preset: "track-display",
    });
  });

  it("doesn't share the query's display", () => {
    const query = definitionForBase("track", PRESETS);
    query.display = { custom: "$title" };
    const playlist = playlistDefinitionFromQuery(query, PRESETS);
    (query.display as { custom: string }).custom = "$changed";
    expect(playlist.display).toEqual({ custom: "$title" });
  });
});

describe("stored playlist definitions", () => {
  const def: PlaylistDefinition = {
    filter: { custom: "year:>1990", presets: ["recent"] },
    sort: { builtin: { preset: "shuffle", seed: "SEED" } },
    display: { preset: "track-display" },
  };

  it("round-trip", () => {
    expect(
      playlistDefinitionFromStored(playlistDefinitionToStored(def)),
    ).toEqual(def);
    const ordered = newPlaylistDefinition(PRESETS);
    expect(
      playlistDefinitionFromStored(playlistDefinitionToStored(ordered)),
    ).toEqual(ordered);
  });

  it("carry no base and no full mode", () => {
    const stored = JSON.parse(playlistDefinitionToStored(def)) as object;
    expect(Object.keys(stored)).toEqual(["filter", "sort", "display"]);
  });

  it("fill what's missing, and survive garbage", () => {
    const empty = {
      filter: { custom: "", presets: [] },
      sort: playlistOrderContent(),
      display: { custom: "" },
    };
    expect(playlistDefinitionFromStored("{}")).toEqual(empty);
    expect(playlistDefinitionFromStored("")).toEqual(empty);
    expect(playlistDefinitionFromStored("not json")).toEqual(empty);
    expect(playlistDefinitionFromStored('{"filter":{"custom":"x"}}')).toEqual({
      ...empty,
      filter: { custom: "x", presets: [] },
    });
  });

  it("compare structurally, whatever the key order", () => {
    const reordered = JSON.parse(
      '{"display":{"preset":"track-display"},' +
        '"sort":{"builtin":{"seed":"SEED","preset":"shuffle"}},' +
        '"filter":{"presets":["recent"],"custom":"year:>1990"}}',
    ) as PlaylistDefinition;
    expect(playlistDefsEqual(def, reordered)).toBe(true);
    expect(
      playlistDefsEqual(def, { ...def, sort: playlistOrderContent() }),
    ).toBe(false);
  });
});

describe("assemblePlaylist", () => {
  it("resolves every section, with playlist order resolving to nothing", () => {
    expect(
      assemblePlaylist(
        {
          filter: { custom: " year:>1990 ", presets: ["liked", "recent"] },
          sort: playlistOrderContent(),
          display: { preset: "track-display" },
        },
        PRESETS,
      ),
    ).toEqual({
      filter: "year:>1990\nrating:>=4\nadded:>2026-01-01",
      sort: "",
      display: "$title\n$year",
    });
  });

  it("resolves shuffle and preset sorts", () => {
    const def = newPlaylistDefinition(PRESETS);
    def.sort = { builtin: { preset: "shuffle", seed: "SEED" } };
    expect(assemblePlaylist(def, PRESETS).sort).toBe(
      "\\\\id|concat('SEED')|md5",
    );
    def.sort = { preset: "by-title" };
    expect(assemblePlaylist(def, PRESETS).sort).toBe("\\\\title");
  });

  it("throws on a dangling preset", () => {
    const def = newPlaylistDefinition(PRESETS);
    def.filter.presets = ["gone"];
    expect(() => assemblePlaylist(def, PRESETS)).toThrow(/no longer exists/);
  });
});

describe("playlistQuerydown", () => {
  it("follows the spec's template", () => {
    expect(
      playlistQuerydown(PLAYLIST, {
        filter: 'artist:"a"\nyear:>1990',
        sort: "\\\\year \\d",
        display: "$title",
      }),
    ).toBe(
      [
        "#playlist_track",
        "",
        `playlist:="${PLAYLIST}"`,
        "",
        "track{",
        'artist:"a"\nyear:>1990',
        "}",
        "",
        "\\\\track.(",
        "\\\\year \\d",
        ")",
        "\\\\position",
        "\\\\track.id",
        "",
        "$id @{hide:yes}",
        "$position @{hide:yes}",
        "$track.(",
        "$title",
        ")",
      ].join("\n"),
    );
  });

  it("leaves out an empty filter block, but keeps empty sort and display", () => {
    const text = playlistQuerydown(PLAYLIST, {
      filter: "  ",
      sort: "",
      display: "",
    });
    expect(text).not.toContain("track{");
    expect(text).toContain("\\\\track.(\n\n)");
    expect(text).toContain("$track.(\n\n)");
  });

  it("can leave out the filter, for committing a sort", () => {
    const parts = { filter: "year:>1990", sort: "\\\\title", display: "" };
    const text = playlistQuerydown(PLAYLIST, parts, { withFilter: false });
    expect(text).not.toContain("year:>1990");
    expect(text).toContain("\\\\track.(\n\\\\title\n)");
  });

  it("rejects an id that isn't a UUID", () => {
    expect(() =>
      playlistQuerydown('x" || true', { filter: "", sort: "", display: "" }),
    ).toThrow(/Not a playlist id/);
  });

  it("can list one entry, in place of the filter, to read a row back", () => {
    const entry = "00000000-0000-0000-0000-0000000000b1";
    const parts = { filter: "year:>1990", sort: "", display: "$title" };
    const text = playlistQuerydown(PLAYLIST, parts, { entryId: entry });
    expect(text).toContain(`playlist:="${PLAYLIST}"\nid:="${entry}"\n`);
    expect(text).not.toContain("year:>1990");
    expect(text).toContain("$track.(\n$title\n)");
    expect(() =>
      playlistQuerydown(PLAYLIST, parts, { entryId: "1 or true" }),
    ).toThrow(/Not an entry id/);
  });
});

describe("page definitions", () => {
  const playlist = newPlaylistDefinition([]);
  const query = definitionForBase("track", []);

  it("compare a query's and a playlist's apart, and each as its kind does", () => {
    expect(pageDefsEqual(playlist, structuredClone(playlist))).toBe(true);
    expect(pageDefsEqual(query, structuredClone(query))).toBe(true);
    // The same three sections, but one is a query's.
    expect(pageDefsEqual({ ...query, ...playlist }, playlist)).toBe(false);
  });

  it("store as their kind does", () => {
    expect(pageDefinitionToStored(playlist)).toBe(
      playlistDefinitionToStored(playlist),
    );
    expect(JSON.parse(pageDefinitionToStored(query))).toHaveProperty(
      "base",
      "track",
    );
  });
});

describe("compilePlaylist", () => {
  it("compiles the prelude and the playlist query as one whole query", () => {
    const def = newPlaylistDefinition(PRESETS);
    def.filter.custom = "year:>1990";
    const { sql } = compilePlaylist(PLAYLIST, def, PRESETS, "{}", "PRELUDE");
    expect(sql).toBe(
      "PRELUDE\n" +
        playlistQuerydown(PLAYLIST, {
          filter: "year:>1990",
          sort: "",
          display: "$title\n$year",
        }),
    );
    const unfiltered = compilePlaylist(PLAYLIST, def, PRESETS, "{}", "", {
      withFilter: false,
    });
    expect(unfiltered.sql).not.toContain("year:>1990");
  });
});
