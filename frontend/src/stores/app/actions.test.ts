import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStoreBundle } from "./index";
import { fakeEnv } from "./testEnv";
import { buildResultFromStringRows } from "../../query/result";

// `settingSet`/`settingDelete` are the only api-client calls the tests below
// exercise directly; every other export is used as-is (its return value is
// never awaited by the assertions here).
vi.mock("api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("api-client")>();
  return {
    ...actual,
    settingSet: vi.fn(() => Promise.resolve(null)),
    settingDelete: vi.fn(() => Promise.resolve(null)),
  };
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

import { settingDelete, settingSet } from "api-client";
import { compileSavedQuery } from "../../query/compile";
import { analyzeColumnSources } from "../../query/lineage";
import { SETTINGS } from "../../state/settings";

function openQueryTab(bundle: AppStoreBundle, id: string) {
  bundle.actions.openTab({ id, name: id, definition: "{}" });
}

describe("closeTab", () => {
  let bundle: AppStoreBundle;
  beforeEach(() => {
    bundle = createAppStore(fakeEnv());
  });

  it("clears every per-tab map and selects a remaining neighbor", () => {
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
    expect(s.resultsByTab["b"]).toBeUndefined();
    expect(s.selectionByTab["b"]).toBeUndefined();
    expect(s.lineageByTab["b"]).toBeUndefined();
    expect(s.recordEditorByTab["b"]).toBeUndefined();
    expect(s.builderSectionByTab["b"]).toBeUndefined();
    expect(s.fullEditorByTab["b"]).toBeUndefined();
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
    expect([...bundle.store.getState().selectionByTab["a"]].sort()).toEqual([
      1, 2, 3,
    ]);
  });

  it("re-anchors on a plain click, so a later shift-click grows from there", () => {
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 3, { shift: false, ctrl: false });
    bundle.actions.clickRow("a", 4, { shift: true, ctrl: false });
    expect([...bundle.store.getState().selectionByTab["a"]].sort()).toEqual([
      3, 4,
    ]);
  });

  it("extends from the click lead on Shift+Arrow, not the anchor alone", () => {
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: false });
    bundle.actions.moveRowSelection("a", true, true); // Shift+Down from row 1
    expect([...bundle.store.getState().selectionByTab["a"]].sort()).toEqual([
      1, 2,
    ]);
  });

  it("moves the lead without extending on a plain arrow key", () => {
    bundle.actions.clickRow("a", 2, { shift: false, ctrl: false });
    bundle.actions.moveRowSelection("a", false, false); // Up, no shift
    expect([...bundle.store.getState().selectionByTab["a"]]).toEqual([1]);
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
    bundle.actions.seedNowPlaying(
      { sourceTabId: "a", id: "t1", rowIndex: 1, title: null, artists: [] },
      { playing: true, position: 0, duration: null, hasNext: false },
    );

    bundle.actions.setResults(
      "a",
      buildResultFromStringRows([["x"], ["y"], ["z"]]),
    );

    const s = bundle.store.getState();
    expect(s.selectionByTab["a"]).toBeUndefined();
    expect(s.lineageByTab["a"]).toBeUndefined();
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
      bundle.store.getState().recordEditorByTab["a"]?.records,
    ).toHaveLength(2);
  });

  it("closes the editor when passed no records", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setRecordEditorRecords("a", "track", [
      { table: "track", key: [{ column: "id", value: "1" }] },
    ]);
    bundle.actions.setRecordEditorRecords("a", "track", []);
    expect(bundle.store.getState().recordEditorByTab["a"]).toBeNull();
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
    expect(bundle.store.getState().recordEditorByTab["a"]?.records).toEqual([
      { table: "track", key: [{ column: "id", value: "1" }] },
      { table: "track", key: [{ column: "id", value: "2" }] },
    ]);

    // Empty the selection (two Ctrl-clicks toggle both selected rows off) —
    // the editor should close.
    bundle.actions.clickRow("a", 0, { shift: false, ctrl: true });
    bundle.actions.clickRow("a", 1, { shift: false, ctrl: true });
    bundle.actions.resyncRecordEditors();
    expect(bundle.store.getState().recordEditorByTab["a"]).toBeNull();
  });

  it("leaves tabs with no open editor alone", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.setResults("a", buildResultFromStringRows([["1"], ["2"]]));
    bundle.actions.clickRow("a", 0, { shift: false, ctrl: false });
    expect(() => bundle.actions.resyncRecordEditors()).not.toThrow();
    expect(bundle.store.getState().recordEditorByTab["a"]).toBeUndefined();
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
    expect(bundle.store.getState().expandedPresetByTab["a"]).toBe("p1");

    bundle.actions.toggleFilterPreset("a", "p1"); // remove it again

    expect(bundle.store.getState().expandedPresetByTab["a"]).toBeNull();
  });

  it("leaves a different preset's expansion alone", () => {
    const bundle = createAppStore(fakeEnv());
    openQueryTab(bundle, "a");
    bundle.actions.toggleExpandPreset("a", "other");
    bundle.actions.toggleFilterPreset("a", "p1");
    bundle.actions.toggleFilterPreset("a", "p1");
    expect(bundle.store.getState().expandedPresetByTab["a"]).toBe("other");
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
    // Re-run is triggered synchronously: `runQuery` flips `runningByTab` to
    // `true` before its async body ever awaits anything.
    expect(bundle.store.getState().runningByTab["a"]).toBe(true);
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
      expect(bundle.store.getState().lineageByTab["a"]?.trackIdColumn).toBe(2),
    );

    // Run 1's (stale) analysis lands after — it must not win the race.
    resolvers[0](1);
    await new Promise((r) => setTimeout(r, 0));
    expect(bundle.store.getState().lineageByTab["a"]?.trackIdColumn).toBe(2);
  });
});
