import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStoreBundle } from "./index";
import { fakeEnv } from "./testEnv";
import { buildResultFromStringRows } from "../../query/result";

// `settingSet`/`settingDelete`/`dml` and the query-tree writes are the only
// api-client calls the tests below exercise directly; every other export is used as-is (its return value
// is never awaited by the assertions here).
vi.mock("api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("api-client")>();
  return {
    ...actual,
    settingSet: vi.fn(() => Promise.resolve(null)),
    settingDelete: vi.fn(() => Promise.resolve(null)),
    dml: vi.fn(() => Promise.resolve({})),
    folderAdd: vi.fn(() => Promise.resolve(null)),
    folderDelete: vi.fn(() => Promise.resolve(null)),
    folderRename: vi.fn(() => Promise.resolve(null)),
    queryArrange: vi.fn(() => Promise.resolve(null)),
  };
});
// The rating vocabulary's query, so `loadRatings` can be exercised without a
// compiler or a backend.
vi.mock("../../query/ratings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../query/ratings")>();
  return { ...actual, fetchRatings: vi.fn() };
});

// The run pipeline (`querydownReady` → `compileSavedQuery` → `runSql` →
// `buildResultFromArrow`) is replaced with instantly-resolving stand-ins, so
// `runQuery` can be exercised without a compiler or a backend. Each mock keeps
// the rest of its module real via `importOriginal`.
vi.mock("../../query/querydown", () => ({
  querydownReady: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../query/compile", () => ({
  compileSavedQuery: vi.fn(() => ({ sql: "select 1", columnAnnotations: [] })),
}));
vi.mock("../../api/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/query")>();
  return {
    ...actual,
    runSql: vi.fn(() => Promise.resolve({})),
    runSqlScalar: vi.fn(),
  };
});
vi.mock("../../query/result", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../query/result")>();
  return {
    ...actual,
    buildResultFromArrow: vi.fn(() =>
      actual.buildResultFromStringRows([["r"]]),
    ),
  };
});
// `trackIdColumn` is stubbed to pass its input straight through, so a test can
// hand `analyzeColumnSources`'s resolved value (any placeholder) as the
// track-id column index directly, without constructing a real `ColumnSources`.
vi.mock("../../query/lineage", () => ({
  analyzeColumnSources: vi.fn(),
  trackIdColumn: vi.fn((sources: unknown) => sources as number | undefined),
  recordKeyColumns: vi.fn(() => []),
}));

import {
  dml,
  folderAdd,
  folderDelete,
  folderRename,
  queryArrange,
  settingDelete,
  settingSet,
  type Query,
} from "api-client";
import { fetchRatings } from "../../query/ratings";
import { compileSavedQuery } from "../../query/compile";
import { analyzeColumnSources } from "../../query/lineage";
import { buildResultFromArrow } from "../../query/result";
import { SETTINGS } from "../../state/settings";

function openQueryTab(bundle: AppStoreBundle, id: string) {
  bundle.actions.openTab({ id, name: id, definition: "{}" });
}

describe("closeTab", () => {
  let bundle: AppStoreBundle;
  beforeEach(() => {
    bundle = createAppStore(fakeEnv());
  });

  it("drops the tab's page and selects a remaining neighbor", () => {
    openQueryTab(bundle, "a");
    openQueryTab(bundle, "b");
    openQueryTab(bundle, "c");
    const result = buildResultFromStringRows([["1"], ["2"]]);
    bundle.actions.setResults("b", result, { records: [] });
    bundle.actions.clickRow("b", 0, { shift: false, ctrl: false });
    bundle.actions.setRecordEditorRecords("b", "track", [
      { table: "track", key: [{ column: "id", value: "1" }] },
    ]);
    bundle.actions.toggleBuilderSection("b", "filter");
    bundle.actions.toggleFullEditor("b");
    bundle.actions.selectTab("b");

    bundle.actions.closeTab("b");

    const s = bundle.store.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "c"]);
    expect(s.pages["b"]).toBeUndefined();
    expect(s.pages["a"]).toBeUndefined(); // never written, so never created
    // Closing a middle tab moves the splice's gap to the tab that was to its
    // right ("c" slides into "b"'s old index) — the same neighbor a plain
    // array splice always produces, and what `closeTab`'s fallback chain
    // (`s.tabs[idx] ?? s.tabs[idx - 1]`) picks up first.
    expect(s.activeTabId).toBe("c");
  });

  it("falls back to the tab now last when the closed tab had no right neighbor", () => {
    openQueryTab(bundle, "a");
    openQueryTab(bundle, "b");
    bundle.actions.selectTab("b");
    bundle.actions.closeTab("b");
    expect(bundle.store.getState().activeTabId).toBe("a");
  });
});

describe("clickRow / moveRowSelection", () => {
  let bundle: AppStoreBundle;
  beforeEach(() => {
    bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setResults(
      "a",
      buildResultFromStringRows([["0"], ["1"], ["2"], ["3"], ["4"]]),
    );
  });

  it("extends a shift-click range from the anchor", () => {
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 3, { shift: true, ctrl: false });
    expect(
      [...(bundle.store.getState().pages["a"]?.selection ?? [])].sort(),
    ).toEqual([1, 2, 3]);
  });

  it("re-anchors on a plain click, so a later shift-click grows from there", () => {
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 3, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 4, { shift: true, ctrl: false });
    expect(
      [...(bundle.store.getState().pages["a"]?.selection ?? [])].sort(),
    ).toEqual([3, 4]);
  });

  it("extends from the click lead on Shift+Arrow, not the anchor alone", () => {
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.moveRowSelection("a", true, true); // Shift+Down from row 1
    expect(
      [...(bundle.store.getState().pages["a"]?.selection ?? [])].sort(),
    ).toEqual([1, 2]);
  });

  it("moves the lead without extending on a plain arrow key", () => {
    bundle.actions.clickRow("a", 2, { shift: false, ctrl: false });
    bundle.actions.moveRowSelection("a", false, false); // Up, no shift
    expect([...(bundle.store.getState().pages["a"]?.selection ?? [])]).toEqual([
      1,
    ]);
  });

  it("toggles rows on a plain click in multi-select mode", () => {
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.setMultiSelect("a", true);
    bundle.actions.clickRow("a", 3, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 4, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 3, { shift: false, ctrl: false });
    expect(
      [...(bundle.store.getState().pages["a"]?.selection ?? [])].sort(),
    ).toEqual([1, 4]);
  });

  it("still extends a shift-click range in multi-select mode", () => {
    bundle.actions.setMultiSelect("a", true);
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 3, { shift: true, ctrl: false });
    expect(
      [...(bundle.store.getState().pages["a"]?.selection ?? [])].sort(),
    ).toEqual([1, 2, 3]);
  });

  it("keeps the selection when multi-select mode is turned off", () => {
    bundle.actions.setMultiSelect("a", true);
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 2, { shift: false, ctrl: false });
    bundle.actions.setMultiSelect("a", false);
    const s = bundle.store.getState();
    expect(s.pages["a"]?.multiSelect).toBe(false);
    expect([...(s.pages["a"]?.selection ?? [])].sort()).toEqual([1, 2]);
    // …and a plain click replaces the selection again.
    bundle.actions.clickRow("a", 4, { shift: false, ctrl: false });
    expect([...(bundle.store.getState().pages["a"]?.selection ?? [])]).toEqual([
      4,
    ]);
  });
});

describe("setResults", () => {
  it("clears the old selection and lineage, and nulls the playing row's index", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setResults("a", buildResultFromStringRows([["0"], ["1"]]), {
      records: [],
    });
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.setMultiSelect("a", true);
    bundle.actions.seedNowPlaying(
      { sourceTabId: "a", id: "t1", rowIndex: 1, title: null, artists: [] },
      { playing: true, position: 0, duration: null, hasNext: false },
    );

    bundle.actions.setResults(
      "a",
      buildResultFromStringRows([["x"], ["y"], ["z"]]),
    );

    const s = bundle.store.getState();
    expect(s.pages["a"]?.selection).toBeUndefined();
    expect(s.pages["a"]?.multiSelect).toBe(false);
    expect(s.pages["a"]?.lineage).toBeUndefined();
    expect(s.currentTrack?.rowIndex).toBeNull();
    // The rest of the now-playing bar survives — only the row pointer is
    // invalidated (it's re-located once lineage analysis lands).
    expect(s.currentTrack?.id).toBe("t1");
  });
});

describe("setRecordEditorRecords", () => {
  it("dedupes records that name the same row", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setRecordEditorRecords("a", "track", [
      { table: "track", key: [{ column: "id", value: "1" }] },
      { table: "track", key: [{ column: "id", value: "1" }] },
      { table: "track", key: [{ column: "id", value: "2" }] },
    ]);
    expect(
      bundle.store.getState().pages["a"]?.recordEditor?.records,
    ).toHaveLength(2);
  });

  it("closes the editor when passed no records", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setRecordEditorRecords("a", "track", [
      { table: "track", key: [{ column: "id", value: "1" }] },
    ]);
    bundle.actions.setRecordEditorRecords("a", "track", []);
    expect(bundle.store.getState().pages["a"]?.recordEditor).toBeNull();
  });
});

describe("resyncRecordEditors", () => {
  it("re-points an open editor at a widened selection, and closes it once the selection empties", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setResults(
      "a",
      buildResultFromStringRows([["1"], ["2"], ["3"]]),
      { records: [{ table: "track", keyColumns: ["id"], keyIndices: [0] }] },
    );
    bundle.actions.clickRow("a", 0, { shift: false, ctrl: false });
    bundle.actions.setRecordEditorRecords("a", "track", [
      { table: "track", key: [{ column: "id", value: "1" }] },
    ]);

    // Widen the selection to rows 0 and 1 — the editor should pick up row 1's
    // record too.
    bundle.actions.clickRow("a", 1, { shift: true, ctrl: false });
    bundle.actions.resyncRecordEditors();
    expect(bundle.store.getState().pages["a"]?.recordEditor?.records).toEqual([
      { table: "track", key: [{ column: "id", value: "1" }] },
      { table: "track", key: [{ column: "id", value: "2" }] },
    ]);

    // Empty the selection (two Ctrl-clicks toggle both selected rows off) —
    // the editor should close.
    bundle.actions.clickRow("a", 0, { shift: false, ctrl: true });
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: true });
    bundle.actions.resyncRecordEditors();
    expect(bundle.store.getState().pages["a"]?.recordEditor).toBeNull();
  });

  it("leaves tabs with no open editor alone", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setResults("a", buildResultFromStringRows([["1"], ["2"]]));
    bundle.actions.clickRow("a", 0, { shift: false, ctrl: false });
    expect(() => bundle.actions.resyncRecordEditors()).not.toThrow();
    expect(bundle.store.getState().pages["a"]?.recordEditor).toBeNull();
  });

  it("holds the record it has when the selected rows name none of that table", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setResults("a", buildResultFromStringRows([["1"], ["2"]]), {
      records: [{ table: "track", keyColumns: ["id"], keyIndices: [0] }],
    });
    bundle.actions.clickRow("a", 0, { shift: false, ctrl: false });
    bundle.actions.setRecordEditorRecords("a", "album", [
      { table: "album", key: [{ column: "id", value: "7" }] },
    ]);

    // The rows carry track keys, never an album's — so there's no album for
    // the selection to re-point the editor at. It keeps the album it has: it
    // just has no row to write back through.
    bundle.actions.resyncRecordEditors();
    expect(bundle.store.getState().pages["a"]?.recordEditor?.records).toEqual([
      { table: "album", key: [{ column: "id", value: "7" }] },
    ]);
  });
});

describe("toggleFilterPreset", () => {
  it("collapses the expanded preset when it's the one just removed", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.store.setState((s) => {
      s.presets.push({
        id: "p1",
        name: "Preset",
        baseTable: "track",
        section: "filter",
        definition: "",
        isDefault: false,
        createdAt: 0,
        modifiedAt: 0,
      });
    });
    bundle.actions.toggleFilterPreset("a", "p1"); // add it
    bundle.actions.toggleExpandPreset("a", "p1"); // expand it
    expect(bundle.store.getState().pages["a"]?.expandedPreset).toBe("p1");

    bundle.actions.toggleFilterPreset("a", "p1"); // remove it again

    expect(bundle.store.getState().pages["a"]?.expandedPreset).toBeNull();
  });

  it("leaves a different preset's expansion alone", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.toggleExpandPreset("a", "other");
    bundle.actions.toggleFilterPreset("a", "p1");
    bundle.actions.toggleFilterPreset("a", "p1");
    expect(bundle.store.getState().pages["a"]?.expandedPreset).toBe("other");
  });
});

describe("openRecordsTab", () => {
  const QUERY = {
    base: "credit",
    filter: `track:="t1"`,
    sort: "\\\\order",
    display: "$artist.name",
  };
  const preset = (
    id: string,
    section: "filter" | "sort" | "display",
    baseTable = "credit",
  ) => ({
    id,
    name: id,
    baseTable,
    section,
    definition: "",
    isDefault: true,
    createdAt: 0,
    modifiedAt: 0,
  });

  it("opens an unsaved tab to the right of the given tab, and activates it", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    openQueryTab(bundle, "b");
    openQueryTab(bundle, "c");
    bundle.actions.selectTab("b");

    bundle.actions.openRecordsTab("b", QUERY);

    const s = bundle.store.getState();
    const opened = s.tabs[2];
    expect(s.tabs.map((t) => t.id)).toEqual(["a", "b", opened.id, "c"]);
    expect(s.activeTabId).toBe(opened.id);
    expect(opened.kind === "query" && opened.persisted).toBe(false);
    expect(opened.name).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  });

  it("uses the query's own filter, sort and display when the table has no default display", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.openRecordsTab("a", QUERY);
    const tab = bundle.store.getState().tabs[1];
    expect(tab.kind === "query" && tab.live).toEqual({
      base: "credit",
      filter: { custom: `track:="t1"`, presets: [] },
      sort: { custom: "\\\\order" },
      display: { custom: "$artist.name" },
    });
  });

  it("takes the table's default display preset, but none of its default filter or sort", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.store.setState((s) => {
      s.presets.push(
        preset("f", "filter"),
        preset("s", "sort"),
        preset("d-track", "display", "track"),
        preset("d", "display"),
      );
    });
    bundle.actions.openRecordsTab("a", QUERY);
    const tab = bundle.store.getState().tabs[1];
    expect(tab.kind === "query" && tab.live).toEqual({
      base: "credit",
      filter: { custom: `track:="t1"`, presets: [] },
      sort: { custom: "\\\\order" },
      display: { preset: "d" },
    });
  });
});

describe("showChildRecords", () => {
  const col = (name: string, type: string) => ({
    name,
    type,
    nullable: false,
  });
  const album = (id: string) => ({
    table: "album",
    key: [{ column: "id", value: id }],
  });

  function withSchema() {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.store.setState((s) => {
      s.schema.tables = [
        {
          name: "album",
          columns: [col("id", "UUID"), col("title", "VARCHAR")],
          uniqueConstraints: [["id"]],
        },
        {
          name: "track",
          columns: [
            col("id", "UUID"),
            col("album", "UUID"),
            col("title", "VARCHAR"),
          ],
          uniqueConstraints: [["id"]],
        },
      ];
    });
    return bundle;
  }

  it("opens the albums' tracks in a tab beside the given one", () => {
    const bundle = withSchema();
    bundle.actions.showChildRecords(
      "a",
      "album",
      [album("x"), album("y"), album("x")],
      "track",
    );
    const s = bundle.store.getState();
    const tab = s.tabs[1];
    expect(s.activeTabId).toBe(tab.id);
    expect(tab.kind === "query" && tab.live.base).toBe("track");
    expect(tab.kind === "query" && tab.live.filter.custom).toBe(
      `[\n  album:="x"\n  album:="y"\n]`,
    );
  });

  it("does nothing when the schema has no such field", () => {
    const bundle = withSchema();
    bundle.actions.showChildRecords("a", "album", [album("x")], "credit");
    expect(bundle.store.getState().tabs).toHaveLength(1);
  });
});

describe("loadRatings", () => {
  const loaded = [
    { id: "r1", value: "1", symbol: "🗑️", description: "Skip" },
    { id: "r4", value: "4", symbol: "❤️", description: "Love" },
  ];
  const withSchema = () => {
    const bundle = createAppStore(fakeEnv());
    bundle.actions.setSchemaJson("{}");
    return bundle;
  };

  beforeEach(() => {
    vi.mocked(fetchRatings).mockReset();
    vi.mocked(fetchRatings).mockResolvedValue(loaded);
  });

  it("loads the vocabulary once, however often the menu is raised", async () => {
    const bundle = withSchema();
    bundle.actions.loadRatings();
    bundle.actions.loadRatings();
    await vi.waitFor(() =>
      expect(bundle.store.getState().ratings).toEqual({
        status: "ready",
        data: loaded,
      }),
    );
    bundle.actions.loadRatings();
    expect(fetchRatings).toHaveBeenCalledTimes(1);
  });

  it("waits for the schema the query compiles against", () => {
    const bundle = createAppStore(fakeEnv());
    bundle.actions.loadRatings();
    expect(fetchRatings).not.toHaveBeenCalled();
    expect(bundle.store.getState().ratings.status).toBe("loading");
  });

  it("lets the next raise retry after a failure", async () => {
    vi.mocked(fetchRatings).mockRejectedValueOnce(new Error("nope"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bundle = withSchema();
    bundle.actions.loadRatings();
    await vi.waitFor(() =>
      expect(bundle.store.getState().ratings.status).toBe("error"),
    );
    bundle.actions.loadRatings();
    await vi.waitFor(() =>
      expect(bundle.store.getState().ratings.status).toBe("ready"),
    );
    expect(fetchRatings).toHaveBeenCalledTimes(2);
  });
});

describe("rateTracks", () => {
  const track = (id: string) => ({
    table: "track",
    key: [{ column: "id", value: id }],
  });

  beforeEach(() => {
    vi.mocked(dml).mockClear();
  });

  it("updates every selected track, each record once", async () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.rateTracks(
      "a",
      [track("t1"), track("t2"), track("t1")],
      "r4",
    );
    await vi.waitFor(() => expect(dml).toHaveBeenCalledTimes(1));
    expect(vi.mocked(dml).mock.calls[0][0]).toEqual({
      operations: [
        {
          id: "rating1",
          operation: "update",
          table: "track",
          where: { id: "t1" },
          values: { rating: "r4" },
        },
        {
          id: "rating2",
          operation: "update",
          table: "track",
          where: { id: "t2" },
          values: { rating: "r4" },
        },
      ],
    });
  });

  it("writes nothing for records that identify nothing", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.rateTracks("a", [{ table: "track", key: [] }], "r4");
    expect(dml).not.toHaveBeenCalled();
  });
});

describe("saveSetting", () => {
  it("stores a real customization with settingSet, and re-runs open query tabs", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");

    bundle.actions.saveSetting("querydown_prelude", "custom prelude");

    expect(settingSet).toHaveBeenCalledWith({
      key: "querydown_prelude",
      value: "custom prelude",
    });
    // Re-run is triggered synchronously: `runQuery` flips the page's `running`
    // to `true` before its async body ever awaits anything.
    expect(bundle.store.getState().pages["a"]?.running).toBe(true);
  });

  it("stores a value equal to the default as a deletion, not a setSet", () => {
    const bundle = createAppStore(fakeEnv());
    bundle.actions.saveSetting("querydown_prelude", "custom prelude");
    vi.mocked(settingSet).mockClear();

    bundle.actions.saveSetting(
      "querydown_prelude",
      SETTINGS.querydown_prelude.default,
    );

    expect(settingDelete).toHaveBeenCalledWith({ key: "querydown_prelude" });
    expect(settingSet).not.toHaveBeenCalled();
    expect(
      bundle.store.getState().settingOverrides["querydown_prelude"],
    ).toBeUndefined();
  });
});

describe("a debounced edit", () => {
  it("fires exactly one run after a burst of keystrokes", async () => {
    vi.useFakeTimers();
    try {
      const bundle = createAppStore(fakeEnv());
      openQueryTab(bundle, "a");
      bundle.actions.setSchemaJson("{}");
      vi.mocked(compileSavedQuery).mockClear();

      bundle.actions.setFilterCustom("a", "f");
      bundle.actions.setFilterCustom("a", "fo");
      bundle.actions.setFilterCustom("a", "foo");

      await vi.advanceTimersByTimeAsync(300);

      expect(compileSavedQuery).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a superseded run token", () => {
  it("loses even if its lineage analysis resolves last", async () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setSchemaJson("{}");

    const resolvers: Array<(value: number) => void> = [];
    vi.mocked(analyzeColumnSources).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve as (value: unknown) => void);
        }),
    );

    bundle.actions.runQuery("a"); // run 1
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    bundle.actions.runQuery("a"); // run 2 — supersedes run 1's token
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    // Run 2's analysis lands first.
    resolvers[1](2);
    await vi.waitFor(() =>
      expect(bundle.store.getState().pages["a"]?.lineage?.trackIdColumn).toBe(
        2,
      ),
    );

    // Run 1's (stale) analysis lands after — it must not win the race.
    resolvers[0](1);
    await new Promise((r) => setTimeout(r, 0));
    expect(bundle.store.getState().pages["a"]?.lineage?.trackIdColumn).toBe(2);
  });
});

describe("a refresh", () => {
  // A re-run is a refresh when it compiles to the SQL the rows on screen came
  // from, so each test here drives `compileSavedQuery` (already mocked at the
  // top of the file) and takes the rows that come back from
  // `buildResultFromArrow`. `analyzeColumnSources` is put back to its
  // file-level default (resolving to nothing, so no lineage lands), which an
  // earlier test in this file replaces with a promise it never settles.
  beforeEach(() => {
    vi.mocked(analyzeColumnSources).mockResolvedValue(undefined);
    vi.mocked(compileSavedQuery).mockReturnValue({
      sql: "select 1",
      columnAnnotations: [],
    });
    vi.mocked(buildResultFromArrow).mockReturnValue(
      buildResultFromStringRows([["1"], ["2"], ["3"]]),
    );
  });

  /** Runs `tabId`'s query and waits for its rows to land. */
  async function run(bundle: AppStoreBundle, tabId: string) {
    bundle.actions.runQuery(tabId);
    await vi.waitFor(() =>
      expect(bundle.store.getState().pages[tabId]?.running).toBe(false),
    );
  }

  /** A tab that has run its query once, with a row selected, multi-select on,
   * the results scrolled, and the record editor open on the selected row. */
  async function tabWithRowsInUse(): Promise<AppStoreBundle> {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setSchemaJson("{}");
    await run(bundle, "a");
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.setMultiSelect("a", true);
    bundle.actions.setResultsScroll("a", 420);
    bundle.actions.setRecordEditorRecords("a", "track", [
      { table: "track", key: [{ column: "id", value: "2" }] },
    ]);
    return bundle;
  }

  it("lands its rows under the selection, the editor and the scroll position", async () => {
    const bundle = await tabWithRowsInUse();

    await run(bundle, "a"); // the Refresh button: same query, same SQL

    const page = bundle.store.getState().pages["a"];
    expect(page?.resultIsRefresh).toBe(true);
    expect([...(page?.selection ?? [])]).toEqual([1]);
    expect(page?.multiSelect).toBe(true);
    expect(page?.scrollOffset).toBe(420);
    expect(page?.recordEditor?.records).toEqual([
      { table: "track", key: [{ column: "id", value: "2" }] },
    ]);
  });

  it("sweeps all of it away when the query itself changed", async () => {
    const bundle = await tabWithRowsInUse();

    vi.mocked(compileSavedQuery).mockReturnValue({
      sql: "select 2",
      columnAnnotations: [],
    });
    await run(bundle, "a");

    const page = bundle.store.getState().pages["a"];
    expect(page?.resultIsRefresh).toBe(false);
    expect(page?.selection).toBeUndefined();
    expect(page?.multiSelect).toBe(false);
    expect(page?.scrollOffset).toBe(0);
    // The editor goes with the selection it was standing on — but that's the
    // resync's doing, not this action's (see `createStores`).
    bundle.actions.resyncRecordEditors();
    expect(bundle.store.getState().pages["a"]?.recordEditor).toBeNull();
  });

  it("drops only the selected rows the re-run came back too short for", async () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setSchemaJson("{}");
    await run(bundle, "a");
    bundle.actions.clickRow("a", 0, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 2, { shift: true, ctrl: false });

    vi.mocked(buildResultFromArrow).mockReturnValue(
      buildResultFromStringRows([["1"], ["2"]]),
    );
    await run(bundle, "a");

    const page = bundle.store.getState().pages["a"];
    expect(page?.resultIsRefresh).toBe(true);
    expect([...(page?.selection ?? [])]).toEqual([0, 1]);
  });
});

describe("the query tree", () => {
  let bundle: AppStoreBundle;
  const query = (id: string, position: number): Query => ({
    id,
    name: id,
    createdAt: 0,
    modifiedAt: 0,
    lastPlay: 0,
    definition: "{}",
    parent: null,
    position,
  });
  beforeEach(() => {
    vi.mocked(queryArrange).mockClear();
    vi.mocked(folderAdd).mockClear();
    vi.mocked(folderDelete).mockClear();
    vi.mocked(folderRename).mockClear();
    bundle = createAppStore(fakeEnv());
    bundle.store.setState((s) => {
      s.queries = { status: "ready", data: [query("a", 0), query("b", 1)] };
      s.folders = { status: "ready", data: [] };
    });
  });

  it("adds a new folder at the top and starts renaming it", () => {
    bundle.actions.toggleQueryFilter();
    bundle.actions.setQueryFilter("zzz");
    bundle.actions.newFolder();
    const s = bundle.store.getState();
    const [folder] = s.folders.data;
    expect(folder.position).toBe(-1);
    expect(folder.parent).toBeNull();
    expect(s.renamingFolder).toBe(folder.id);
    // …where it can be seen.
    expect(s.queryFilter).toBe("");
    expect(vi.mocked(folderAdd)).toHaveBeenCalledWith(folder);

    bundle.actions.commitFolderRename(folder.id, "  Mixes ");
    expect(bundle.store.getState().folders.data[0].name).toBe("Mixes");
    expect(bundle.store.getState().renamingFolder).toBeNull();
    expect(vi.mocked(folderRename)).toHaveBeenCalledWith({
      id: folder.id,
      name: "Mixes",
    });
  });

  it("clears the filter when the filter input is hidden", () => {
    bundle.actions.toggleQueryFilter();
    bundle.actions.setQueryFilter("lemon");
    bundle.actions.toggleQueryFilter();
    const s = bundle.store.getState();
    expect(s.queryFilterOpen).toBe(false);
    expect(s.queryFilter).toBe("");
  });

  it("moves an item, locally and in the backend", () => {
    bundle.actions.newFolder();
    const folder = bundle.store.getState().folders.data[0].id;
    bundle.actions.moveTreeItem(
      { kind: "query", id: "b" },
      { kind: "into", folder },
    );
    const b = bundle.store.getState().queries.data.find((q) => q.id === "b");
    expect(b).toMatchObject({ parent: folder, position: 0 });
    expect(vi.mocked(queryArrange)).toHaveBeenCalledWith({
      placements: [{ kind: "query", id: "b", parent: folder, position: 0 }],
    });
  });

  it("deletes a folder, moving its contents into its place", async () => {
    bundle.actions.newFolder();
    const folder = bundle.store.getState().folders.data[0].id;
    bundle.actions.moveTreeItem(
      { kind: "query", id: "b" },
      { kind: "into", folder },
    );
    bundle.actions.deleteFolder(folder);
    const s = bundle.store.getState();
    expect(s.folders.data).toEqual([]);
    expect(s.queries.data.map((q) => [q.id, q.parent, q.position])).toEqual([
      ["a", null, 1],
      ["b", null, 0],
    ]);
    await vi.waitFor(() =>
      expect(vi.mocked(folderDelete)).toHaveBeenCalledWith({ id: folder }),
    );
  });

  it("remembers which folders are expanded", () => {
    const env = fakeEnv();
    const first = createAppStore(env);
    first.actions.toggleFolderExpanded("f");
    expect(first.store.getState().expandedFolders.has("f")).toBe(true);
    expect(createAppStore(env).store.getState().expandedFolders).toEqual(
      new Set(["f"]),
    );
  });
});
