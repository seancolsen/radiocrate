import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAppStore,
  type AppStoreBundle,
  type PreparedStep,
} from "./index";
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
    sourceArrange: vi.fn(() => Promise.resolve(null)),
    queryAdd: vi.fn(() => Promise.resolve(null)),
    sourceRename: vi.fn(() => Promise.resolve(null)),
    sourceUpdateDefinition: vi.fn(() => Promise.resolve(null)),
    queryDelete: vi.fn(() => Promise.resolve(null)),
    collectionRescan: vi.fn(() => Promise.resolve(null)),
  };
});
// A playlist's entries, read as raw SQL, so duplicating and deleting one can be
// exercised without a backend. Its writes still go through the mocked `dml`.
vi.mock("../../api/playlist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/playlist")>();
  return {
    ...actual,
    fetchPlaylistEntries: vi.fn(() => Promise.resolve([])),
    fetchMaxPosition: vi.fn(() => Promise.resolve(null)),
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
  compilePlaylist: vi.fn(() => ({ sql: "select 2", columnAnnotations: [] })),
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
  collectionRescan,
  dml,
  folderAdd,
  folderDelete,
  folderRename,
  queryAdd,
  sourceArrange,
  queryDelete,
  sourceRename,
  sourceUpdateDefinition,
  settingDelete,
  settingSet,
  type Source,
} from "api-client";
import { fetchMaxPosition, fetchPlaylistEntries } from "../../api/playlist";
import { runSql } from "../../api/query";
import { fetchRatings } from "../../query/ratings";
import { compilePlaylist, compileSavedQuery } from "../../query/compile";
import { analyzeColumnSources, recordKeyColumns } from "../../query/lineage";
import { buildResultFromArrow } from "../../query/result";
import { rowEntry, type EntryWrites } from "../../query/playlistEntries";
import { SETTINGS } from "../../state/settings";
import {
  selectCanConvertToPlaylist,
  selectCanRedo,
  selectCanUndo,
  selectCanWriteFromRows,
  selectFilterApplied,
  selectIsUnsaved,
  selectPageTab,
  selectQueryTab,
  selectRowContext,
  selectSortApplied,
} from "./selectors";

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
    // Unsaved, so nameless until it's saved.
    expect(opened.name).toBe("");
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

describe("rescanCollection", () => {
  it("holds `rescanning` for the length of the call, then clears it", async () => {
    let finish!: () => void;
    vi.mocked(collectionRescan).mockReturnValueOnce(
      new Promise<null>((resolve) => {
        finish = () => resolve(null);
      }),
    );
    const bundle = createAppStore(fakeEnv());

    const done = bundle.actions.rescanCollection();
    expect(bundle.store.getState().rescanning).toBe(true);

    finish();
    await done;
    expect(bundle.store.getState().rescanning).toBe(false);
  });

  it("ignores a second request while one is in flight", async () => {
    let finish!: () => void;
    vi.mocked(collectionRescan).mockClear();
    vi.mocked(collectionRescan).mockReturnValueOnce(
      new Promise<null>((resolve) => {
        finish = () => resolve(null);
      }),
    );
    const bundle = createAppStore(fakeEnv());

    const done = bundle.actions.rescanCollection();
    await bundle.actions.rescanCollection();
    expect(collectionRescan).toHaveBeenCalledTimes(1);
    // The one that did nothing still resolved, and left the running scan alone.
    expect(bundle.store.getState().rescanning).toBe(true);

    finish();
    await done;
  });

  it("resolves and clears `rescanning` when the scan fails", async () => {
    vi.mocked(collectionRescan).mockRejectedValueOnce(new Error("no such dir"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bundle = createAppStore(fakeEnv());

    // Resolves rather than rejects: the menu closes on a failed scan too (the
    // error bar is what reports it).
    await bundle.actions.rescanCollection();

    expect(bundle.store.getState().rescanning).toBe(false);
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
  const query = (id: string, position: number): Source => ({
    id,
    kind: "query",
    name: id,
    createdAt: 0,
    modifiedAt: 0,
    lastPlay: 0,
    definition: "{}",
    parent: null,
    position,
    queryId: `query-${id}`,
    playlistId: null,
  });
  beforeEach(() => {
    vi.mocked(sourceArrange).mockClear();
    vi.mocked(folderAdd).mockClear();
    vi.mocked(folderDelete).mockClear();
    vi.mocked(folderRename).mockClear();
    bundle = createAppStore(fakeEnv());
    bundle.store.setState((s) => {
      s.sources = { status: "ready", data: [query("a", 0), query("b", 1)] };
      s.folders = { status: "ready", data: [] };
    });
  });

  it("adds a new folder at the top, expanded, and starts renaming it", () => {
    bundle.actions.toggleSourceFilter();
    bundle.actions.setSourceFilter("zzz");
    bundle.actions.newFolder();
    const s = bundle.store.getState();
    const [folder] = s.folders.data;
    expect(folder.position).toBe(-1);
    expect(folder.parent).toBeNull();
    expect(s.renamingTreeItem).toEqual({ kind: "folder", id: folder.id });
    expect(s.expandedFolders.has(folder.id)).toBe(true);
    // …where it can be seen.
    expect(s.sourceFilter).toBe("");
    expect(vi.mocked(folderAdd)).toHaveBeenCalledWith(folder);

    bundle.actions.commitTreeRename(
      { kind: "folder", id: folder.id },
      "  Mixes ",
    );
    expect(bundle.store.getState().folders.data[0].name).toBe("Mixes");
    expect(bundle.store.getState().renamingTreeItem).toBeNull();
    expect(vi.mocked(folderRename)).toHaveBeenCalledWith({
      id: folder.id,
      name: "Mixes",
    });
  });

  it("clears the filter when the filter input is hidden", () => {
    bundle.actions.toggleSourceFilter();
    bundle.actions.setSourceFilter("lemon");
    bundle.actions.toggleSourceFilter();
    const s = bundle.store.getState();
    expect(s.sourceFilterOpen).toBe(false);
    expect(s.sourceFilter).toBe("");
  });

  it("moves an item, locally and in the backend", () => {
    bundle.actions.newFolder();
    const folder = bundle.store.getState().folders.data[0].id;
    bundle.actions.moveTreeItem(
      { kind: "source", id: "b" },
      { kind: "into", folder },
    );
    const b = bundle.store.getState().sources.data.find((q) => q.id === "b");
    expect(b).toMatchObject({ parent: folder, position: 0 });
    expect(vi.mocked(sourceArrange)).toHaveBeenCalledWith({
      placements: [{ kind: "source", id: "b", parent: folder, position: 0 }],
    });
  });

  it("deletes a folder, moving its contents into its place", async () => {
    bundle.actions.newFolder();
    const folder = bundle.store.getState().folders.data[0].id;
    bundle.actions.moveTreeItem(
      { kind: "source", id: "b" },
      { kind: "into", folder },
    );
    bundle.actions.deleteFolder(folder);
    const s = bundle.store.getState();
    expect(s.folders.data).toEqual([]);
    expect(s.sources.data.map((q) => [q.id, q.parent, q.position])).toEqual([
      ["a", null, 1],
      ["b", null, 0],
    ]);
    await vi.waitFor(() =>
      expect(vi.mocked(folderDelete)).toHaveBeenCalledWith({ id: folder }),
    );
  });

  it("expands an empty folder that something is dropped into", () => {
    bundle.actions.newFolder();
    const folder = bundle.store.getState().folders.data[0].id;
    bundle.actions.toggleFolderExpanded(folder); // collapse it
    expect(
      bundle.actions.moveTreeItem(
        { kind: "source", id: "a" },
        { kind: "into", folder },
      ),
    ).toBe(true);
    expect(bundle.store.getState().expandedFolders.has(folder)).toBe(true);

    // A drop that moves nothing says so.
    expect(
      bundle.actions.moveTreeItem(
        { kind: "source", id: "a" },
        { kind: "into", folder },
      ),
    ).toBe(false);
  });

  it("opens a new query unsaved, and saves it at the top of its folder", () => {
    vi.mocked(queryAdd).mockClear();
    bundle.actions.newFolder();
    const folder = bundle.store.getState().folders.data[0].id;
    bundle.actions.moveTreeItem(
      { kind: "source", id: "a" },
      { kind: "into", folder },
    );
    bundle.actions.toggleFolderExpanded(folder); // collapse it
    bundle.actions.addQuery(folder);
    const id = bundle.store.getState().activeTabId!;
    // Nothing is written, and nothing shows in the tree, until it's saved.
    expect(selectQueryTab(bundle.store.getState(), id)).toMatchObject({
      name: "",
      persisted: false,
    });
    expect(selectIsUnsaved(bundle.store.getState(), id)).toBe(true);
    expect(vi.mocked(queryAdd)).not.toHaveBeenCalled();
    expect(bundle.store.getState().sources.data.map((q) => q.id)).toEqual([
      "a",
      "b",
    ]);

    bundle.actions.saveQuery(id);
    const s = bundle.store.getState();
    const added = s.sources.data[0];
    expect(added).toMatchObject({ id, parent: folder, position: -1 });
    // The tab names the source; the query row it wraps has an id of its own.
    expect(added.kind).toBe("query");
    expect(added.queryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(added.queryId).not.toBe(id);
    expect(added.name).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(vi.mocked(queryAdd)).toHaveBeenCalledWith(added);
    expect(selectQueryTab(s, id)).toMatchObject({
      name: added.name,
      persisted: true,
    });
    expect(selectIsUnsaved(s, id)).toBe(false);
    expect(s.expandedFolders.has(folder)).toBe(true);
  });

  it("puts a new query back to unsaved when the backend turns it down", async () => {
    vi.mocked(queryAdd).mockRejectedValueOnce(new Error("500 nope"));
    bundle.actions.newQueryTab();
    const id = bundle.store.getState().activeTabId!;
    bundle.actions.saveQuery(id);
    await vi.waitFor(() =>
      expect(selectQueryTab(bundle.store.getState(), id)).toMatchObject({
        name: "",
        persisted: false,
      }),
    );
    expect(bundle.store.getState().sources.data.map((q) => q.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("renames a query in place, and the tab that has it open", () => {
    openQueryTab(bundle, "a");
    bundle.actions.beginTreeRename({ kind: "source", id: "a" });
    bundle.actions.commitTreeRename({ kind: "source", id: "a" }, "Renamed");
    const s = bundle.store.getState();
    expect(s.sources.data.find((q) => q.id === "a")?.name).toBe("Renamed");
    expect(s.tabs.find((t) => t.id === "a")?.name).toBe("Renamed");
    expect(vi.mocked(sourceRename)).toHaveBeenCalledWith({
      id: "a",
      name: "Renamed",
    });
  });

  it("duplicates and deletes a query that isn't open", () => {
    bundle.actions.duplicateQuery("b");
    const s = bundle.store.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ kind: "query", persisted: false });

    bundle.actions.requestDelete("b");
    expect(bundle.store.getState().pendingDelete).toEqual({
      id: "b",
      kind: "query",
      name: "b",
      unsaved: false,
    });
    bundle.actions.confirmDelete();
    expect(vi.mocked(queryDelete)).toHaveBeenCalledWith({ id: "b" });
    expect(bundle.store.getState().sources.data.map((q) => q.id)).toEqual([
      "a",
    ]);
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

describe("autosave", () => {
  const IDLE = 5000;
  let bundle: AppStoreBundle;

  /** The definitions written so far, as their filter text. */
  const written = () =>
    vi
      .mocked(sourceUpdateDefinition)
      .mock.calls.map(
        ([p]) =>
          (JSON.parse(p.definition) as { filter: { custom: string } }).filter
            .custom,
      );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(sourceUpdateDefinition).mockReset();
    vi.mocked(sourceUpdateDefinition).mockResolvedValue(null);
    bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
  });
  afterEach(() => {
    bundle.dispose();
    vi.useRealTimers();
  });

  it("writes a saved query's edit once the app has been idle for a while", async () => {
    bundle.actions.setFilterCustom("a", "jazz");
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(sourceUpdateDefinition).not.toHaveBeenCalled();
    // No Save button, no ✱: the edit is on its way.
    expect(selectIsUnsaved(bundle.store.getState(), "a")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(written()).toEqual(["jazz"]);
    expect(selectQueryTab(bundle.store.getState(), "a")?.saved.filter).toEqual({
      custom: "jazz",
      presets: [],
    });
  });

  it("writes only the last of a burst of edits", async () => {
    bundle.actions.setFilterCustom("a", "j");
    await vi.advanceTimersByTimeAsync(IDLE - 1000);
    bundle.actions.setFilterCustom("a", "ja");
    await vi.advanceTimersByTimeAsync(IDLE - 1000);
    bundle.actions.setFilterCustom("a", "jazz");
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(written()).toEqual(["jazz"]);
  });

  it("waits for requests to the backend to settle, then for quiet after them", async () => {
    bundle.actions.setFilterCustom("a", "jazz");
    let settle = () => {};
    bundle.actions.noteRequest(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(sourceUpdateDefinition).not.toHaveBeenCalled();
    settle();
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(sourceUpdateDefinition).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(written()).toEqual(["jazz"]);
  });

  it("keeps an unsaved query's edits in its tab", async () => {
    bundle.actions.newQueryTab();
    const id = bundle.store.getState().activeTabId!;
    bundle.actions.setFilterCustom(id, "jazz");
    await vi.advanceTimersByTimeAsync(IDLE * 2);
    expect(sourceUpdateDefinition).not.toHaveBeenCalled();
  });

  it("shows Save after a failed write, and Save tries again at once", async () => {
    vi.mocked(sourceUpdateDefinition).mockRejectedValueOnce(new Error("500"));
    bundle.actions.setFilterCustom("a", "jazz");
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(selectIsUnsaved(bundle.store.getState(), "a")).toBe(true);
    expect(selectQueryTab(bundle.store.getState(), "a")?.saveFailed).toBe(true);

    bundle.actions.saveQuery("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(written()).toEqual(["jazz", "jazz"]);
    expect(selectIsUnsaved(bundle.store.getState(), "a")).toBe(false);
  });

  it("sends a closed tab's pending write at once", async () => {
    bundle.actions.setFilterCustom("a", "jazz");
    bundle.actions.closeTab("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(written()).toEqual(["jazz"]);
  });

  it("drops a deleted query's pending write", async () => {
    bundle.actions.setFilterCustom("a", "jazz");
    bundle.actions.requestDelete("a");
    bundle.actions.confirmDelete();
    await vi.advanceTimersByTimeAsync(IDLE * 2);
    expect(sourceUpdateDefinition).not.toHaveBeenCalled();
  });

  it("saves a restored tab's edits the backend never acknowledged", async () => {
    const env = fakeEnv();
    const before = createAppStore(env);
    openQueryTab(before, "a");
    before.actions.setFilterCustom("a", "jazz");
    before.dispose(); // the page goes away before the write is sent
    expect(sourceUpdateDefinition).not.toHaveBeenCalled();

    const after = createAppStore(env);
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(written()).toEqual(["jazz"]);
    after.dispose();
  });
});

describe("undo and redo", () => {
  let bundle: AppStoreBundle;
  const filter = () =>
    selectQueryTab(bundle.store.getState(), "a")?.live.filter.custom;
  const can = () => ({
    undo: selectCanUndo(bundle.store.getState(), "a"),
    redo: selectCanRedo(bundle.store.getState(), "a"),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.ensureRun("a"); // the first checkpoint: the query as opened
  });
  afterEach(() => {
    bundle.dispose();
    vi.useRealTimers();
  });

  it("steps back and forth through the definitions the page has run", () => {
    expect(can()).toEqual({ undo: false, redo: false });
    bundle.actions.clearFilterCustom("a"); // runs, but changes nothing
    expect(can()).toEqual({ undo: false, redo: false });
    bundle.actions.toggleFilterPreset("a", "p1");
    bundle.actions.toggleFilterPreset("a", "p2");
    expect(can()).toEqual({ undo: true, redo: false });

    bundle.actions.undo("a");
    expect(
      selectQueryTab(bundle.store.getState(), "a")?.live.filter.presets,
    ).toEqual(["p1"]);
    expect(can()).toEqual({ undo: true, redo: true });
    bundle.actions.undo("a");
    expect(
      selectQueryTab(bundle.store.getState(), "a")?.live.filter.presets,
    ).toEqual([]);
    expect(can()).toEqual({ undo: false, redo: true });

    bundle.actions.redo("a");
    bundle.actions.redo("a");
    expect(
      selectQueryTab(bundle.store.getState(), "a")?.live.filter.presets,
    ).toEqual(["p1", "p2"]);
    expect(can()).toEqual({ undo: true, redo: false });
  });

  it("drops what was undone once something else runs", () => {
    bundle.actions.toggleFilterPreset("a", "p1");
    bundle.actions.undo("a");
    bundle.actions.toggleFilterPreset("a", "p2");
    expect(can()).toEqual({ undo: true, redo: false });
    bundle.actions.undo("a");
    expect(
      selectQueryTab(bundle.store.getState(), "a")?.live.filter.presets,
    ).toEqual([]);
  });

  it("undoes an edit still waiting on its run first, and can redo it", () => {
    bundle.actions.setFilterCustom("a", "jazz"); // debounced: not run yet
    expect(can()).toEqual({ undo: true, redo: false });
    bundle.actions.undo("a");
    expect(filter()).toBe("");
    expect(can()).toEqual({ undo: false, redo: true });
    bundle.actions.redo("a");
    expect(filter()).toBe("jazz");
  });

  it("checkpoints a debounced edit when its run fires", async () => {
    bundle.actions.setFilterCustom("a", "j");
    bundle.actions.setFilterCustom("a", "jazz");
    await vi.advanceTimersByTimeAsync(300);
    bundle.actions.undo("a");
    // One step: the keystrokes ran once, as one edit.
    expect(filter()).toBe("");
  });

  it("saves the definition it steps to, lazily", async () => {
    vi.mocked(sourceUpdateDefinition).mockReset();
    vi.mocked(sourceUpdateDefinition).mockResolvedValue(null);
    bundle.actions.toggleFilterPreset("a", "p1");
    bundle.actions.undo("a");
    expect(sourceUpdateDefinition).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sourceUpdateDefinition).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(vi.mocked(sourceUpdateDefinition).mock.calls[0][0].definition),
    ).toMatchObject({ filter: { custom: "", presets: [] } });
  });
});

describe("undo steps with entry writes", () => {
  // Steps are written to query tab "a": the history doesn't care which kind of
  // page it belongs to, and `dml` (mocked at the top of the file) stands in for
  // the backend, so the writes themselves are fake.
  let bundle: AppStoreBundle;
  const page = () => bundle.store.getState().pages["a"];
  const filter = () =>
    selectQueryTab(bundle.store.getState(), "a")?.live.filter.custom;
  const can = () => ({
    undo: selectCanUndo(bundle.store.getState(), "a"),
    redo: selectCanRedo(bundle.store.getState(), "a"),
  });
  /** The operations of each `dml` request sent, as `operation:id`. */
  const sent = () =>
    vi
      .mocked(dml)
      .mock.calls.map(([req]) =>
        req.operations.map(
          (op) =>
            `${op.operation}:${op.operation === "insert" ? op.values.id : op.where.id}`,
        ),
      );
  /** Removing entry `id`, and its undo. */
  const removal = (id: string): EntryWrites => ({
    apply: [{ operation: "delete", table: "playlist_track", where: { id } }],
    revert: [
      {
        operation: "insert",
        table: "playlist_track",
        values: { id, playlist: "p", track: "t", position: 1 },
      },
    ],
  });
  const prepared = (writes: EntryWrites, edit?: PreparedStep["edit"]) => () =>
    Promise.resolve({ writes, edit });
  /** Waits for the page's writes and its run to settle. */
  const settled = () =>
    vi.waitFor(() => {
      expect(page()?.writing).toBe(false);
      expect(page()?.running).toBe(false);
    });

  beforeEach(async () => {
    vi.mocked(dml).mockReset();
    vi.mocked(dml).mockResolvedValue({});
    vi.mocked(analyzeColumnSources).mockResolvedValue(undefined);
    vi.mocked(compileSavedQuery).mockReturnValue({
      sql: "select 1",
      columnAnnotations: [],
    });
    vi.mocked(buildResultFromArrow).mockReturnValue(
      buildResultFromStringRows([["1"], ["2"]]),
    );
    bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setSchemaJson("{}");
    bundle.actions.ensureRun("a"); // the first checkpoint: the query as opened
    await settled();
  });
  afterEach(() => {
    bundle.dispose();
  });

  it("records a step once its writes land, and undoes and redoes it", async () => {
    await expect(
      bundle.actions.writeStep("a", prepared(removal("e1"))),
    ).resolves.toBe(true);
    expect(sent()).toEqual([["delete:e1"]]);
    expect(can()).toEqual({ undo: true, redo: false });

    bundle.actions.undo("a");
    await settled();
    expect(sent()).toEqual([["delete:e1"], ["insert:e1"]]);
    expect(can()).toEqual({ undo: false, redo: true });

    bundle.actions.redo("a");
    await settled();
    expect(sent()).toEqual([["delete:e1"], ["insert:e1"], ["delete:e1"]]);
    expect(can()).toEqual({ undo: true, redo: false });
  });

  it("reloads the results as new rows, though the SQL is the same", async () => {
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    await bundle.actions.writeStep("a", prepared(removal("e1")));
    await settled();
    expect(page()?.resultIsRefresh).toBe(false);
    expect(page()?.selection).toBeUndefined();
  });

  it("records nothing when its writes fail", async () => {
    vi.mocked(dml).mockRejectedValueOnce(new Error("constraint"));
    await expect(
      bundle.actions.writeStep("a", prepared(removal("e1"))),
    ).resolves.toBe(false);
    expect(page()?.undo.steps).toEqual([]);
    expect(can()).toEqual({ undo: false, redo: false });
  });

  it("leaves the history where it was when an undo's writes fail", async () => {
    await bundle.actions.writeStep("a", prepared(removal("e1")));
    vi.mocked(dml).mockRejectedValueOnce(new Error("constraint"));
    bundle.actions.undo("a");
    await settled();
    expect(page()?.undo.index).toBe(1);
    expect(can()).toEqual({ undo: true, redo: false });

    bundle.actions.undo("a"); // and it can be tried again
    await settled();
    expect(page()?.undo.index).toBe(0);
    expect(sent()).toEqual([["delete:e1"], ["insert:e1"], ["insert:e1"]]);
  });

  it("runs queued writes one at a time, in order, and holds undo for them", async () => {
    let land!: () => void;
    vi.mocked(dml).mockImplementationOnce(
      () => new Promise((resolve) => (land = () => resolve({}))),
    );
    const first = bundle.actions.writeStep("a", prepared(removal("e1")));
    const second = bundle.actions.writeStep("a", prepared(removal("e2")));
    await vi.waitFor(() => expect(sent()).toEqual([["delete:e1"]]));
    expect(page()?.writing).toBe(true);
    bundle.actions.undo("a"); // waits on the writes: does nothing
    expect(sent()).toEqual([["delete:e1"]]);

    land();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(sent()).toEqual([["delete:e1"], ["delete:e2"]]);
    await settled();

    bundle.actions.undo("a");
    await settled();
    bundle.actions.undo("a");
    await settled();
    expect(sent().slice(2)).toEqual([["insert:e2"], ["insert:e1"]]);
    expect(can()).toEqual({ undo: false, redo: true });
  });

  it("applies a step's edit with its writes, and undoes them together", async () => {
    bundle.actions.setFilterCustom("a", "jazz"); // debounced: not run yet
    await bundle.actions.writeStep(
      "a",
      prepared(removal("e1"), (def) => {
        def.filter.custom = "";
      }),
    );
    await settled();
    expect(filter()).toBe("");
    // The edit made before the step is a step of its own.
    expect(
      page()?.undo.steps.map((s) => s.definition?.after.filter.custom),
    ).toEqual(["jazz", ""]);

    bundle.actions.undo("a");
    await settled();
    expect(filter()).toBe("jazz");
    expect(sent()).toEqual([["delete:e1"], ["insert:e1"]]);

    bundle.actions.undo("a"); // the edit alone: no writes
    expect(filter()).toBe("");
    expect(sent()).toHaveLength(2);
  });
});

describe("playlist tabs", () => {
  const SOURCE = "00000000-0000-0000-0000-0000000000c1";
  const PLAYLIST = "00000000-0000-0000-0000-0000000000d1";
  const ENTRY = "00000000-0000-0000-0000-0000000000b1";
  let bundle: AppStoreBundle;

  function openPlaylistTab(definition = "{}") {
    bundle.actions.openTab({
      id: SOURCE,
      name: "Road trip",
      definition,
      kind: "playlist",
      playlistId: PLAYLIST,
    });
  }

  /** Runs `tabId`'s page and waits for its rows to land. */
  async function run(tabId: string) {
    bundle.actions.runQuery(tabId);
    await vi.waitFor(() =>
      expect(bundle.store.getState().pages[tabId]?.running).toBe(false),
    );
  }

  beforeEach(() => {
    vi.mocked(compileSavedQuery).mockClear();
    vi.mocked(compilePlaylist).mockClear();
    vi.mocked(analyzeColumnSources).mockResolvedValue(undefined);
    vi.mocked(buildResultFromArrow).mockReturnValue(
      buildResultFromStringRows([[ENTRY, "1", "t1"]]),
    );
    bundle = createAppStore(fakeEnv());
    bundle.actions.setSchemaJson("{}");
  });
  afterEach(() => bundle.dispose());

  it("opens a playlist source in a playlist tab, with no unsaved state", () => {
    openPlaylistTab(
      JSON.stringify({
        filter: { custom: "jazz", presets: [] },
        sort: { builtin: { preset: "playlist_order" } },
        display: { custom: "$title" },
      }),
    );
    const t = selectPageTab(bundle.store.getState(), SOURCE);
    expect(t).toMatchObject({
      kind: "playlist",
      playlistId: PLAYLIST,
      name: "Road trip",
    });
    expect(t?.live.filter.custom).toBe("jazz");
    expect(selectQueryTab(bundle.store.getState(), SOURCE)).toBeUndefined();
    expect(selectIsUnsaved(bundle.store.getState(), SOURCE)).toBe(false);
  });

  it("compiles each tab as its kind calls for", async () => {
    openPlaylistTab();
    openQueryTab(bundle, "q");
    await run(SOURCE);
    await run("q");
    expect(compilePlaylist).toHaveBeenCalledTimes(1);
    expect(vi.mocked(compilePlaylist).mock.calls[0][0]).toBe(PLAYLIST);
    expect(compileSavedQuery).toHaveBeenCalledTimes(1);
  });

  it("leaves the entries out of what a playlist page's rows edit", async () => {
    const entries = {
      table: "playlist_track",
      keyColumns: ["id"],
      keyIndices: [0],
    };
    const tracks = { table: "track", keyColumns: ["id"], keyIndices: [2] };
    vi.mocked(analyzeColumnSources).mockResolvedValue([]);
    vi.mocked(recordKeyColumns).mockReturnValue([entries, tracks]);
    openPlaylistTab();
    openQueryTab(bundle, "q");
    await run(SOURCE);
    await run("q");
    await vi.waitFor(() => {
      expect(bundle.store.getState().pages[SOURCE]?.lineage?.records).toEqual([
        tracks,
      ]);
      // A query of entries still edits them.
      expect(bundle.store.getState().pages["q"]?.lineage?.records).toEqual([
        entries,
        tracks,
      ]);
    });
    vi.mocked(recordKeyColumns).mockReturnValue([]);
  });

  it("re-reads a row by the entry it lists", () => {
    openPlaylistTab();
    bundle.actions.setResults(
      SOURCE,
      buildResultFromStringRows([[ENTRY, "1", "t1"]]),
      {
        records: [{ table: "track", keyColumns: ["id"], keyIndices: [2] }],
      },
    );
    expect(selectRowContext(bundle.store.getState(), SOURCE, 0)).toMatchObject({
      kind: "playlist",
      playlistId: PLAYLIST,
      entryId: ENTRY,
    });
  });

  it("saves its definition through the source, and undoes an edit", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sourceUpdateDefinition).mockReset();
      vi.mocked(sourceUpdateDefinition).mockResolvedValue(null);
      openPlaylistTab();
      await vi.advanceTimersByTimeAsync(0);
      bundle.actions.runQuery(SOURCE);
      bundle.actions.setFilterCustom(SOURCE, "jazz");
      bundle.actions.runQuery(SOURCE);
      await vi.advanceTimersByTimeAsync(5000);
      const [params] = vi.mocked(sourceUpdateDefinition).mock.calls[0];
      expect(params.id).toBe(SOURCE);
      // A playlist's definition has no base and no full mode.
      expect(JSON.parse(params.definition)).toEqual({
        filter: { custom: "jazz", presets: [] },
        sort: { builtin: { preset: "playlist_order" } },
        display: { custom: "" },
      });

      expect(selectCanUndo(bundle.store.getState(), SOURCE)).toBe(true);
      bundle.actions.undo(SOURCE);
      expect(
        selectPageTab(bundle.store.getState(), SOURCE)?.live.filter.custom,
      ).toBe("");
      expect(selectCanRedo(bundle.store.getState(), SOURCE)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renames, as a saved query does", () => {
    openPlaylistTab();
    bundle.actions.beginRename(SOURCE);
    bundle.actions.setRenameBuffer("Long drive");
    bundle.actions.commitRename();
    expect(selectPageTab(bundle.store.getState(), SOURCE)?.name).toBe(
      "Long drive",
    );
    expect(vi.mocked(sourceRename)).toHaveBeenCalledWith({
      id: SOURCE,
      name: "Long drive",
    });
  });
});

describe("creating and managing playlists", () => {
  const FOLDER = "00000000-0000-0000-0000-0000000000f1";
  const PLAYLIST = "00000000-0000-0000-0000-0000000000d1";
  let bundle: AppStoreBundle;

  const source = (over: Partial<Source>): Source => ({
    id: "q",
    kind: "query",
    name: "q",
    createdAt: 0,
    modifiedAt: 0,
    lastPlay: 0,
    definition: "{}",
    parent: null,
    position: 0,
    queryId: "query-q",
    playlistId: null,
    ...over,
  });
  /** A playlist "Road trip" in `FOLDER`, beside query "q" there. */
  const roadTrip = source({
    id: "p",
    kind: "playlist",
    name: "Road trip",
    definition: JSON.stringify({
      filter: { custom: "jazz", presets: [] },
      sort: { builtin: { preset: "playlist_order" } },
      display: { custom: "$title" },
    }),
    parent: FOLDER,
    position: 3,
    queryId: null,
    playlistId: PLAYLIST,
  });

  /** The operations of each `dml` request sent, as `operation:table`. */
  const sent = () =>
    vi
      .mocked(dml)
      .mock.calls.map(([req]) =>
        req.operations.map((op) => `${op.operation}:${op.table}`),
      );
  /** The values of the `table` inserts in `dml` request `n`. */
  const inserted = (n: number, table: string) =>
    vi
      .mocked(dml)
      .mock.calls[n][0].operations.flatMap((op) =>
        op.operation === "insert" && op.table === table ? [op.values] : [],
      );
  /** Waits for `dml` to have been sent `n` times, and its effects to land. */
  const sentTimes = (n: number) =>
    vi.waitFor(() => expect(vi.mocked(dml)).toHaveBeenCalledTimes(n));

  beforeEach(() => {
    vi.mocked(dml).mockReset();
    vi.mocked(dml).mockResolvedValue({});
    vi.mocked(fetchPlaylistEntries).mockReset();
    vi.mocked(fetchPlaylistEntries).mockResolvedValue([]);
    bundle = createAppStore(fakeEnv());
    bundle.store.setState((s) => {
      s.sources = {
        status: "ready",
        data: [source({ parent: FOLDER, position: 2 }), roadTrip],
      };
      s.folders = {
        status: "ready",
        data: [{ id: FOLDER, name: "Mixes", parent: null, position: 0 }],
      };
    });
  });
  afterEach(() => bundle.dispose());

  it("adds an empty playlist at the top of its folder, and opens it once saved", async () => {
    bundle.actions.addPlaylist(FOLDER);
    // Nothing is listed or opened before the backend has it.
    expect(bundle.store.getState().tabs).toHaveLength(0);
    await vi.waitFor(() =>
      expect(bundle.store.getState().tabs).toHaveLength(1),
    );
    expect(sent()).toEqual([["insert:playlist", "insert:source"]]);
    const s = bundle.store.getState();
    const added = s.sources.data[0];
    expect(added).toMatchObject({
      kind: "playlist",
      parent: FOLDER,
      position: 1,
      queryId: null,
    });
    expect(added.name).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    const [playlistRow] = inserted(0, "playlist");
    const [sourceRow] = inserted(0, "source");
    expect(playlistRow).toEqual({
      id: added.playlistId,
      definition: added.definition,
    });
    expect(sourceRow).toMatchObject({
      id: added.id,
      name: added.name,
      source_folder: FOLDER,
      position: 1,
      playlist: added.playlistId,
    });
    // No filter, "Playlist order", and (with no presets loaded) an empty
    // display.
    expect(JSON.parse(added.definition)).toEqual({
      filter: { custom: "", presets: [] },
      sort: { builtin: { preset: "playlist_order" } },
      display: { custom: "" },
    });
    expect(s.activeTabId).toBe(added.id);
    expect(selectPageTab(s, added.id)).toMatchObject({
      kind: "playlist",
      playlistId: added.playlistId,
      name: added.name,
    });
    expect(selectIsUnsaved(s, added.id)).toBe(false);
    expect(s.expandedFolders.has(FOLDER)).toBe(true);
  });

  it("adds nothing when the backend turns a new playlist down", async () => {
    vi.mocked(dml).mockRejectedValueOnce(new Error("500 nope"));
    bundle.actions.addPlaylist(null);
    await sentTimes(1);
    await Promise.resolve();
    const s = bundle.store.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.sources.data.map((x) => x.id)).toEqual(["q", "p"]);
  });

  it("duplicates a playlist with its entries, at the top of its folder", async () => {
    vi.mocked(fetchPlaylistEntries).mockResolvedValue([
      { id: "e1", track: "t1", position: 1 },
      { id: "e2", track: "t1", position: 2.5 },
    ]);
    bundle.actions.duplicatePlaylist("p");
    await vi.waitFor(() =>
      expect(bundle.store.getState().tabs).toHaveLength(1),
    );
    expect(fetchPlaylistEntries).toHaveBeenCalledWith(PLAYLIST);
    expect(sent()).toEqual([
      [
        "insert:playlist",
        "insert:source",
        "insert:playlist_track",
        "insert:playlist_track",
      ],
    ]);
    const copy = bundle.store.getState().sources.data[0];
    expect(copy).toMatchObject({
      kind: "playlist",
      name: "Road trip",
      parent: FOLDER,
      position: 1,
    });
    expect(copy.id).not.toBe("p");
    expect(copy.playlistId).not.toBe(PLAYLIST);
    expect(JSON.parse(copy.definition)).toEqual(
      JSON.parse(roadTrip.definition),
    );
    // Same tracks and positions, under new ids.
    const entries = inserted(0, "playlist_track");
    expect(entries.map((e) => [e.playlist, e.track, e.position])).toEqual([
      [copy.playlistId, "t1", 1],
      [copy.playlistId, "t1", 2.5],
    ]);
    expect(entries.map((e) => e.id)).not.toContain("e1");
    expect(bundle.store.getState().activeTabId).toBe(copy.id);
  });

  it("duplicates an open playlist's working definition", async () => {
    bundle.actions.openTab(roadTrip);
    bundle.actions.setFilterCustom("p", "blues");
    bundle.actions.duplicatePlaylist("p");
    await vi.waitFor(() =>
      expect(bundle.store.getState().tabs).toHaveLength(2),
    );
    const copy = bundle.store.getState().sources.data[0];
    expect(JSON.parse(copy.definition).filter.custom).toBe("blues");
  });

  it("deletes a playlist's entries, source and record, and closes its tab", async () => {
    vi.mocked(fetchPlaylistEntries).mockResolvedValue([
      { id: "e1", track: "t1", position: 1 },
      { id: "e2", track: "t2", position: 2 },
    ]);
    bundle.actions.openTab(roadTrip);
    bundle.actions.requestDelete("p");
    expect(bundle.store.getState().pendingDelete).toEqual({
      id: "p",
      kind: "playlist",
      name: "Road trip",
      unsaved: false,
    });
    bundle.actions.confirmDelete();
    const s = bundle.store.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.sources.data.map((x) => x.id)).toEqual(["q"]);
    await sentTimes(1);
    expect(vi.mocked(dml).mock.calls[0][0].operations).toMatchObject([
      { operation: "delete", table: "playlist_track", where: { id: "e1" } },
      { operation: "delete", table: "playlist_track", where: { id: "e2" } },
      { operation: "delete", table: "source", where: { id: "p" } },
      { operation: "delete", table: "playlist", where: { id: PLAYLIST } },
    ]);
    expect(vi.mocked(queryDelete)).not.toHaveBeenCalledWith({ id: "p" });
  });

  describe("converting a query", () => {
    const TRACKS = { records: [], trackIdColumn: 0 };

    /** Opens query "q" (a query of tracks) with rows of these track ids. */
    function openQuery(rows: string[][], base = "track") {
      bundle.actions.openTab(
        source({
          parent: FOLDER,
          definition: JSON.stringify({
            base,
            filter: { custom: "", presets: [] },
            sort: { custom: "" },
            display: { custom: "$title" },
          }),
        }),
      );
      bundle.actions.setResults("q", buildResultFromStringRows(rows), TRACKS);
    }

    it("saves the rows' tracks in the order shown, beside the query's tab", async () => {
      bundle.actions.openTab(roadTrip);
      bundle.actions.selectTab("p");
      openQuery([["t2"], [""], ["t1"], ["t2"]]);
      // The playlist's tab, then the query's — the new one goes between them
      // and the end.
      bundle.actions.reorderTab("q", 0);
      expect(selectCanConvertToPlaylist(bundle.store.getState(), "q")).toBe(
        true,
      );
      bundle.actions.convertToPlaylist("q");
      await vi.waitFor(() =>
        expect(bundle.store.getState().tabs).toHaveLength(3),
      );
      const s = bundle.store.getState();
      const added = s.sources.data[0];
      expect(added).toMatchObject({
        kind: "playlist",
        name: "q",
        parent: FOLDER,
        position: 1,
      });
      expect(s.tabs.map((t) => t.id)).toEqual(["q", added.id, "p"]);
      expect(s.activeTabId).toBe(added.id);
      // A row without a track is left out; a repeated track is listed twice.
      expect(
        inserted(0, "playlist_track").map((e) => [e.track, e.position]),
      ).toEqual([
        ["t2", 1],
        ["t1", 2],
        ["t2", 3],
      ]);
      // No filter and "Playlist order"; the display is the query's.
      expect(JSON.parse(added.definition)).toEqual({
        filter: { custom: "", presets: [] },
        sort: { builtin: { preset: "playlist_order" } },
        display: { custom: "$title" },
      });
      // The query is left as it was.
      expect(s.sources.data.find((x) => x.id === "q")).toBeDefined();
      expect(selectQueryTab(s, "q")?.live.base).toBe("track");
    });

    it("names an unsaved query's playlist for the moment, at the top level", async () => {
      bundle.actions.newQueryTab();
      const id = bundle.store.getState().activeTabId!;
      bundle.actions.setResults(
        id,
        buildResultFromStringRows([["t1"]]),
        TRACKS,
      );
      bundle.actions.convertToPlaylist(id);
      await vi.waitFor(() =>
        expect(bundle.store.getState().tabs).toHaveLength(2),
      );
      const added = bundle.store.getState().sources.data[0];
      expect(added.name).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
      expect(added.parent).toBeNull();
    });

    it("isn't available unless the rows on screen are the query's tracks", async () => {
      const can = (id: string) =>
        selectCanConvertToPlaylist(bundle.store.getState(), id);
      openQuery([["t1"]]);
      expect(can("q")).toBe(true);

      // Rows that aren't tracks.
      bundle.actions.setResults("q", buildResultFromStringRows([["x"]]), {
        records: [],
      });
      expect(can("q")).toBe(false);

      // A run in flight, then a failed one.
      bundle.actions.setSchemaJson("{}");
      bundle.actions.setResults(
        "q",
        buildResultFromStringRows([["t1"]]),
        TRACKS,
      );
      vi.mocked(compileSavedQuery).mockImplementationOnce(() => {
        throw new Error("Invalid querydown code");
      });
      bundle.actions.runQuery("q");
      expect(can("q")).toBe(false);
      await vi.waitFor(() =>
        expect(bundle.store.getState().pages["q"]?.running).toBe(false),
      );
      expect(bundle.store.getState().pages["q"]?.runFailed).toBe(true);
      expect(can("q")).toBe(false);
      bundle.actions.convertToPlaylist("q");
      expect(vi.mocked(dml)).not.toHaveBeenCalled();

      // A playlist page is never converted.
      bundle.actions.openTab(roadTrip);
      bundle.actions.setResults(
        "p",
        buildResultFromStringRows([["t1"]]),
        TRACKS,
      );
      expect(can("p")).toBe(false);
    });
  });
});

describe("removing tracks and committing conditions", () => {
  const SOURCE = "00000000-0000-0000-0000-0000000000c1";
  const PLAYLIST = "00000000-0000-0000-0000-0000000000d1";
  let bundle: AppStoreBundle;

  /** The playlist's entries as stored: e1…e4, holding tracks t1…t4 (t2 twice,
   * in e2 and e4), at positions 1…4. */
  const ENTRIES = [
    { id: "e1", track: "t1", position: 1 },
    { id: "e2", track: "t2", position: 2 },
    { id: "e3", track: "t3", position: 3 },
    { id: "e4", track: "t2", position: 4 },
  ];
  /** The rows the page shows: its entries' `$id` and `$position` columns, then
   * the track. */
  let pageRows: string[][];
  /** The rows a commit's read gets back: the entries in sorted order. */
  let sortedRows: string[][];

  const page = () => bundle.store.getState().pages[SOURCE];
  const live = () => selectPageTab(bundle.store.getState(), SOURCE)?.live;
  /** Each `dml` request's operations, as `operation:id` (and `=position` for
   * an update). */
  const sent = () =>
    vi
      .mocked(dml)
      .mock.calls.map(([req]) =>
        req.operations.map((op) =>
          op.operation === "insert"
            ? `insert:${String(op.values.id)}@${String(op.values.position)}`
            : op.operation === "update"
              ? `update:${op.where.id}=${String(op.values.position)}`
              : `delete:${op.where.id}`,
        ),
      );
  /** Waits for the page's writes and its run to settle. */
  const settled = () =>
    vi.waitFor(() => {
      expect(page()?.writing).toBe(false);
      expect(page()?.running).toBe(false);
    });

  /** Opens the playlist on `def` and runs it, with `rows` on screen. */
  async function open(def: object, rows: string[][]) {
    pageRows = rows;
    bundle.actions.openTab({
      id: SOURCE,
      name: "Road trip",
      definition: JSON.stringify(def),
      kind: "playlist",
      playlistId: PLAYLIST,
    });
    bundle.actions.ensureRun(SOURCE);
    await settled();
  }

  const PLAIN = {
    filter: { custom: "", presets: [] },
    sort: { builtin: { preset: "playlist_order" } },
    display: { custom: "$title" },
  };
  const FILTERED = { ...PLAIN, filter: { custom: "jazz", presets: [] } };
  const SORTED = { ...FILTERED, sort: { custom: "\\\\title" } };

  beforeEach(() => {
    vi.mocked(dml).mockReset();
    vi.mocked(dml).mockResolvedValue({});
    vi.mocked(fetchPlaylistEntries).mockReset();
    vi.mocked(fetchPlaylistEntries).mockResolvedValue(ENTRIES);
    vi.mocked(analyzeColumnSources).mockResolvedValue(undefined);
    // The page's run and a commit's read are told apart by their SQL, which
    // `runSql` hands on as the "table" the result is built from.
    vi.mocked(compilePlaylist).mockReset();
    vi.mocked(compilePlaylist).mockImplementation(
      (_id, _def, _presets, _schema, _prelude, options) => ({
        sql: options?.withFilter === false ? "sorted" : "page",
        columnAnnotations: [],
      }),
    );
    vi.mocked(runSql).mockImplementation((sql) =>
      Promise.resolve({ sql } as never),
    );
    vi.mocked(buildResultFromArrow).mockImplementation((table) =>
      buildResultFromStringRows(
        (table as unknown as { sql: string }).sql === "sorted"
          ? sortedRows
          : pageRows,
      ),
    );
    bundle = createAppStore(fakeEnv());
    bundle.actions.setSchemaJson("{}");
  });
  afterEach(() => {
    bundle.dispose();
    vi.mocked(runSql).mockReset();
    vi.mocked(runSql).mockResolvedValue({} as never);
    vi.mocked(buildResultFromArrow).mockReset();
    vi.mocked(buildResultFromArrow).mockReturnValue(
      buildResultFromStringRows([["r"]]),
    );
  });

  describe("removing rows", () => {
    const ALL_ROWS = ENTRIES.map((e) => [e.id, String(e.position), e.track]);

    it("deletes the rows' entries in one request, and undoes it", async () => {
      await open(PLAIN, ALL_ROWS);
      bundle.actions.clickRow(SOURCE, 1, { shift: false, ctrl: false });
      bundle.actions.clickRow(SOURCE, 3, { shift: false, ctrl: true });
      bundle.actions.removeRows(SOURCE, [1, 3]);
      await settled();
      expect(sent()).toEqual([["delete:e2", "delete:e4"]]);
      // Reloaded as new rows.
      expect(page()?.selection).toBeUndefined();

      bundle.actions.undo(SOURCE);
      await settled();
      // Re-inserted whole, with their ids and positions.
      expect(sent()[1]).toEqual(["insert:e2@2", "insert:e4@4"]);
      expect(inserted(1)).toEqual([
        { id: "e2", playlist: PLAYLIST, track: "t2", position: 2 },
        { id: "e4", playlist: PLAYLIST, track: "t2", position: 4 },
      ]);
    });

    it("skips entries that are already gone", async () => {
      await open(PLAIN, ALL_ROWS);
      vi.mocked(fetchPlaylistEntries).mockResolvedValue(
        ENTRIES.filter((e) => e.id !== "e2"),
      );
      bundle.actions.removeRows(SOURCE, [0, 1]);
      await settled();
      expect(sent()).toEqual([["delete:e1"]]);

      bundle.actions.removeRows(SOURCE, [1]); // e2 alone: nothing to do
      await settled();
      expect(sent()).toHaveLength(1);
      expect(page()?.undo.steps).toHaveLength(1);
    });

    it("does nothing on a query's page", async () => {
      openQueryTab(bundle, "q");
      bundle.actions.setResults("q", buildResultFromStringRows(ALL_ROWS));
      bundle.actions.removeRows("q", [0]);
      await Promise.resolve();
      expect(fetchPlaylistEntries).not.toHaveBeenCalled();
      expect(dml).not.toHaveBeenCalled();
    });
  });

  /** The values of the inserts in `dml` request `n`. */
  const inserted = (n: number) =>
    vi
      .mocked(dml)
      .mock.calls[n][0].operations.flatMap((op) =>
        op.operation === "insert" ? [op.values] : [],
      );

  describe("the filter's buttons", () => {
    /** "jazz" matches e1 and e3. */
    const MATCHED = [
      ["e1", "1", "t1"],
      ["e3", "3", "t3"],
    ];

    it("removes every matching entry, then clears the filter, as one step", async () => {
      await open(FILTERED, MATCHED);
      bundle.actions.removeMatching(SOURCE);
      await settled();
      expect(sent()).toEqual([["delete:e1", "delete:e3"]]);
      expect(live()?.filter).toEqual({ custom: "", presets: [] });

      bundle.actions.undo(SOURCE);
      await settled();
      expect(sent()[1]).toEqual(["insert:e1@1", "insert:e3@3"]);
      expect(live()?.filter.custom).toBe("jazz");
    });

    it("keeps only the matching entries", async () => {
      await open(FILTERED, MATCHED);
      bundle.actions.keepMatching(SOURCE);
      await settled();
      expect(sent()).toEqual([["delete:e2", "delete:e4"]]);
      expect(live()?.filter.custom).toBe("");
    });

    it("clears the filter without a request when there's nothing to remove", async () => {
      await open(
        FILTERED,
        ENTRIES.map((e) => [e.id, String(e.position), e.track]),
      );
      bundle.actions.keepMatching(SOURCE);
      await vi.waitFor(() => expect(live()?.filter.custom).toBe(""));
      await settled();
      expect(dml).not.toHaveBeenCalled();
      bundle.actions.undo(SOURCE);
      expect(live()?.filter.custom).toBe("jazz");
    });

    /** Neither button wrote, or even read the entries. */
    const stoodDown = async () => {
      bundle.actions.removeMatching(SOURCE);
      bundle.actions.keepMatching(SOURCE);
      await Promise.resolve();
      expect(fetchPlaylistEntries).not.toHaveBeenCalled();
      expect(dml).not.toHaveBeenCalled();
    };

    it("stand down when no filter applies", async () => {
      await open(PLAIN, MATCHED);
      await stoodDown();
    });

    it("stand down after a failed run", async () => {
      await open(FILTERED, MATCHED);
      bundle.store.setState((s) => {
        s.pages[SOURCE]!.runFailed = true;
      });
      await stoodDown();
    });

    it("stand down while a run is going", async () => {
      await open(FILTERED, MATCHED);
      bundle.actions.runQuery(SOURCE);
      expect(page()?.running).toBe(true);
      await stoodDown();
      await settled();
    });

    it("stand down while an edit waits on its run", async () => {
      await open(FILTERED, MATCHED);
      bundle.actions.setFilterCustom(SOURCE, "jazz fusion"); // debounced
      await stoodDown();
      await vi.waitFor(() =>
        expect(selectCanWriteFromRows(bundle.store.getState(), SOURCE)).toBe(
          true,
        ),
      );
    });

    it("don't remove what matched nothing", async () => {
      await open(FILTERED, []);
      bundle.actions.removeMatching(SOURCE);
      await Promise.resolve();
      expect(fetchPlaylistEntries).not.toHaveBeenCalled();
      // Keeping only nothing is still something.
      bundle.actions.keepMatching(SOURCE);
      await settled();
      expect(sent()).toEqual([
        ["delete:e1", "delete:e2", "delete:e3", "delete:e4"],
      ]);
    });
  });

  describe("committing a sort", () => {
    it("renumbers every entry in the sorted order, unfiltered, then resets the sort", async () => {
      await open(SORTED, [["e3", "3", "t3"]]);
      sortedRows = [
        ["e3", "3"],
        ["e1", "1"],
        ["e4", "4"],
        ["e2", "2"],
      ];
      bundle.actions.commitSort(SOURCE);
      await settled();
      // Read without the filter, and without the display.
      const read = vi
        .mocked(compilePlaylist)
        .mock.calls.find((call) => call[5]?.withFilter === false);
      expect(read?.[1].display).toEqual({ custom: "" });
      expect(read?.[1].sort).toEqual({ custom: "\\\\title" });
      expect(sent()).toEqual([
        ["update:e3=1", "update:e1=2", "update:e4=3", "update:e2=4"],
      ]);
      expect(live()?.sort).toEqual({ builtin: { preset: "playlist_order" } });
      expect(live()?.filter.custom).toBe("jazz");

      bundle.actions.undo(SOURCE);
      await settled();
      expect(sent()[1]).toEqual([
        "update:e3=3",
        "update:e1=1",
        "update:e4=4",
        "update:e2=2",
      ]);
      expect(live()?.sort).toEqual({ custom: "\\\\title" });
    });

    it("leaves out entries already in their place", async () => {
      await open(SORTED, [["e3", "3", "t3"]]);
      sortedRows = [
        ["e1", "1"],
        ["e3", "3"],
        ["e2", "2"],
        ["e4", "4"],
      ];
      bundle.actions.commitSort(SOURCE);
      await settled();
      expect(sent()).toEqual([["update:e3=2", "update:e2=3"]]);
    });

    it("does nothing without a sort", async () => {
      await open(FILTERED, [["e3", "3", "t3"]]);
      bundle.actions.commitSort(SOURCE);
      await Promise.resolve();
      expect(
        vi
          .mocked(compilePlaylist)
          .mock.calls.some((call) => call[5]?.withFilter === false),
      ).toBe(false);
      expect(dml).not.toHaveBeenCalled();
    });
  });

  it("reads which conditions apply", async () => {
    await open(PLAIN, []);
    const s = () => bundle.store.getState();
    expect(selectFilterApplied(s(), SOURCE)).toBe(false);
    expect(selectSortApplied(s(), SOURCE)).toBe(false);
    bundle.actions.toggleFilterPreset(SOURCE, "p1");
    expect(selectFilterApplied(s(), SOURCE)).toBe(true);
    bundle.actions.setSectionCustomText(SOURCE, "sort", "  ");
    expect(selectSortApplied(s(), SOURCE)).toBe(false);
    bundle.actions.setSectionCustomText(SOURCE, "sort", "\\\\title");
    expect(selectSortApplied(s(), SOURCE)).toBe(true);
  });
});

describe("adding tracks to a playlist", () => {
  const SOURCE = "00000000-0000-0000-0000-0000000000c1";
  const PLAYLIST = "00000000-0000-0000-0000-0000000000d1";
  let bundle: AppStoreBundle;

  const playlist: Source = {
    id: SOURCE,
    kind: "playlist",
    name: "Road trip",
    createdAt: 0,
    modifiedAt: 0,
    lastPlay: 0,
    definition: "{}",
    parent: null,
    position: 0,
    queryId: null,
    playlistId: PLAYLIST,
  };
  const TRACKS = { records: [], trackIdColumn: 0 };

  const page = () => bundle.store.getState().pages[SOURCE];
  const pending = () => bundle.store.getState().pendingAddToPlaylist;
  /** Each `dml` request's inserts, as `track@position` into `playlist`. */
  const sent = () =>
    vi
      .mocked(dml)
      .mock.calls.map(([req]) =>
        req.operations.map((op) =>
          op.operation === "insert"
            ? `${String(op.values.track)}@${String(op.values.position)} in ${String(op.values.playlist)}`
            : op.operation,
        ),
      );
  /** Waits for the playlist's page's writes and its run to settle. */
  const settled = () =>
    vi.waitFor(() => {
      expect(page()?.writing).toBe(false);
      expect(page()?.running).toBe(false);
    });

  beforeEach(() => {
    vi.mocked(dml).mockReset();
    vi.mocked(dml).mockResolvedValue({});
    vi.mocked(fetchMaxPosition).mockReset();
    vi.mocked(fetchMaxPosition).mockResolvedValue(4.5);
    vi.mocked(compilePlaylist).mockClear();
    vi.mocked(analyzeColumnSources).mockResolvedValue(undefined);
    bundle = createAppStore(fakeEnv());
    bundle.actions.setSchemaJson("{}");
    bundle.store.setState((s) => {
      s.sources = { status: "ready", data: [playlist] };
    });
  });
  afterEach(() => bundle.dispose());

  it("adds the rows' tracks in the order shown, after the last entry", async () => {
    openQueryTab(bundle, "q");
    bundle.actions.setResults(
      "q",
      buildResultFromStringRows([["t2"], [""], ["t1"], ["t2"]]),
      TRACKS,
    );
    // Selected out of order; the row without a track is left out.
    bundle.actions.requestAddToPlaylist("q", new Set([3, 1, 0, 2]));
    expect(pending()).toEqual({ fromTabId: "q", trackIds: ["t2", "t1", "t2"] });

    bundle.actions.confirmAddToPlaylist(SOURCE);
    expect(pending()).toBeNull();
    await vi.waitFor(() => expect(dml).toHaveBeenCalledTimes(1));
    expect(fetchMaxPosition).toHaveBeenCalledWith(PLAYLIST);
    // One above the ceiling of 4.5, then consecutive.
    expect(sent()).toEqual([
      [`t2@6 in ${PLAYLIST}`, `t1@7 in ${PLAYLIST}`, `t2@8 in ${PLAYLIST}`],
    ]);
  });

  it("raises no dialog for rows without tracks", () => {
    openQueryTab(bundle, "q");
    bundle.actions.setResults("q", buildResultFromStringRows([["x"]]), {
      records: [],
    });
    bundle.actions.requestAddToPlaylist("q", [0]);
    expect(pending()).toBeNull();
  });

  it("closes the dialog without adding anything when cancelled", () => {
    openQueryTab(bundle, "q");
    bundle.actions.setResults("q", buildResultFromStringRows([["t1"]]), TRACKS);
    bundle.actions.requestAddToPlaylist("q", [0]);
    bundle.actions.cancelAddToPlaylist();
    expect(pending()).toBeNull();
    bundle.actions.confirmAddToPlaylist(SOURCE);
    expect(fetchMaxPosition).not.toHaveBeenCalled();
    expect(dml).not.toHaveBeenCalled();
  });

  it("reloads the playlist's open page as new rows, outside its history", async () => {
    bundle.actions.openTab(playlist);
    bundle.actions.ensureRun(SOURCE);
    await settled();
    bundle.actions.clickRow(SOURCE, 0, { shift: false, ctrl: false });
    const runs = vi.mocked(compilePlaylist).mock.calls.length;

    const added = bundle.actions.addTracksToPlaylist(SOURCE, ["t9"]);
    // Undo and the page's writes stand down meanwhile.
    expect(page()?.writing).toBe(true);
    await added;
    await settled();
    expect(sent()).toEqual([[`t9@6 in ${PLAYLIST}`]]);
    expect(vi.mocked(compilePlaylist).mock.calls.length).toBe(runs + 1);
    expect(page()?.selection).toBeUndefined();
    expect(page()?.undo.steps).toHaveLength(0);
  });

  it("reloads nothing when the write fails", async () => {
    bundle.actions.openTab(playlist);
    bundle.actions.ensureRun(SOURCE);
    await settled();
    const runs = vi.mocked(compilePlaylist).mock.calls.length;
    vi.mocked(dml).mockRejectedValueOnce(new Error("refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await bundle.actions.addTracksToPlaylist(SOURCE, ["t9"]);
    await settled();
    expect(vi.mocked(compilePlaylist).mock.calls.length).toBe(runs);
    vi.mocked(console.error).mockRestore();
  });

  it("reads the last position only once the add ahead of it has landed", async () => {
    let land!: () => void;
    vi.mocked(dml).mockImplementationOnce(
      () => new Promise((resolve) => (land = () => resolve({}))),
    );
    const first = bundle.actions.addTracksToPlaylist(SOURCE, ["t1"]);
    const second = bundle.actions.addTracksToPlaylist(SOURCE, ["t2"]);
    await vi.waitFor(() => expect(dml).toHaveBeenCalledTimes(1));
    expect(fetchMaxPosition).toHaveBeenCalledTimes(1);

    vi.mocked(fetchMaxPosition).mockResolvedValueOnce(6);
    land();
    await Promise.all([first, second]);
    expect(sent()).toEqual([[`t1@6 in ${PLAYLIST}`], [`t2@7 in ${PLAYLIST}`]]);
  });

  it("does nothing for a source that isn't a playlist", async () => {
    bundle.store.setState((s) => {
      s.sources.data = [{ ...playlist, kind: "query", playlistId: null }];
    });
    await bundle.actions.addTracksToPlaylist(SOURCE, ["t1"]);
    expect(fetchMaxPosition).not.toHaveBeenCalled();
    expect(dml).not.toHaveBeenCalled();
  });
});

describe("dragging result rows", () => {
  const SOURCE = "00000000-0000-0000-0000-0000000000c1";
  const PLAYLIST = "00000000-0000-0000-0000-0000000000d1";
  const QUERY_SOURCE = "00000000-0000-0000-0000-0000000000c2";
  let bundle: AppStoreBundle;

  const playlist: Source = {
    id: SOURCE,
    kind: "playlist",
    name: "Road trip",
    createdAt: 0,
    modifiedAt: 0,
    lastPlay: 0,
    definition: "{}",
    parent: null,
    position: 0,
    queryId: null,
    playlistId: PLAYLIST,
  };
  const query: Source = {
    ...playlist,
    id: QUERY_SOURCE,
    kind: "query",
    queryId: "00000000-0000-0000-0000-0000000000e2",
    playlistId: null,
  };
  const TRACKS = { records: [], trackIdColumn: 0 };
  const plain = { shift: false, ctrl: false };

  const drag = () => bundle.store.getState().rowDrag;
  const selection = (tabId: string) =>
    [...(bundle.store.getState().pages[tabId]?.selection ?? [])].sort();

  /** A query tab "q" whose four rows hold tracks t1…t4. */
  function openTracks() {
    openQueryTab(bundle, "q");
    bundle.actions.setResults(
      "q",
      buildResultFromStringRows([["t1"], ["t2"], ["t3"], ["t4"]]),
      TRACKS,
    );
  }

  beforeEach(() => {
    vi.mocked(dml).mockReset();
    vi.mocked(dml).mockResolvedValue({});
    vi.mocked(fetchMaxPosition).mockReset();
    vi.mocked(fetchMaxPosition).mockResolvedValue(2);
    bundle = createAppStore(fakeEnv());
    bundle.store.setState((s) => {
      s.sources = { status: "ready", data: [playlist, query] };
    });
  });
  afterEach(() => bundle.dispose());

  it("picks up the selection the held row belongs to, in the order shown", () => {
    openTracks();
    bundle.actions.clickRow("q", 2, plain);
    bundle.actions.clickRow("q", 0, { shift: false, ctrl: true });
    expect(bundle.actions.beginRowDrag("q", 2)).toBe(true);
    expect(drag()).toEqual({
      fromTabId: "q",
      trackIds: ["t1", "t3"],
      entryIds: [],
      over: null,
      gap: null,
    });
    expect(selection("q")).toEqual([0, 2]);
  });

  it("selects a held row outside the selection alone first", () => {
    openTracks();
    bundle.actions.clickRow("q", 0, plain);
    bundle.actions.beginRowDrag("q", 3);
    expect(selection("q")).toEqual([3]);
    expect(drag()?.trackIds).toEqual(["t4"]);
  });

  it("adds a held row to the selection in multi-select mode", () => {
    openTracks();
    bundle.actions.setMultiSelect("q", true);
    bundle.actions.clickRow("q", 0, plain);
    bundle.actions.beginRowDrag("q", 2);
    expect(selection("q")).toEqual([0, 2]);
    expect(drag()?.trackIds).toEqual(["t1", "t3"]);
  });

  it("picks up nothing from rows that aren't tracks", () => {
    openQueryTab(bundle, "q");
    bundle.actions.setResults("q", buildResultFromStringRows([["x"]]), {
      records: [],
    });
    expect(bundle.actions.beginRowDrag("q", 0)).toBe(false);
    expect(drag()).toBeNull();
    expect(selection("q")).toEqual([]);
  });

  it("is taken only by a playlist", () => {
    openTracks();
    bundle.actions.beginRowDrag("q", 0);
    bundle.actions.hoverRowDrag(QUERY_SOURCE);
    expect(drag()?.over).toBeNull();
    bundle.actions.hoverRowDrag(SOURCE);
    expect(drag()?.over).toBe(SOURCE);
    bundle.actions.hoverRowDrag(null);
    expect(drag()?.over).toBeNull();
  });

  it("adds its tracks to the end of the playlist it's dropped on", async () => {
    openTracks();
    bundle.actions.clickRow("q", 1, plain);
    bundle.actions.clickRow("q", 3, { shift: true, ctrl: false });
    bundle.actions.beginRowDrag("q", 2);
    bundle.actions.hoverRowDrag(SOURCE);
    expect(bundle.actions.endRowDrag(true)).toBe(true);
    expect(drag()).toBeNull();
    await vi.waitFor(() => expect(dml).toHaveBeenCalledTimes(1));
    expect(fetchMaxPosition).toHaveBeenCalledWith(PLAYLIST);
    const inserted = vi
      .mocked(dml)
      .mock.calls[0][0].operations.map((op) =>
        op.operation === "insert"
          ? `${String(op.values.track)}@${String(op.values.position)}`
          : op.operation,
      );
    expect(inserted).toEqual(["t2@3", "t3@4", "t4@5"]);
  });

  it("adds nothing when called off, or let go over no playlist", () => {
    openTracks();
    bundle.actions.beginRowDrag("q", 0);
    bundle.actions.hoverRowDrag(SOURCE);
    expect(bundle.actions.endRowDrag(false)).toBe(false);
    expect(drag()).toBeNull();

    bundle.actions.beginRowDrag("q", 0);
    expect(bundle.actions.endRowDrag(true)).toBe(false);
    expect(fetchMaxPosition).not.toHaveBeenCalled();
    expect(dml).not.toHaveBeenCalled();
  });

  it("carries a playlist's entries, and isn't taken by that playlist", () => {
    bundle.actions.openTab(playlist);
    bundle.actions.setResults(
      SOURCE,
      buildResultFromStringRows([
        ["e1", "1", "t1"],
        ["e2", "2", "t2"],
        ["e3", "3", "t1"],
      ]),
      { records: [], trackIdColumn: 2 },
    );
    bundle.actions.clickRow(SOURCE, 0, plain);
    bundle.actions.clickRow(SOURCE, 2, { shift: false, ctrl: true });
    bundle.actions.beginRowDrag(SOURCE, 0);
    expect(drag()).toEqual({
      fromTabId: SOURCE,
      trackIds: ["t1", "t1"],
      entryIds: ["e1", "e3"],
      over: null,
      gap: null,
    });
    bundle.actions.hoverRowDrag(SOURCE);
    expect(drag()?.over).toBeNull();
  });
});

describe("rearranging a playlist's rows", () => {
  const SOURCE = "00000000-0000-0000-0000-0000000000c1";
  const PLAYLIST = "00000000-0000-0000-0000-0000000000d1";
  const OTHER = "00000000-0000-0000-0000-0000000000c3";
  let bundle: AppStoreBundle;

  /** The playlist's entries as stored: e1…e5, holding tracks t1…t5, at
   * positions 6…10. */
  const ENTRIES = [6, 7, 8, 9, 10].map((position, i) => ({
    id: `e${i + 1}`,
    track: `t${i + 1}`,
    position,
  }));
  /** `entries` as the page's rows: their `$id` and `$position` columns, then
   * the track. */
  const rowsOf = (entries: readonly { id: string; position: number }[]) =>
    entries.map((e) => [e.id, String(e.position), "x"]);
  /** The rows the page's runs bring back, and the ones a sorted read does. */
  let pageRows: string[][];
  let sortedRows: string[][];

  const page = () => bundle.store.getState().pages[SOURCE];
  const live = () => selectPageTab(bundle.store.getState(), SOURCE)?.live;
  const drag = () => bundle.store.getState().rowDrag;
  /** The entry each row on screen lists, in order. */
  const shown = () => {
    const result = page()?.result;
    if (!result) return [];
    return Array.from(
      { length: result.rowCount },
      (_, row) => rowEntry(result, row)?.id,
    );
  };
  const selection = () => [...(page()?.selection ?? [])].sort((a, b) => a - b);
  /** Each `dml` request's operations, as `id=position` updates. */
  const sent = () =>
    vi
      .mocked(dml)
      .mock.calls.map(([req]) =>
        req.operations.map((op) =>
          op.operation === "update"
            ? `${op.where.id}=${String(op.values.position)}`
            : op.operation,
        ),
      );
  const settled = () =>
    vi.waitFor(() => {
      expect(page()?.writing).toBe(false);
      expect(page()?.running).toBe(false);
    });

  async function open(def: object, rows: string[][]) {
    pageRows = rows;
    bundle.actions.openTab({
      id: SOURCE,
      name: "Road trip",
      definition: JSON.stringify(def),
      kind: "playlist",
      playlistId: PLAYLIST,
    });
    bundle.actions.ensureRun(SOURCE);
    await settled();
  }

  /** Selects `rows` (a click, then Ctrl-clicks), picks them up by the first,
   * and lets go over gap `gap`. */
  function drop(rows: number[], gap: number): boolean {
    bundle.actions.clickRow(SOURCE, rows[0], { shift: false, ctrl: false });
    for (const row of rows.slice(1)) {
      bundle.actions.clickRow(SOURCE, row, { shift: false, ctrl: true });
    }
    bundle.actions.beginRowDrag(SOURCE, rows[0]);
    bundle.actions.hoverRowDrag(null, gap);
    return bundle.actions.endRowDrag(true);
  }

  const PLAIN = {
    filter: { custom: "", presets: [] },
    sort: { builtin: { preset: "playlist_order" } },
    display: { custom: "$title" },
  };
  const FILTERED = { ...PLAIN, filter: { custom: "jazz", presets: [] } };
  const SORTED = { ...FILTERED, sort: { custom: "\\\\title" } };

  beforeEach(() => {
    vi.mocked(dml).mockReset();
    vi.mocked(dml).mockResolvedValue({});
    vi.mocked(fetchPlaylistEntries).mockReset();
    vi.mocked(fetchPlaylistEntries).mockImplementation(() =>
      Promise.resolve(ENTRIES.map((e) => ({ ...e }))),
    );
    vi.mocked(analyzeColumnSources).mockResolvedValue(undefined);
    vi.mocked(compilePlaylist).mockReset();
    vi.mocked(compilePlaylist).mockImplementation(
      (_id, _def, _presets, _schema, _prelude, options) => ({
        sql: options?.withFilter === false ? "sorted" : "page",
        columnAnnotations: [],
      }),
    );
    vi.mocked(runSql).mockImplementation((sql) =>
      Promise.resolve({ sql } as never),
    );
    vi.mocked(buildResultFromArrow).mockImplementation((table) =>
      buildResultFromStringRows(
        (table as unknown as { sql: string }).sql === "sorted"
          ? sortedRows
          : pageRows,
      ),
    );
    bundle = createAppStore(fakeEnv());
    bundle.actions.setSchemaJson("{}");
  });
  afterEach(() => {
    bundle.dispose();
    vi.mocked(runSql).mockReset();
    vi.mocked(runSql).mockResolvedValue({} as never);
    vi.mocked(buildResultFromArrow).mockReset();
    vi.mocked(buildResultFromArrow).mockReturnValue(
      buildResultFromStringRows([["r"]]),
    );
  });

  it("shows the rows in their new place at once, and writes positions between their neighbors", async () => {
    await open(PLAIN, rowsOf(ENTRIES));
    expect(drop([2, 3, 4], 1)).toBe(true);
    expect(drag()).toBeNull();
    // At once: the same rows reordered, the moved ones still selected, and
    // the grid keeping its place.
    expect(shown()).toEqual(["e1", "e3", "e4", "e5", "e2"]);
    expect(selection()).toEqual([1, 2, 3]);
    expect(page()?.resultIsRefresh).toBe(true);
    expect(page()?.writing).toBe(true);

    // The reload brings back the order now stored.
    pageRows = [
      ["e1", "6", "x"],
      ["e3", "6.25", "x"],
      ["e4", "6.5", "x"],
      ["e5", "6.75", "x"],
      ["e2", "7", "x"],
    ];
    await settled();
    // Between 6 and 7, evenly spaced, in one request.
    expect(sent()).toEqual([["e3=6.25", "e4=6.5", "e5=6.75"]]);
    expect(vi.mocked(compilePlaylist).mock.calls.length).toBe(2);
    expect(shown()).toEqual(["e1", "e3", "e4", "e5", "e2"]);
    expect(selection()).toEqual([1, 2, 3]);
    expect(page()?.resultIsRefresh).toBe(true);
    expect(page()?.undo.steps).toHaveLength(1);

    // One step, undone by moving them back.
    pageRows = rowsOf(ENTRIES);
    bundle.actions.undo(SOURCE);
    await settled();
    expect(sent()[1]).toEqual(["e3=8", "e4=9", "e5=10"]);
    expect(shown()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  it("drops at the very top and bottom on whole numbers past the edges", async () => {
    await open(PLAIN, rowsOf(ENTRIES));
    drop([4], 0);
    await settled();
    expect(sent()).toEqual([["e5=5"]]);

    pageRows = rowsOf(ENTRIES);
    drop([0, 1], 5);
    await settled();
    expect(sent()[1]).toEqual(["e1=11", "e2=12"]);
  });

  it("renumbers the whole playlist when the neighbors are too close", async () => {
    const close = [
      { id: "e1", track: "t1", position: 1 },
      { id: "e2", track: "t2", position: 1 + Number.EPSILON },
      { id: "e3", track: "t3", position: 2 },
      { id: "e4", track: "t4", position: 3 },
    ];
    vi.mocked(fetchPlaylistEntries).mockResolvedValue(close);
    await open(PLAIN, rowsOf(close));
    drop([3], 1);
    await settled();
    expect(sent()).toEqual([["e4=2", "e2=3", "e3=4"]]);
  });

  it("goes between the visible neighbors under a filter, leaving hidden entries be", async () => {
    await open(FILTERED, rowsOf([ENTRIES[0], ENTRIES[3], ENTRIES[4]]));
    drop([2], 1);
    expect(shown()).toEqual(["e1", "e5", "e4"]);
    await settled();
    // Between e1 (6) and e4 (9); e2 and e3 aren't on screen.
    expect(sent()).toEqual([["e5=7.5"]]);
    expect(live()?.filter.custom).toBe("jazz");
  });

  it("under a sort, renumbers everything in the sorted order with the move made, and resets the sort, as one step", async () => {
    // Sorted descending; the filter shows e5, e3 and e1.
    sortedRows = rowsOf([...ENTRIES].reverse());
    await open(SORTED, rowsOf([ENTRIES[4], ENTRIES[2], ENTRIES[0]]));
    drop([2], 1);
    expect(shown()).toEqual(["e5", "e1", "e3"]);
    await settled();
    // The full sorted order is e5 e4 e3 e2 e1; e1 goes right after e5.
    expect(sent()).toEqual([["e5=1", "e1=2", "e4=3", "e3=4", "e2=5"]]);
    expect(live()?.sort).toEqual({ builtin: { preset: "playlist_order" } });
    expect(live()?.filter.custom).toBe("jazz");
    expect(page()?.undo.steps).toHaveLength(1);

    bundle.actions.undo(SOURCE);
    await settled();
    expect(sent()[1]).toEqual(["e5=10", "e1=6", "e4=9", "e3=8", "e2=7"]);
    expect(live()?.sort).toEqual({ custom: "\\\\title" });
  });

  it("reloads the stored order when the write fails, with the moved entries still selected", async () => {
    await open(PLAIN, rowsOf(ENTRIES));
    vi.mocked(dml).mockRejectedValueOnce(new Error("refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    drop([4], 0);
    expect(shown()).toEqual(["e5", "e1", "e2", "e3", "e4"]);
    await settled();
    expect(shown()).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(selection()).toEqual([4]);
    expect(page()?.undo.steps).toHaveLength(0);
    vi.mocked(console.error).mockRestore();
  });

  it("only offers a drop that moves something, while nothing writes to the playlist", async () => {
    await open(PLAIN, rowsOf(ENTRIES));
    bundle.actions.clickRow(SOURCE, 2, { shift: false, ctrl: false });
    bundle.actions.clickRow(SOURCE, 3, { shift: false, ctrl: true });
    bundle.actions.beginRowDrag(SOURCE, 2);
    // Either side of the rows in hand, or between them, moves nothing.
    for (const gap of [2, 3, 4]) {
      bundle.actions.hoverRowDrag(null, gap);
      expect(drag()?.gap).toBeNull();
    }
    bundle.actions.hoverRowDrag(null, 5);
    expect(drag()?.gap).toBe(5);
    // Rows that aren't tracks don't go to another playlist.
    bundle.store.setState((s) => {
      s.sources = {
        status: "ready",
        data: [
          {
            id: OTHER,
            kind: "playlist",
            name: "Other",
            createdAt: 0,
            modifiedAt: 0,
            lastPlay: 0,
            definition: "{}",
            parent: null,
            position: 0,
            queryId: null,
            playlistId: "00000000-0000-0000-0000-0000000000d3",
          },
        ],
      };
    });
    bundle.actions.hoverRowDrag(OTHER, null);
    expect(drag()?.over).toBeNull();
    expect(drag()?.gap).toBeNull();
    bundle.actions.endRowDrag(false);

    // A write in flight blocks a rearrangement.
    let land!: () => void;
    vi.mocked(dml).mockImplementationOnce(
      () => new Promise((resolve) => (land = () => resolve({}))),
    );
    bundle.actions.removeRows(SOURCE, [0]);
    await vi.waitFor(() => expect(dml).toHaveBeenCalledTimes(1));
    bundle.actions.beginRowDrag(SOURCE, 2);
    bundle.actions.hoverRowDrag(null, 5);
    expect(drag()?.gap).toBeNull();
    expect(bundle.actions.endRowDrag(true)).toBe(false);
    land();
    await settled();
    expect(sent()).toEqual([["delete"]]);
  });

  it("isn't offered on a query's page", () => {
    openQueryTab(bundle, "q");
    bundle.actions.setResults(
      "q",
      buildResultFromStringRows([["t1"], ["t2"], ["t3"]]),
      { records: [], trackIdColumn: 0 },
    );
    bundle.actions.beginRowDrag("q", 2);
    bundle.actions.hoverRowDrag(null, 0);
    expect(drag()?.gap).toBeNull();
    expect(bundle.actions.endRowDrag(true)).toBe(false);
    expect(dml).not.toHaveBeenCalled();
  });
});
