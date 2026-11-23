// The compile path against the real Querydown compiler: that a problem it
// reports in the text it was handed is traced back to the editor — and the
// offset in that editor's own text — it came from.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import init from "querydown-js";
import type { Preset } from "api-client";
import {
  FIXTURE_SCHEMA_JSON,
  FIXTURE_SCHEMAS_JSON,
} from "../dev/recordFixture";
import {
  checkComparison,
  checkComputedColumn,
  checkFragment,
  checkPrelude,
  checkSetting,
  compilePlaylist,
  compileSavedQuery,
} from "./compile";
import { BUILT_IN_COMPUTED_COLUMNS } from "./computedColumns";
import { parseSchemaTables, readSchemaTables } from "./schema";
import {
  composePrelude,
  defaultTableSettings,
  generatedPrelude,
  type Prelude,
  tablePrelude,
} from "./tableSettings";
import { emptyDefinition, type QueryDefinition } from "./definition";
import { DiagnosticError, type QueryDiagnostic } from "./diagnostics";

beforeAll(async () => {
  const wasm = new URL(
    "../../vendor/querydown-js/querydown_js_bg.wasm",
    import.meta.url,
  );
  await init({ module_or_path: readFileSync(wasm) });
});

/** A prelude a user might write: a computed column, a constant and a
 * function. */
const USER_PRELUDE = `#track.year = album.year
@recent = 1w
@@decade = @y => @y / 10`;

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

const PRESETS = [
  preset({ id: "liked", definition: "title:x" }),
  preset({ id: "broken", definition: "\n  album.title:" }),
  preset({ id: "unfit", definition: "nope:1" }),
];

const PLAYLIST = "11111111-2222-3333-4444-555555555555";

/** The diagnostic `compile` fails with. */
function failure(compile: () => unknown): QueryDiagnostic {
  try {
    compile();
  } catch (err) {
    if (err instanceof DiagnosticError) return err.diagnostic;
    throw err;
  }
  throw new Error("compiled");
}

function query(over: Partial<QueryDefinition>): QueryDefinition {
  return { ...emptyDefinition(), base: "track", ...over };
}

const compileQuery =
  (def: QueryDefinition, prelude = USER_PRELUDE) =>
  () =>
    compileSavedQuery(def, PRESETS, FIXTURE_SCHEMA_JSON, prelude);

describe("a query's problem", () => {
  it("is traced to the custom filter, past the whitespace trimmed off it", () => {
    const d = failure(
      compileQuery(query({ filter: { custom: "  title:", presets: [] } })),
    );
    expect(d).toMatchObject({
      kind: "syntax",
      origin: { kind: "custom", section: "filter" },
      source: "  title:",
      range: { start: 8, end: 8 },
    });
  });

  it("is put down to the filter part that's broken, not where the parser gave up", () => {
    // `title:` takes the next line — the preset's `title` — as its value, and
    // the parser trips on the preset's `:`.
    const d = failure(
      compileQuery(
        query({ filter: { custom: "  title:", presets: ["liked"] } }),
      ),
    );
    expect(d).toMatchObject({
      origin: { kind: "custom", section: "filter" },
      range: { start: 8, end: 8 },
    });
  });

  it("is put down to the broken part in a playlist's filter too", () => {
    const d = failure(() =>
      compilePlaylist(
        PLAYLIST,
        {
          filter: { custom: "title:", presets: ["liked"] },
          sort: { custom: "" },
          display: { custom: "" },
        },
        PRESETS,
        FIXTURE_SCHEMA_JSON,
        USER_PRELUDE,
      ),
    );
    expect(d).toMatchObject({ origin: { kind: "custom", section: "filter" } });
  });

  it("is traced to the filter preset it's in", () => {
    const d = failure(
      compileQuery(
        query({ filter: { custom: "title:x", presets: ["liked", "broken"] } }),
      ),
    );
    expect(d).toMatchObject({
      origin: { kind: "preset", id: "broken", section: "filter" },
      source: "\n  album.title:",
      range: { start: 15, end: 15 },
    });
  });

  it("is traced to the sort or display section it's in", () => {
    const d = failure(compileQuery(query({ display: { custom: "$ (title" } })));
    expect(d).toMatchObject({
      origin: { kind: "custom", section: "display" },
      range: { start: 2, end: 3 },
      notes: [
        {
          range: { start: 8, end: 8 },
          message: "expected `)` here or earlier",
        },
      ],
    });
  });

  it("is traced to the prelude", () => {
    const d = failure(compileQuery(query({}), "#track.x = ("));
    expect(d).toMatchObject({
      origin: { kind: "prelude" },
      source: "#track.x = (",
      range: { start: 11, end: 12 },
    });
  });

  it("is traced into a full query's own text, not the prelude before it", () => {
    const d = failure(
      compileQuery(query({ full: '\n#track\ntitle:"x' }), "#track.y = 1"),
    );
    expect(d).toMatchObject({
      origin: { kind: "full" },
      source: '\n#track\ntitle:"x',
      range: { start: 14, end: 15 },
    });
  });

  it("is traced through a playlist's scaffolding to its filter", () => {
    const d = failure(() =>
      compilePlaylist(
        PLAYLIST,
        {
          filter: { custom: "title:", presets: [] },
          sort: { custom: "" },
          display: { custom: "" },
        },
        PRESETS,
        FIXTURE_SCHEMA_JSON,
        USER_PRELUDE,
      ),
    );
    expect(d).toMatchObject({
      origin: { kind: "custom", section: "filter" },
      range: { start: 6, end: 6 },
    });
  });

  it("is located when it doesn't fit the schema", () => {
    const d = failure(compileQuery(query({ sort: { custom: "\\\\nope" } })));
    expect(d).toMatchObject({
      kind: "compile",
      origin: { kind: "custom", section: "sort" },
      source: "\\\\nope",
      range: { start: 2, end: 6 },
    });
    expect(d.reason).toMatch(/nope/);
  });

  it("is traced to the filter preset that doesn't fit the schema", () => {
    const d = failure(
      compileQuery(
        query({ filter: { custom: "title:x", presets: ["liked", "unfit"] } }),
      ),
    );
    expect(d).toMatchObject({
      kind: "compile",
      origin: { kind: "preset", id: "unfit", section: "filter" },
      source: "nope:1",
      range: { start: 0, end: 4 },
    });
  });

  it("is traced to the prelude definition that doesn't fit the schema", () => {
    // Used in the filter, but wrong where it's defined.
    const prelude = "@mine = album.nope:1";
    const d = failure(
      compileQuery(
        query({ filter: { custom: "@mine", presets: [] } }),
        prelude,
      ),
    );
    expect(d).toMatchObject({
      kind: "compile",
      origin: { kind: "prelude" },
      source: prelude,
      range: { start: 14, end: 18 },
    });
  });

  it("is located in a full query's own text when it doesn't fit the schema", () => {
    const d = failure(compileQuery(query({ full: "#track $nope" })));
    expect(d).toMatchObject({
      kind: "compile",
      origin: { kind: "full" },
      source: "#track $nope",
      range: { start: 8, end: 12 },
    });
  });

  it("is put down to no editor when the compiler gives no location", () => {
    // The base table is handed to the compiler apart from any section's text.
    const d = failure(compileQuery(query({ base: "nope" })));
    expect(d).toMatchObject({ kind: "compile", origin: null, range: null });
    expect(d.reason).toBe("Base table `nope` does not exist.");
  });

  it("names a preset that's gone", () => {
    const d = failure(
      compileQuery(query({ filter: { custom: "", presets: ["gone"] } })),
    );
    expect(d).toMatchObject({
      kind: "definition",
      origin: { kind: "preset", id: "gone", section: "filter" },
    });
  });
});

describe("checkPrelude", () => {
  it("passes a prelude of definitions", () => {
    expect(checkPrelude(FIXTURE_SCHEMA_JSON, USER_PRELUDE)).toBeNull();
  });

  it("passes an empty prelude", () => {
    expect(checkPrelude(FIXTURE_SCHEMA_JSON, "")).toBeNull();
  });

  it("locates a problem in the prelude's own text", () => {
    const prelude = `${USER_PRELUDE}\n#track.x = (`;
    expect(checkPrelude(FIXTURE_SCHEMA_JSON, prelude)).toMatchObject({
      kind: "syntax",
      origin: { kind: "prelude" },
      range: { start: prelude.length - 1, end: prelude.length },
    });
  });
});

describe("checkFragment", () => {
  const origin = { kind: "preset", id: "p", section: "sort" } as const;

  it("passes a fragment that compiles in its section", () => {
    expect(
      checkFragment(
        FIXTURE_SCHEMA_JSON,
        USER_PRELUDE,
        "track",
        "sort",
        "\\\\title",
        origin,
      ),
    ).toBeNull();
  });

  it("locates a problem in the fragment's own text", () => {
    expect(
      checkFragment(
        FIXTURE_SCHEMA_JSON,
        USER_PRELUDE,
        "track",
        "sort",
        "\\\\title $",
        origin,
      ),
    ).toMatchObject({ kind: "syntax", origin, range: { start: 8, end: 9 } });
  });

  it("reports what doesn't fit the schema", () => {
    expect(
      checkFragment(
        FIXTURE_SCHEMA_JSON,
        USER_PRELUDE,
        "track",
        "filter",
        "nope:1",
        origin,
      ),
    ).toMatchObject({ kind: "compile", origin, range: { start: 0, end: 4 } });
  });
});

describe("the tables' settings in the prelude", () => {
  const tables = parseSchemaTables(FIXTURE_SCHEMA_JSON);
  const withSettings = (textSearch: string | null, user = USER_PRELUDE) =>
    composePrelude(
      tablePrelude(tables, {
        track: { ...defaultTableSettings(), defaultTextSearch: textSearch },
      }),
      user,
    );

  it("searches a table by its text search", () => {
    const { sql } = compileSavedQuery(
      query({ filter: { custom: '"love"', presets: [] } }),
      PRESETS,
      FIXTURE_SCHEMA_JSON,
      withSettings(null),
    );
    // The default: the title, the album's, the artists' names and the tags.
    expect(sql).toContain('"album"."title"');
    expect(sql).toContain('"tag"');
  });

  it("compares a link by the linked table's comparison", () => {
    const { sql } = compileSavedQuery(
      query({ filter: { custom: "rating:2", presets: [] } }),
      PRESETS,
      FIXTURE_SCHEMA_JSON,
      withSettings(null),
    );
    expect(sql).toContain('"rating"."value" = 2');
  });

  it("traces a problem in a setting to its editor", () => {
    const d = failure(() =>
      compileSavedQuery(
        query({ filter: { custom: '"love"', presets: [] } }),
        PRESETS,
        FIXTURE_SCHEMA_JSON,
        withSettings("titel:@x"),
      ),
    );
    expect(d).toMatchObject({
      kind: "compile",
      origin: {
        kind: "tableSetting",
        table: "track",
        setting: "defaultTextSearch",
      },
      source: "titel:@x",
      range: { start: 0, end: 5 },
    });
  });

  it("traces a problem in the user's prelude to its own text", () => {
    const user = "#track.x = (";
    const d = failure(() =>
      compileSavedQuery(
        query({}),
        PRESETS,
        FIXTURE_SCHEMA_JSON,
        withSettings(null, user),
      ),
    );
    expect(d).toMatchObject({
      kind: "syntax",
      origin: { kind: "prelude" },
      source: user,
      range: { start: user.length - 1, end: user.length },
    });
  });

  it("lets the user's prelude override a setting, defining it later", () => {
    const { sql } = compileSavedQuery(
      query({ filter: { custom: '"love"', presets: [] } }),
      PRESETS,
      FIXTURE_SCHEMA_JSON,
      withSettings(
        null,
        "#track.__querydown_default_text_search:@x = album.title:@x",
      ),
    );
    expect(sql).not.toContain('strip_accents("track"."title")');
    expect(sql).toContain('strip_accents("album"."title")');
  });
});

describe("checkSetting", () => {
  const tables = parseSchemaTables(FIXTURE_SCHEMA_JSON);

  it("passes the defaults", () => {
    expect(
      checkSetting(
        FIXTURE_SCHEMA_JSON,
        tables,
        "track",
        "defaultTextSearch",
        "[\n  title:@x\n  ++#artist{name:@x}\n]",
        USER_PRELUDE,
      ),
    ).toBeNull();
    expect(
      checkSetting(
        FIXTURE_SCHEMA_JSON,
        tables,
        "rating",
        "linkedRecordComparison",
        "value:@x",
        "",
      ),
    ).toBeNull();
  });

  it("locates a problem in the expression's own text", () => {
    expect(
      checkSetting(
        FIXTURE_SCHEMA_JSON,
        tables,
        "track",
        "defaultTextSearch",
        "[\n  title:@x\n",
        "",
      ),
    ).toMatchObject({
      kind: "syntax",
      origin: { kind: "tableSetting", table: "track" },
      range: { start: 0, end: 1 },
    });
    expect(
      checkSetting(
        FIXTURE_SCHEMA_JSON,
        tables,
        "album",
        "linkedRecordComparison",
        "nope:@x",
        "",
      ),
    ).toMatchObject({
      kind: "compile",
      origin: { kind: "tableSetting", setting: "linkedRecordComparison" },
      range: { start: 0, end: 4 },
    });
  });
});

describe("computed columns in the prelude", () => {
  const tables = parseSchemaTables(FIXTURE_SCHEMA_JSON);
  const prelude = (
    computed: {
      tableSchema: string;
      tableName: string;
      name: string;
      expression: string | null;
    }[],
    user = "",
  ) => composePrelude(generatedPrelude(tables, {}, computed, []), user);
  const displaying = (display: string, under = prelude([])) =>
    compileSavedQuery(
      query({ display: { custom: display } }),
      PRESETS,
      FIXTURE_SCHEMA_JSON,
      under,
    );

  it("define the app's own columns, with no prelude of the user's at all", () => {
    const { sql } = displaying(
      "$first_play $last_play $artists $year $added $duration $play_count",
    );
    expect(sql).toContain('max("play"."timestamp")');
    expect(sql).toContain('"file"."duration"');
  });

  it("define the app's custom comparison too", () => {
    const { sql } = compileSavedQuery(
      query({ filter: { custom: "artist:prince", presets: [] } }),
      PRESETS,
      FIXTURE_SCHEMA_JSON,
      prelude([]),
    );
    expect(sql).toContain('"artist"."name"');
  });

  it("define the user's columns, which can use the app's and each other", () => {
    const under = prelude([
      {
        tableSchema: "main",
        tableName: "track",
        name: "era",
        expression: "decade * 10",
      },
      {
        tableSchema: "main",
        tableName: "track",
        name: "decade",
        expression: "year / 10",
      },
    ]);
    expect(displaying("$era", under).sql).toContain('"album"."year"');
  });

  it("go by the user's expression for one of the app's", () => {
    const under = prelude([
      {
        tableSchema: "main",
        tableName: "track",
        name: "year",
        expression: "disc_number",
      },
    ]);
    const { sql } = displaying("$year", under);
    expect(sql).toContain('"track"."disc_number"');
    expect(sql).not.toContain('"album"');
  });

  it("give way to a definition of the same name in the user's prelude", () => {
    const under = prelude([], "#track.year = disc_number");
    expect(displaying("$year", under).sql).toContain('"track"."disc_number"');
  });

  it("trace a problem to the column's expression", () => {
    const expression = "album.nope";
    const under = prelude([
      { tableSchema: "main", tableName: "track", name: "bad", expression },
    ]);
    expect(failure(() => displaying("$bad", under))).toMatchObject({
      kind: "compile",
      origin: { kind: "computedColumn", table: "track", name: "bad" },
      source: expression,
      range: { start: 6, end: 10 },
    });
  });
});

describe("custom comparisons in the prelude", () => {
  const tables = parseSchemaTables(FIXTURE_SCHEMA_JSON);
  const filtering = (
    filter: string,
    comparisons: {
      tableSchema: string;
      tableName: string;
      name: string;
      expression: string;
    }[],
  ) =>
    compileSavedQuery(
      query({ filter: { custom: filter, presets: [] } }),
      PRESETS,
      FIXTURE_SCHEMA_JSON,
      composePrelude(generatedPrelude(tables, {}, [], comparisons), ""),
    );

  it("define the user's, and their condition for one of the app's", () => {
    const { sql } = filtering("album_title:dark", [
      {
        tableSchema: "main",
        tableName: "track",
        name: "album_title",
        expression: "album.title:@x",
      },
    ]);
    expect(sql).toContain('"album"."title"');
    const custom = filtering("artist:prince", [
      {
        tableSchema: "main",
        tableName: "track",
        name: "artist",
        expression: "title:@x",
      },
    ]).sql;
    expect(custom).not.toContain('"artist"."name"');
  });
});

describe("checkComparison", () => {
  const tables = parseSchemaTables(FIXTURE_SCHEMA_JSON);
  const check = (expression: string, name = "mine") =>
    checkComparison(
      FIXTURE_SCHEMA_JSON,
      "track",
      name,
      expression,
      generatedPrelude(tables, {}, [], [], {
        table: "track",
        comparison: name,
      }),
    );

  it("passes a condition that compiles on the table", () => {
    expect(check("album.title:@x")).toBeNull();
    expect(check("++#artist{name:@x}", "artist")).toBeNull();
  });

  it("traces a problem to the comparison's condition", () => {
    expect(check("album.nope:@x")).toMatchObject({
      origin: { kind: "customComparison", table: "track", name: "mine" },
      source: "album.nope:@x",
    });
  });
});

describe("checkComputedColumn", () => {
  const tables = parseSchemaTables(FIXTURE_SCHEMA_JSON);
  const check = (expression: string, name = "mine") =>
    checkComputedColumn(
      FIXTURE_SCHEMA_JSON,
      "track",
      name,
      expression,
      generatedPrelude(tables, {}, [], [], {
        table: "track",
        computedColumn: name,
      }),
    );
  const origin = { kind: "computedColumn", table: "track", name: "mine" };

  it("passes an expression that compiles on the table", () => {
    expect(check("album.year")).toBeNull();
    expect(check("#play.timestamp%max")).toBeNull();
    // One over several lines, and one using another computed column.
    expect(check("? year:>2000 ~ 1\n  ~~ 0")).toBeNull();
    expect(check("play_count + 1")).toBeNull();
  });

  it("passes the app's own expression for each of its columns", () => {
    for (const [table, columns] of Object.entries(BUILT_IN_COMPUTED_COLUMNS)) {
      for (const column of columns) {
        const problem = checkComputedColumn(
          FIXTURE_SCHEMA_JSON,
          table,
          column.name,
          column.expression,
          generatedPrelude(tables, {}, [], [], {
            table,
            computedColumn: column.name,
          }),
        );
        expect(problem, `${table}.${column.name}`).toBeNull();
      }
    }
  });

  it("locates a syntax error in the expression's own text", () => {
    expect(check("album.year + (")).toMatchObject({
      kind: "syntax",
      origin,
      source: "album.year + (",
    });
  });

  it("reports what doesn't fit the schema, which nothing using it would", () => {
    expect(check("album.nope")).toMatchObject({
      kind: "compile",
      origin,
      range: { start: 6, end: 10 },
    });
  });
});

describe("a table of another schema", () => {
  const { allTables } = readSchemaTables(FIXTURE_SCHEMAS_JSON);
  const compileOn = (def: QueryDefinition, prelude: Prelude = "") =>
    compileSavedQuery(def, PRESETS, FIXTURE_SCHEMAS_JSON, prelude);

  it("is a query's base, by its schema", () => {
    const { sql } = compileOn(query({ base: "/lastfm/artist" }));
    expect(sql).toContain('FROM "lastfm"."artist"');
    // The app's own `artist` is another table.
    expect(compileOn(query({ base: "artist" })).sql).toContain('FROM "artist"');
  });

  it("is a full query's base", () => {
    const { sql } = compileOn(query({ full: "#/lastfm/scrobble $title" }));
    expect(sql).toContain('FROM "lastfm"."scrobble"');
  });

  it("has the definitions generated for it, apart from the app's table of its name", () => {
    const row = (tableSchema: string, expression: string) => ({
      tableSchema,
      tableName: "artist",
      name: "key",
      expression,
    });
    const prelude = generatedPrelude(
      allTables,
      {
        "/lastfm/artist": {
          ...defaultTableSettings(),
          defaultTextSearch: "name:@x",
        },
      },
      // The app's `artist` has no `mbid`: were its column given `lastfm`'s
      // expression, the query on it would fail.
      [row("lastfm", "mbid"), row("main", "id")],
      [],
    );
    const theirs = compileOn(
      query({
        base: "/lastfm/artist",
        filter: { custom: '"abc"', presets: [] },
        display: { custom: "$key" },
      }),
      prelude,
    ).sql;
    expect(theirs).toContain('"artist"."mbid"');
    expect(theirs).toContain('strip_accents("artist"."name")');
    const ours = compileOn(
      query({ base: "artist", display: { custom: "$key" } }),
      prelude,
    ).sql;
    expect(ours).toContain('"artist"."id"');
    expect(ours).not.toContain("mbid");
  });
});
