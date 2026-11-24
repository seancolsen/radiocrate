import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  folderList,
  metadataComputedColumnList,
  metadataFieldList,
  presetList,
  settingList,
  sourceList,
  type Preset,
  type Source,
} from "api-client";
import { createAppStore, type AppStoreBundle } from "./index";
import { fakeEnv } from "./testEnv";
import { selectPageChangedElsewhere, selectPageTab } from "./selectors";
import { compileSavedQuery } from "../../query/compile";
import { runSql } from "../../api/query";
import { definitionToStored, emptyDefinition } from "../../query/definition";
import { PLAYLIST_SOURCE } from "../../dev/fixtures";
import { fieldRefKey } from "../../query/fieldMetadata";
import { FIXTURE_SCHEMA_JSON } from "../../dev/recordFixture";

// Live updates in the app store: what another device's change, refetched,
// does to the lists and the pages (`specs/2026-11-live-updates`, §4.2–4.4).

vi.mock("api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("api-client")>();
  return {
    ...actual,
    sourceList: vi.fn(() => Promise.resolve([])),
    folderList: vi.fn(() => Promise.resolve([])),
    presetList: vi.fn(() => Promise.resolve([])),
    presetUpdate: vi.fn(() => Promise.resolve(null)),
    settingList: vi.fn(() => Promise.resolve([])),
    settingSet: vi.fn(() => Promise.resolve(null)),
    metadataFieldList: vi.fn(() => Promise.resolve([])),
    metadataFieldSetDisplay: vi.fn(() => Promise.resolve(null)),
    metadataComputedColumnList: vi.fn(() => Promise.resolve([])),
    metadataComputedColumnSet: vi.fn(() => Promise.resolve(null)),
    sourceUpdateDefinition: vi.fn(() => Promise.resolve(null)),
    sourceRename: vi.fn(() => Promise.resolve(null)),
  };
});
vi.mock("../../query/querydown", () => ({
  querydownReady: vi.fn(() => Promise.resolve()),
  querydownLoaded: vi.fn(() => true),
}));
vi.mock("../../query/compile", () => ({
  compileSavedQuery: vi.fn(() => ({
    sql: "select 1",
    columnAnnotations: [],
    queryAnnotation: null,
  })),
  compilePlaylist: vi.fn(() => ({
    sql: "select 2",
    columnAnnotations: [],
    queryAnnotation: null,
  })),
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
vi.mock("../../query/lineage", () => ({
  analyzeColumnSources: vi.fn(),
  trackIdColumn: vi.fn(() => undefined),
  recordKeyColumns: vi.fn(() => []),
}));

const never = () => false;

function querySource(id: string, name: string, custom = ""): Source {
  const def = emptyDefinition();
  def.filter.custom = custom;
  return {
    id,
    kind: "query",
    name,
    createdAt: 1,
    modifiedAt: 1,
    lastPlay: 1,
    definition: definitionToStored(def),
    parent: null,
    position: 0,
    queryId: `${id}-q`,
    playlistId: null,
  };
}

function preset(id: string, definition: string): Preset {
  return {
    id,
    name: id,
    baseTable: "track",
    section: "filter",
    definition,
    filterStrategy: "querydown",
    isDefault: false,
    createdAt: 1,
    modifiedAt: 1,
  };
}

describe("another device's changes", () => {
  let bundle: AppStoreBundle;
  const get = () => bundle.store.getState();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runSql).mockClear();
    vi.mocked(compileSavedQuery).mockClear();
    bundle = createAppStore(fakeEnv());
    bundle.actions.setSchemaJson(FIXTURE_SCHEMA_JSON);
  });
  afterEach(() => {
    bundle.dispose();
    vi.useRealTimers();
  });

  /** Loads `sources` as this device's starting point, and opens the first. */
  const boot = async (sources: Source[]) => {
    vi.mocked(sourceList).mockResolvedValue(sources);
    await bundle.actions.loadSources();
    bundle.actions.openTab(sources[0]);
  };

  /** The server now lists `sources`; this device hears of it. */
  const remoteSources = async (sources: Source[]) => {
    vi.mocked(sourceList).mockResolvedValue(sources);
    vi.mocked(folderList).mockResolvedValue([]);
    return bundle.actions.refreshLive("sources", never);
  };

  describe("to an open query", () => {
    it("renames its tab, unless it's being renamed here", async () => {
      await boot([querySource("a", "Old")]);
      await remoteSources([querySource("a", "New")]);
      expect(selectPageTab(get(), "a")?.name).toBe("New");

      bundle.actions.beginRename("a", "tab");
      await remoteSources([querySource("a", "Newer")]);
      expect(selectPageTab(get(), "a")?.name).toBe("New");
    });

    it("takes a new definition as one undoable step, without re-running", async () => {
      await boot([querySource("a", "A", "title:a")]);
      bundle.actions.runQuery("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(runSql).toHaveBeenCalledTimes(1);

      await remoteSources([querySource("a", "A", "title:b")]);
      const t = selectPageTab(get(), "a");
      expect(t?.kind === "query" && t.live.filter.custom).toBe("title:b");
      expect(t?.kind === "query" && t.saved.filter.custom).toBe("title:b");
      expect(runSql).toHaveBeenCalledTimes(1);
      expect(get().pages.a?.undo.index).toBe(1);

      bundle.actions.undo("a");
      const undone = selectPageTab(get(), "a");
      expect(undone?.kind === "query" && undone.live.filter.custom).toBe(
        "title:a",
      );
    });

    it("keeps an edit of this device's the backend hasn't had yet", async () => {
      await boot([querySource("a", "A", "title:a")]);
      bundle.actions.setFilterCustom("a", "title:mine");
      await remoteSources([querySource("a", "A", "title:theirs")]);
      const t = selectPageTab(get(), "a");
      expect(t?.kind === "query" && t.live.filter.custom).toBe("title:mine");
    });

    it("stays open as an unsaved query when deleted, and says so", async () => {
      await boot([querySource("a", "Doomed", "title:a")]);
      await remoteSources([]);
      const t = selectPageTab(get(), "a");
      expect(t?.kind === "query" && t.persisted).toBe(false);
      expect(t?.kind === "query" && t.live.filter.custom).toBe("title:a");
      expect(get().toast?.text).toBe("“Doomed” was deleted on another device");
    });

    it("marks the rows out of date rather than re-running them", async () => {
      await boot([querySource("a", "A")]);
      bundle.actions.runQuery("a");
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(compileSavedQuery).mockReturnValue({
        sql: "select 'new prelude'",
        columnAnnotations: [],
        queryAnnotation: null,
      } as unknown as ReturnType<typeof compileSavedQuery>);
      vi.mocked(settingList).mockResolvedValue([
        { key: "querydown_prelude", value: "#x" },
      ]);
      await bundle.actions.refreshLive("settings", never);
      expect(selectPageChangedElsewhere(get(), "a")).toBe(true);
      expect(runSql).toHaveBeenCalledTimes(1);

      bundle.actions.runQuery("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(selectPageChangedElsewhere(get(), "a")).toBe(false);
      vi.mocked(compileSavedQuery).mockReset();
    });
  });

  it("closes a deleted playlist's page", async () => {
    await boot([PLAYLIST_SOURCE]);
    await remoteSources([]);
    expect(get().tabs.some((t) => t.id === PLAYLIST_SOURCE.id)).toBe(false);
    expect(get().toast?.text).toBe("“Road Trip” was deleted on another device");
  });

  it("changes no reference when nothing changed", async () => {
    await boot([querySource("a", "A")]);
    const before = get().sources.data;
    const tabs = get().tabs;
    await remoteSources([querySource("a", "A")]);
    expect(get().sources.data).toBe(before);
    expect(get().tabs).toBe(tabs);

    const metadata = get().fieldMetadata.data;
    await bundle.actions.refreshLive("field-metadata", never);
    expect(get().fieldMetadata.data).toBe(metadata);
  });

  it("keeps a preset with changes waiting to be written", async () => {
    vi.mocked(presetList).mockResolvedValue([
      preset("p", "a"),
      preset("q", "a"),
    ]);
    await bundle.actions.loadPresets();
    bundle.actions.patchPreset("p", { definition: "mine" });
    vi.mocked(presetList).mockResolvedValue([
      preset("p", "theirs"),
      preset("q", "theirs"),
    ]);
    await bundle.actions.refreshLive("presets", never);
    expect(get().presets.map((p) => p.definition)).toEqual(["mine", "theirs"]);
    // What a revert goes back to is the backend's copy.
    expect(get().presetSaves.p?.saved.definition).toBe("theirs");
  });

  it("keeps a computed column's expression waiting to be written", async () => {
    vi.mocked(metadataComputedColumnList).mockResolvedValue([
      { schemaName: "main", tableName: "track", name: "c", expression: "1" },
      { schemaName: "main", tableName: "track", name: "d", expression: "1" },
    ]);
    await bundle.actions.loadComputedColumns();
    bundle.actions.setComputedColumnExpression("track", "c", "mine");
    vi.mocked(metadataComputedColumnList).mockResolvedValue([
      {
        schemaName: "main",
        tableName: "track",
        name: "c",
        expression: "theirs",
      },
      {
        schemaName: "main",
        tableName: "track",
        name: "d",
        expression: "theirs",
      },
    ]);
    await bundle.actions.refreshLive("computed-columns", never);
    expect(get().computedColumns.data.map((r) => r.expression)).toEqual([
      "mine",
      "theirs",
    ]);
  });

  it("keeps a field's Querydown waiting to be written", async () => {
    const field = { columnName: "album" };
    bundle.actions.setFieldQuerydown("track", field, "display", "mine");
    vi.mocked(metadataFieldList).mockResolvedValue([
      {
        schemaName: "main",
        tableName: "track",
        field,
        visible: false,
        order: null,
        display: "theirs",
        sorting: null,
      },
    ]);
    await bundle.actions.refreshLive("field-metadata", never);
    const entry = get().fieldMetadata.data.track?.[fieldRefKey(field)];
    expect(entry?.display).toBe("mine");
    expect(entry?.visible).toBe(false);
  });

  it("drops a prelude draft that's now what's in force", async () => {
    bundle.actions.editPrelude("#same");
    expect(get().preludeDraft).toBe("#same");
    vi.mocked(settingList).mockResolvedValue([
      { key: "querydown_prelude", value: "#same" },
    ]);
    await bundle.actions.refreshLive("settings", never);
    expect(get().preludeDraft).toBeNull();
  });

  it("changes nothing when a write of this device's overtook the fetch", async () => {
    await boot([querySource("a", "A")]);
    vi.mocked(sourceList).mockResolvedValue([querySource("a", "B")]);
    expect(await bundle.actions.refreshLive("sources", () => true)).toBe(false);
    expect(selectPageTab(get(), "a")?.name).toBe("A");
  });

  it("is marked as another device's while it's being applied", async () => {
    const seen: boolean[] = [];
    bundle.store.subscribe(
      (s) => s.computedColumns.data,
      () => seen.push(bundle.isApplyingRemote()),
    );
    vi.mocked(metadataComputedColumnList).mockResolvedValue([
      { schemaName: "main", tableName: "track", name: "c", expression: "1" },
    ]);
    await bundle.actions.refreshLive("computed-columns", never);
    bundle.actions.setComputedColumnExpression("track", "c", "2");
    expect(seen).toEqual([true, false]);
  });
});
