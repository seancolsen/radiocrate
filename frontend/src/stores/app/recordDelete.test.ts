import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanQuery } from "../../record/deletePlan";

// The "Delete records" dialog's actions: what the plan puts in state, how a
// choice is remembered and re-planned, and what confirming sends and leaves
// behind. The planner itself is `record/deletePlan.test.ts`'s; here it runs
// for real over a few rows held in memory, with the request stubbed.

vi.mock("api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("api-client")>();
  return { ...actual, dml: vi.fn(() => Promise.resolve({})) };
});
vi.mock("../../api/deletePlan", () => ({ loadPlanRows: vi.fn() }));
// The run pipeline, so the page's reload after a deletion needs no compiler
// and no backend.
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
  compilePlaylist: vi.fn(),
}));
vi.mock("../../api/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/query")>();
  return { ...actual, runSql: vi.fn(() => Promise.resolve({})) };
});
vi.mock("../../query/result", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../query/result")>();
  return {
    ...actual,
    buildResultFromArrow: vi.fn(() =>
      actual.buildResultFromStringRows([["t2"]]),
    ),
  };
});
vi.mock("../../query/lineage", () => ({
  analyzeColumnSources: vi.fn(() => Promise.resolve(undefined)),
  trackIdColumn: vi.fn(),
  recordKeyColumns: vi.fn(() => []),
}));

import { dml } from "api-client";
import { loadPlanRows } from "../../api/deletePlan";
import { runSql } from "../../api/query";
import { buildResultFromStringRows } from "../../query/result";
import { createAppStore, type AppStoreBundle } from "./index";
import type { RecordRef } from "./state";
import { fakeEnv } from "./testEnv";

/** Two tracks on one album, each with a file of its own. */
const SCHEMA = JSON.stringify({
  tables: [
    {
      name: "track",
      unique_constraints: [["id"]],
      columns: [
        { name: "id", type: "UUID", nullable: false },
        { name: "file", type: "UUID", nullable: false },
        { name: "album", type: "UUID", nullable: true },
      ],
    },
    {
      name: "album",
      unique_constraints: [["id"]],
      columns: [{ name: "id", type: "UUID", nullable: false }],
    },
    {
      name: "file",
      unique_constraints: [["id"]],
      columns: [{ name: "id", type: "UUID", nullable: false }],
    },
  ],
  links: [
    {
      from: { table: "track", column: "file" },
      to: { table: "file", column: "id" },
    },
    {
      from: { table: "track", column: "album" },
      to: { table: "album", column: "id" },
    },
  ],
});

type Rows = Record<string, string | null>[];
const DB: Record<string, Rows> = {
  track: [
    { id: "t1", file: "f1", album: "a1" },
    { id: "t2", file: "f2", album: "a1" },
  ],
  album: [{ id: "a1" }],
  file: [{ id: "f1" }, { id: "f2" }],
};

/** Answers the planner from {@link DB}. */
function answer(query: PlanQuery): Promise<(string | null)[][]> {
  const rows = DB[query.table] ?? [];
  if (query.kind === "counts") {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = row[query.column];
      if (value != null && query.values.includes(value)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return Promise.resolve(
      [...counts].map(([value, count]) => [value, String(count)]),
    );
  }
  const where = query.where;
  return Promise.resolve(
    rows
      .filter((row) =>
        "keys" in where
          ? where.keys.some((key) =>
              key.every((part) => row[part.column] === part.value),
            )
          : where.values.includes(row[where.column] ?? "\0"),
      )
      .map((row) => query.columns.map((column) => row[column] ?? null)),
  );
}

const record = (table: string, id: string): RecordRef => ({
  table,
  key: [{ column: "id", value: id }],
});

/** Lets the promises a plan or a request is made of run out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const FILE = "track.file>file";
const TRACKS = "track.album>album";

describe("the Delete records dialog", () => {
  let env: ReturnType<typeof fakeEnv>;
  let bundle: AppStoreBundle;
  const pending = () => bundle.store.getState().recordDelete;

  beforeEach(() => {
    vi.mocked(dml).mockReset().mockResolvedValue({});
    vi.mocked(loadPlanRows).mockReset().mockImplementation(answer);
    vi.mocked(runSql).mockClear();
    env = fakeEnv();
    bundle = createAppStore(env);
    bundle.actions.setSchemaJson(SCHEMA);
    bundle.actions.openTab({ id: "tab", name: "Tracks", definition: "{}" });
    bundle.actions.setResults(
      "tab",
      buildResultFromStringRows([["t1"], ["t2"]]),
      { records: [] },
    );
  });

  it("opens on a plan being worked out, then shows its outline", async () => {
    bundle.actions.requestRecordDelete("tab", "track", [record("track", "t1")]);
    expect(pending()).toMatchObject({
      tabId: "tab",
      table: "track",
      count: 1,
      status: "planning",
      summary: null,
      error: null,
    });
    await settle();
    expect(pending()).toMatchObject({ status: "ready", error: null });
    expect(pending()?.summary).toMatchObject({
      found: 1,
      deleteCount: 1,
      updateCount: 0,
      items: [{ id: `orphans:${FILE}`, count: 1, checked: false }],
    });
    expect(dml).not.toHaveBeenCalled();
  });

  it("counts a record once however many rows carry it, and needs one to open", () => {
    bundle.actions.requestRecordDelete("tab", "track", []);
    expect(pending()).toBeNull();
    bundle.actions.requestRecordDelete("tab", "track", [
      record("track", "t1"),
      record("track", "t1"),
      record("track", "t2"),
    ]);
    expect(pending()?.count).toBe(2);
  });

  it("re-plans for a choice, and remembers it for the next deletion", async () => {
    bundle.actions.requestRecordDelete("tab", "album", [record("album", "a1")]);
    await settle();
    expect(pending()?.summary).toMatchObject({
      deleteCount: 1,
      updateCount: 2,
      items: [{ id: `referencing:${TRACKS}`, count: 2, checked: false }],
    });

    bundle.actions.setRecordDeleteChoice("referencing", TRACKS, true);
    // The choice shows at once; the plan for it follows.
    expect(pending()).toMatchObject({
      status: "planning",
      choices: { referencing: { [TRACKS]: true } },
    });
    await settle();
    expect(pending()?.summary).toMatchObject({
      deleteCount: 3,
      updateCount: 0,
      items: [
        { id: `referencing:${TRACKS}`, count: 2, checked: true },
        { id: `orphans:${FILE}`, count: 2, checked: false },
      ],
    });
    bundle.actions.cancelRecordDelete();
    expect(pending()).toBeNull();

    // Another page load, on the same browser.
    const later = createAppStore(env);
    later.actions.setSchemaJson(SCHEMA);
    later.actions.requestRecordDelete("tab", "album", [record("album", "a1")]);
    expect(later.store.getState().recordDelete?.choices).toEqual({
      referencing: { [TRACKS]: true },
      orphans: {},
    });

    // Unchecking it again forgets it.
    later.actions.setRecordDeleteChoice("referencing", TRACKS, false);
    const again = createAppStore(env);
    again.actions.setSchemaJson(SCHEMA);
    again.actions.requestRecordDelete("tab", "album", [record("album", "a1")]);
    expect(again.store.getState().recordDelete?.choices).toEqual({
      referencing: {},
      orphans: {},
    });
  });

  it("won't delete on a plan that's still being worked out", async () => {
    bundle.actions.requestRecordDelete("tab", "track", [record("track", "t1")]);
    bundle.actions.confirmRecordDelete();
    await settle();
    expect(dml).not.toHaveBeenCalled();
    expect(pending()?.status).toBe("ready");
  });

  it("drops a plan that lands after the dialog was cancelled", async () => {
    bundle.actions.requestRecordDelete("tab", "track", [record("track", "t1")]);
    bundle.actions.cancelRecordDelete();
    await settle();
    expect(pending()).toBeNull();
  });

  it("sends the plan as one request, then closes and reloads the page", async () => {
    bundle.actions.clickRow("tab", 0, { shift: false, ctrl: false });
    bundle.actions.requestRecordDelete("tab", "track", [record("track", "t1")]);
    await settle();
    bundle.actions.setRecordDeleteChoice("orphans", FILE, true);
    await settle();

    bundle.actions.confirmRecordDelete();
    expect(pending()?.status).toBe("deleting");
    // It can't be called off once it's been sent.
    bundle.actions.cancelRecordDelete();
    expect(pending()?.status).toBe("deleting");
    await settle();

    expect(dml).toHaveBeenCalledExactlyOnceWith({
      operations: [
        { operation: "delete", id: "d0", table: "track", where: { id: "t1" } },
        { operation: "delete", id: "d1", table: "file", where: { id: "f1" } },
      ],
      deleteAudioFiles: true,
    });
    const s = bundle.store.getState();
    expect(s.recordDelete).toBeNull();
    expect(s.toast?.text).toBe("Deleted 1 track");
    // The row that was selected now holds another record.
    expect(s.pages["tab"]?.selection).toBeUndefined();
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(s.pages["tab"]?.result?.rowCount).toBe(1);
  });

  it("deletes the audio of the files it takes, unless that's turned off", async () => {
    // On to begin with, and only sent when there are files.
    bundle.actions.requestRecordDelete("tab", "track", [record("track", "t1")]);
    expect(pending()?.deleteAudioFiles).toBe(true);
    await settle();
    expect(pending()?.summary?.deletedByTable).toEqual({ track: 1 });
    bundle.actions.confirmRecordDelete();
    await settle();
    expect(vi.mocked(dml).mock.calls[0]?.[0]).not.toHaveProperty(
      "deleteAudioFiles",
    );

    // Turned off, it stays off for the next deletion.
    bundle.actions.requestRecordDelete("tab", "track", [record("track", "t2")]);
    bundle.actions.setRecordDeleteChoice("orphans", FILE, true);
    bundle.actions.setRecordDeleteAudioFiles(false);
    expect(pending()?.deleteAudioFiles).toBe(false);
    await settle();
    expect(pending()?.summary?.deletedByTable).toEqual({ track: 1, file: 1 });
    bundle.actions.confirmRecordDelete();
    await settle();
    expect(vi.mocked(dml).mock.calls[1]?.[0]).not.toHaveProperty(
      "deleteAudioFiles",
    );

    const later = createAppStore(env);
    later.actions.setSchemaJson(SCHEMA);
    later.actions.requestRecordDelete("tab", "track", [record("track", "t1")]);
    expect(later.store.getState().recordDelete?.deleteAudioFiles).toBe(false);

    // And turned on again, it's forgotten: on is the default.
    later.actions.setRecordDeleteAudioFiles(true);
    const again = createAppStore(env);
    again.actions.setSchemaJson(SCHEMA);
    again.actions.requestRecordDelete("tab", "track", [record("track", "t1")]);
    expect(again.store.getState().recordDelete?.deleteAudioFiles).toBe(true);
  });

  it("takes a deleted track out of the queue and off the player", async () => {
    bundle.actions.setResults(
      "tab",
      buildResultFromStringRows([["t1"], ["t2"]]),
      { trackIdColumn: 0, records: [] },
    );
    bundle.actions.playRow("tab", 0);
    bundle.actions.queueRows("tab", [1], "last");
    expect(bundle.store.getState().currentTrack?.id).toBe("t1");
    expect(bundle.store.getState().queuedTracks.map((t) => t.id)).toEqual([
      "t2",
    ]);

    bundle.actions.requestRecordDelete("tab", "track", [
      record("track", "t1"),
      record("track", "t2"),
    ]);
    await settle();
    bundle.actions.confirmRecordDelete();
    await settle();

    expect(bundle.store.getState().currentTrack).toBeNull();
    expect(bundle.store.getState().queuedTracks).toEqual([]);
    expect(bundle.store.getState().toast?.text).toBe("Deleted 2 tracks");
  });

  it("keeps a failed deletion in the dialog, with a fresh plan under it", async () => {
    bundle.actions.requestRecordDelete("tab", "track", [record("track", "t1")]);
    await settle();
    const loads = vi.mocked(loadPlanRows).mock.calls.length;
    vi.mocked(dml).mockRejectedValueOnce(
      new Error("a row still references it"),
    );

    bundle.actions.confirmRecordDelete();
    await settle();

    expect(pending()).toMatchObject({
      status: "ready",
      error: "a row still references it",
    });
    // Planned again from nothing: what was loaded may be what went stale.
    expect(vi.mocked(loadPlanRows).mock.calls.length).toBeGreaterThan(loads);
    expect(runSql).not.toHaveBeenCalled();

    // And it can be tried again.
    bundle.actions.confirmRecordDelete();
    await settle();
    expect(dml).toHaveBeenCalledTimes(2);
    expect(pending()).toBeNull();
  });

  it("reports a plan that couldn't be worked out, and deletes nothing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadPlanRows).mockRejectedValue(new Error("no such table"));
    bundle.actions.requestRecordDelete("tab", "track", [record("track", "t1")]);
    await settle();
    expect(pending()).toMatchObject({
      status: "ready",
      summary: null,
      error: "no such table",
    });
    bundle.actions.confirmRecordDelete();
    await settle();
    expect(dml).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});
