// The compile path against the real Querydown compiler: that a problem it
// reports in the text it was handed is traced back to the editor — and the
// offset in that editor's own text — it came from.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import init from "querydown-js";
import type { Preset } from "api-client";
import { FIXTURE_SCHEMA_JSON } from "../dev/recordFixture";
import {
  checkFragment,
  checkPrelude,
  compilePlaylist,
  compileSavedQuery,
} from "./compile";
import {
  DEFAULT_PRELUDE,
  emptyDefinition,
  type QueryDefinition,
} from "./definition";
import { DiagnosticError, type QueryDiagnostic } from "./diagnostics";

beforeAll(async () => {
  const wasm = new URL(
    "../../vendor/querydown-js/querydown_js_bg.wasm",
    import.meta.url,
  );
  await init({ module_or_path: readFileSync(wasm) });
});

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
  (def: QueryDefinition, prelude = DEFAULT_PRELUDE) =>
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
        DEFAULT_PRELUDE,
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
        DEFAULT_PRELUDE,
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
  it("passes the default prelude", () => {
    expect(checkPrelude(FIXTURE_SCHEMA_JSON, DEFAULT_PRELUDE)).toBeNull();
  });

  it("passes an empty prelude", () => {
    expect(checkPrelude(FIXTURE_SCHEMA_JSON, "")).toBeNull();
  });

  it("locates a problem in the prelude's own text", () => {
    const prelude = `${DEFAULT_PRELUDE}\n#track.x = (`;
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
        DEFAULT_PRELUDE,
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
        DEFAULT_PRELUDE,
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
        DEFAULT_PRELUDE,
        "track",
        "filter",
        "nope:1",
        origin,
      ),
    ).toMatchObject({ kind: "compile", origin, range: { start: 0, end: 4 } });
  });
});
