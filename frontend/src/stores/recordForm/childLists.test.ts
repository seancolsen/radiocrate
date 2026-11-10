import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DmlOperation, DmlResult } from "api-client";
import type { RecordQuery } from "../../query/recordForm";
import type { SchemaTable } from "../../query/schema";
import type { MultiRecordField, ScalarLinkField } from "../../query/recordForm";

vi.mock("../../query/recordData", () => {
  const runRecordQuery = vi.fn();
  return {
    runRecordQuery,
    runDisplayQuery: async (...args: unknown[]) => ({
      rows: (await runRecordQuery(...args)) as unknown,
      columns: [],
    }),
    isCompileError: () => false,
  };
});

import { runRecordQuery } from "../../query/recordData";
import {
  createRecordForm,
  listId,
  ROOT_ID,
  scalarChildId,
  selectFormModified,
  type RecordFormModel,
} from ".";

// The two kinds of multi-record field the form treats specially: one whose
// records are kept in an order of the user's own (a table with an `order`
// column), and one whose records only join the record to others (a table whose
// only required columns are two links) — `credit` is both, `track_tag` the
// second alone.

const col = (name: string, type: string, nullable = false) => ({
  name,
  type,
  nullable,
});
const TABLES: SchemaTable[] = [
  {
    name: "artist",
    columns: [col("id", "UUID"), col("name", "VARCHAR")],
    uniqueConstraints: [["id"]],
  },
  {
    name: "credit",
    columns: [
      col("track", "UUID"),
      col("artist", "UUID"),
      col("order", "FLOAT", true),
      col("role", "VARCHAR", true),
    ],
    uniqueConstraints: [["track", "artist"]],
  },
  {
    name: "tag",
    columns: [col("id", "UUID"), col("name", "VARCHAR")],
    uniqueConstraints: [["id"]],
  },
  {
    name: "track",
    columns: [col("id", "UUID"), col("title", "VARCHAR")],
    uniqueConstraints: [["id"]],
  },
  {
    name: "track_tag",
    columns: [col("track", "UUID"), col("tag", "UUID")],
    uniqueConstraints: [["track", "tag"]],
  },
];

const runner = vi.mocked(runRecordQuery);

/** The track's credits, as `[artist, order]`. */
const CREDITS: readonly (readonly [string, string | null])[] = [
  ["a2", "2"],
  ["a1", "1"],
  ["a3", "3"],
];

/** Answers every query: the track `t1`, its credits and no tags, and any
 * artist or tag by id. */
function serve(credits = CREDITS) {
  runner.mockImplementation(async (query: RecordQuery) => {
    const id = /id:="([^"]*)"/.exec(query.filter)?.[1] ?? "";
    switch (query.base) {
      case "track":
        // The key, `id`, `title`, then the `#credit` and `#track_tag` counts.
        return [["t1", "t1", "Song", String(credits.length), "0"]];
      case "credit":
        // A list (the key, one preview cell, then every column) or one
        // credit's own data (the key, then `artist`, `order` and `role`).
        if (query.display.includes("\n")) {
          return credits.map(([artist, order]) => [
            "t1",
            artist,
            `Artist ${artist}`,
            "t1",
            artist,
            order,
            null,
          ]);
        }
        return credits.flatMap(([artist, order]) =>
          query.filter.includes(`"${artist}"`)
            ? [["t1", artist, artist, order, null]]
            : [],
        );
      case "artist":
      case "tag":
        // Its own data (the key, `id`, `name`, then its `#…` count), or the
        // name a preview shows.
        return query.display.startsWith("$id")
          ? [[id, id, `Name ${id}`, "0"]]
          : [[`Name ${id}`]];
      default:
        return [];
    }
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function field<K extends "multiRecord" | "scalarLink">(
  model: RecordFormModel,
  recordId: string,
  key: string,
): K extends "multiRecord" ? MultiRecordField : ScalarLinkField {
  const found = model.store
    .getState()
    .records[recordId]?.fields.find((f) => f.key === key);
  if (!found) throw new Error(`no field ${key} on ${recordId}`);
  return found as K extends "multiRecord" ? MultiRecordField : ScalarLinkField;
}

const CREDITS_LIST = listId(ROOT_ID, "#credit");
const TAGS_LIST = listId(ROOT_ID, "#track_tag");

/** The form on track `t1`, its credits opened. */
async function opened(
  runDml?: (operations: DmlOperation[]) => Promise<DmlResult>,
) {
  serve();
  const model = createRecordForm({
    tables: TABLES,
    table: "track",
    keys: [[{ column: "id", value: "t1" }]],
    schemaJson: "{}",
    runDml,
  });
  model.start();
  await flush();
  model.toggleField(ROOT_ID, field<"multiRecord">(model, ROOT_ID, "#credit"));
  await flush();
  return model;
}

/** The artist of each credit the list shows, in order. */
const artists = (model: RecordFormModel) => {
  const s = model.store.getState();
  return (s.lists[CREDITS_LIST]?.childIds ?? []).map(
    (child) => s.records[child]?.values["artist"]?.[0] ?? null,
  );
};
const orders = (model: RecordFormModel) => {
  const s = model.store.getState();
  return (s.lists[CREDITS_LIST]?.childIds ?? []).map(
    (child) => s.records[child]?.values["order"]?.[0] ?? null,
  );
};

beforeEach(() => {
  runner.mockReset();
});

describe("a field whose records are kept in order", () => {
  it("lists them by their order, which their forms don't show", async () => {
    const model = await opened();
    expect(artists(model)).toEqual(["a1", "a2", "a3"]);
    const first = model.store.getState().lists[CREDITS_LIST]!.childIds[0];
    expect(model.store.getState().records[first]?.concealed).toEqual(["order"]);
  });

  it("adds a record at the end, numbered next", async () => {
    const model = await opened();
    model.addChild(ROOT_ID, field<"multiRecord">(model, ROOT_ID, "#credit"));
    expect(orders(model)).toEqual(["1", "2", "3", "4"]);
  });

  it("numbers a record added before the list arrived once it has", async () => {
    serve();
    const model = createRecordForm({
      tables: TABLES,
      table: "track",
      keys: [[{ column: "id", value: "t1" }]],
      schemaJson: "{}",
    });
    model.start();
    await flush();
    model.addChild(ROOT_ID, field<"multiRecord">(model, ROOT_ID, "#credit"));
    await flush();
    expect(orders(model)).toEqual(["1", "2", "3", "4"]);
  });

  it("moves records, renumbering only the ones that changed places", async () => {
    const runDml = vi.fn<(operations: DmlOperation[]) => Promise<DmlResult>>(
      () => Promise.resolve({}),
    );
    const model = await opened(runDml);
    const ids = model.store.getState().lists[CREDITS_LIST]!.childIds;
    const credits = field<"multiRecord">(model, ROOT_ID, "#credit");

    // Nowhere new: nothing moves.
    expect(model.reorderChildren(ROOT_ID, credits, [ids[0]], 1)).toBe(false);
    expect(selectFormModified(model.store.getState())).toBe(false);

    // The last to the top.
    expect(model.reorderChildren(ROOT_ID, credits, [ids[2]], 0)).toBe(true);
    expect(artists(model)).toEqual(["a3", "a1", "a2"]);
    expect(orders(model)).toEqual(["1", "2", "3"]);

    await model.save();
    expect(runDml).toHaveBeenCalledTimes(1);
    expect(
      runDml.mock.calls[0][0].map((op) =>
        op.operation === "update" ? [op.where, op.values] : op,
      ),
    ).toEqual([
      [{ track: "t1", artist: "a3" }, { order: "1" }],
      [{ track: "t1", artist: "a1" }, { order: "2" }],
      [{ track: "t1", artist: "a2" }, { order: "3" }],
    ]);
  });

  it("moves a selection together, in the order it's in", async () => {
    const model = await opened();
    const ids = model.store.getState().lists[CREDITS_LIST]!.childIds;
    const credits = field<"multiRecord">(model, ROOT_ID, "#credit");
    model.reorderChildren(ROOT_ID, credits, [ids[0], ids[1]], 3);
    expect(artists(model)).toEqual(["a3", "a1", "a2"]);
  });

  it("keeps a record's new place when it's opened", async () => {
    const model = await opened();
    const ids = model.store.getState().lists[CREDITS_LIST]!.childIds;
    const credits = field<"multiRecord">(model, ROOT_ID, "#credit");
    model.reorderChildren(ROOT_ID, credits, [ids[2]], 0);
    model.toggleChild(ids[2], true);
    await flush();
    const node = model.store.getState().records[ids[2]];
    expect(node?.status).toBe("loaded");
    expect(node?.values["order"]).toEqual(["1"]);
    expect(node?.original["order"]).toEqual(["3"]);
  });
});

describe("a join table's field", () => {
  it("opens a record onto the one it stands for", async () => {
    const model = await opened();
    const [first] = model.store.getState().lists[CREDITS_LIST]!.childIds;
    model.toggleChild(first, true);
    await flush();
    const artist =
      model.store.getState().records[scalarChildId(first, "artist")];
    expect(artist?.table).toBe("artist");
    expect(artist?.values["name"]).toEqual(["Name a1"]);
  });

  it("offers to edit its records, and to go on from what they stand for", async () => {
    const model = await opened();
    const [first, second] =
      model.store.getState().lists[CREDITS_LIST]!.childIds;
    model.openMenu({
      target: {
        kind: "childRecords",
        recordId: ROOT_ID,
        fieldKey: "#credit",
        ids: [first, second],
      },
      x: 0,
      y: 0,
    });
    expect(model.store.getState().menu?.records).toEqual({
      edit: {
        table: "credit",
        keys: [
          [
            { column: "track", value: "t1" },
            { column: "artist", value: "a1" },
          ],
          [
            { column: "track", value: "t1" },
            { column: "artist", value: "a2" },
          ],
        ],
      },
      navigate: {
        table: "artist",
        keys: [
          [{ column: "id", value: "a1" }],
          [{ column: "id", value: "a2" }],
        ],
      },
    });
  });

  it("starts a new record by picking what it joins to, and then shows that", async () => {
    const model = await opened();
    model.addChild(ROOT_ID, field<"multiRecord">(model, ROOT_ID, "#track_tag"));
    const [child] = model.store.getState().lists[TAGS_LIST]!.childIds;
    expect(model.store.getState().picker).toEqual({
      recordId: child,
      fieldKey: "tag",
    });

    model.pickRecord(child, field<"scalarLink">(model, child, "tag"), "g1", [
      "Rock",
    ]);
    await flush();
    const s = model.store.getState();
    expect(s.picker).toBeNull();
    expect(s.records[scalarChildId(child, "tag")]?.values["name"]).toEqual([
      "Name g1",
    ]);
  });
});
