import { describe, expect, it } from "vitest";
import { planSave, type FormTree } from "./formSave";
import { listId, ROOT_ID, scalarChildId } from "./formIds";
import type { ListNode, RecordNode } from "./formModel";
import { buildFormFields, type RecordKey } from "../../query/recordForm";
import type { ColumnValues } from "./formValues";
import type { SchemaTable } from "../../query/schema";

// The save planner over a hand-built form tree: the same shapes the model puts
// together as the user opens the form, without the store, the DOM or a backend.

const col = (name: string, type: string, nullable = false) => ({
  name,
  type,
  nullable,
});
const TABLES: SchemaTable[] = [
  {
    name: "album",
    columns: [col("id", "UUID"), col("title", "VARCHAR", true)],
    uniqueConstraints: [["id"]],
  },
  {
    name: "artist",
    columns: [col("id", "UUID"), col("name", "VARCHAR")],
    uniqueConstraints: [["id"], ["name"]],
  },
  {
    name: "credit",
    columns: [
      col("track", "UUID"),
      col("artist", "UUID"),
      col("ord", "FLOAT", true),
      col("role", "VARCHAR", true),
    ],
    uniqueConstraints: [["track", "artist"]],
  },
  {
    name: "play",
    columns: [col("track", "UUID"), col("timestamp", "TIMESTAMP_S")],
    uniqueConstraints: [["track", "timestamp"]],
  },
  {
    name: "track",
    columns: [
      col("id", "UUID"),
      col("title", "VARCHAR"),
      col("album", "UUID", true),
      col("genre", "VARCHAR", true),
    ],
    uniqueConstraints: [["id"]],
  },
];

/** A node's values as it holds them: one entry per record, which for the nodes
 * below is one apiece unless the test says otherwise. */
const perRecord = (
  values: Record<string, string | null>,
  records = 1,
): Record<string, ColumnValues> =>
  Object.fromEntries(
    Object.entries(values).map(([column, value]) => [
      column,
      Array.from({ length: records }, () => value),
    ]),
  );

/** A record as the form holds one it loaded: values and baseline in step. */
function loaded(
  table: string,
  key: RecordKey,
  values: Record<string, string | null>,
  hidden: readonly string[] = [],
): RecordNode {
  return {
    table,
    keys: [key],
    hidden,
    fields: buildFormFields(TABLES, table, hidden),
    status: "loaded",
    error: null,
    values: perRecord(values),
    original: perRecord(values),
    counts: {},
    isNew: false,
  };
}

/** Several records as one node holds them — the editor opened on a multi-row
 * selection. They agree on `values`, which is what makes those columns editable
 * across all of them. */
function loadedAll(
  table: string,
  keys: readonly RecordKey[],
  values: Record<string, string | null>,
): RecordNode {
  const node = loaded(table, keys[0] ?? [], values);
  return {
    ...node,
    keys,
    values: perRecord(values, keys.length),
    original: perRecord(values, keys.length),
  };
}

/** One the form is creating: no key, no baseline, `values` whatever the user has
 * typed into it so far. */
function created(
  table: string,
  values: Record<string, string | null>,
  hidden: readonly string[] = [],
): RecordNode {
  return { ...loaded(table, [], values, hidden), original: {}, isNew: true };
}

/** The same node after an edit — what the user changed, in every record it
 * stands for, against the baseline the load left behind. */
function edited(
  node: RecordNode,
  changes: Record<string, string | null>,
): RecordNode {
  return {
    ...node,
    values: { ...node.values, ...perRecord(changes, node.keys.length) },
  };
}

function list(childIds: string[], removed: string[] = []): ListNode {
  return {
    status: "loaded",
    error: null,
    expected: childIds.length,
    childIds,
    removed,
    dirty: removed.length > 0,
  };
}

const tree = (
  records: Record<string, RecordNode>,
  lists: Record<string, ListNode> = {},
): FormTree => ({
  record: (id) => records[id],
  list: (id) => lists[id],
});

const TRACK_KEY = [{ column: "id", value: "track-1" }];
const trackNode = () =>
  loaded("track", TRACK_KEY, {
    id: "track-1",
    title: "Pray You Catch Me",
    album: "album-1",
    genre: "R&B",
  });

const credits = listId(ROOT_ID, "#credit");

describe("planSave", () => {
  it("sends nothing for a form the user hasn't touched", () => {
    const plan = planSave(tree({ [ROOT_ID]: trackNode() }));
    expect(plan.operations).toEqual([]);
  });

  it("updates only the columns that changed, keyed on the record", () => {
    const plan = planSave(
      tree({ [ROOT_ID]: edited(trackNode(), { title: "Renamed" }) }),
    );
    expect(plan.operations).toEqual([
      {
        operation: "update",
        id: "op1",
        table: "track",
        where: { id: "track-1" },
        values: { title: "Renamed" },
      },
    ]);
    expect(plan.saved.get("op1")).toEqual({ recordId: ROOT_ID, index: 0 });
  });

  it("updates each record of a multi-record form in its own operation", () => {
    const node = loadedAll(
      "track",
      [
        [{ column: "id", value: "track-1" }],
        [{ column: "id", value: "track-2" }],
      ],
      { title: "Sorry", genre: "R&B" },
    );
    const plan = planSave(tree({ [ROOT_ID]: edited(node, { genre: "Pop" }) }));
    expect(plan.operations).toEqual([
      {
        operation: "update",
        id: "op1",
        table: "track",
        where: { id: "track-1" },
        values: { genre: "Pop" },
      },
      {
        operation: "update",
        id: "op2",
        table: "track",
        where: { id: "track-2" },
        values: { genre: "Pop" },
      },
    ]);
    // Each answer goes back to the record its operation was for.
    expect(plan.saved.get("op2")).toEqual({ recordId: ROOT_ID, index: 1 });
  });

  it("writes only the records an edit actually changed", () => {
    // A save is per record against its own baseline: the record that already
    // held what the form now holds has nothing to write.
    const node = loadedAll(
      "track",
      [
        [{ column: "id", value: "track-1" }],
        [{ column: "id", value: "track-2" }],
      ],
      { title: "Sorry" },
    );
    const plan = planSave(
      tree({
        [ROOT_ID]: {
          ...node,
          values: { ...node.values, title: ["Sorry", "Renamed"] },
        },
      }),
    );
    expect(plan.operations).toEqual([
      {
        operation: "update",
        id: "op1",
        table: "track",
        where: { id: "track-2" },
        values: { title: "Renamed" },
      },
    ]);
  });

  it("reads an emptied field as NULL — unless the column can't hold one", () => {
    const plan = planSave(
      tree({ [ROOT_ID]: edited(trackNode(), { genre: "", title: "" }) }),
    );
    expect(plan.operations[0]).toMatchObject({
      values: { genre: null, title: "" },
    });
  });

  it("deletes a removed record, and does so before any insert", () => {
    const plan = planSave(
      tree(
        {
          [ROOT_ID]: trackNode(),
          [`${credits}[0]`]: loaded(
            "credit",
            [
              { column: "track", value: "track-1" },
              { column: "artist", value: "artist-1" },
            ],
            { track: "track-1", artist: "artist-1" },
            ["track"],
          ),
          [`${credits}[new:1]`]: created("credit", { artist: "artist-2" }, [
            "track",
          ]),
        },
        { [credits]: list([`${credits}[new:1]`], [`${credits}[0]`]) },
      ),
    );
    expect(plan.operations).toEqual([
      {
        operation: "delete",
        id: "op1",
        table: "credit",
        where: { track: "track-1", artist: "artist-1" },
      },
      {
        operation: "insert",
        id: "op2",
        table: "credit",
        // The column the list is filtered on is the child's link back to the
        // record being edited — hidden in the form, supplied here.
        values: { artist: "artist-2", track: "track-1" },
      },
    ]);
    expect(plan.deleted).toEqual([`${credits}[0]`]);
    expect(plan.created).toEqual([`${credits}[new:1]`]);
  });

  it("deletes what hangs off a removed record before the record itself", () => {
    // An album's track list, with the track taken out of it — and that track's
    // own credits already loaded, which the API won't cascade through.
    const tracks = listId(ROOT_ID, "#track");
    const track = `${tracks}[0]`;
    const trackCredits = listId(track, "#credit");
    const plan = planSave(
      tree(
        {
          [ROOT_ID]: loaded("album", [{ column: "id", value: "album-1" }], {
            id: "album-1",
            title: "Lemonade",
          }),
          [track]: loaded("track", [{ column: "id", value: "track-1" }], {
            id: "track-1",
            title: "Sorry",
          }),
          [`${trackCredits}[0]`]: loaded(
            "credit",
            [
              { column: "track", value: "track-1" },
              { column: "artist", value: "artist-1" },
            ],
            { track: "track-1", artist: "artist-1" },
            ["track"],
          ),
        },
        {
          [tracks]: list([], [track]),
          [trackCredits]: list([`${trackCredits}[0]`]),
        },
      ),
    );
    expect(plan.operations.map((op) => [op.operation, op.table])).toEqual([
      ["delete", "credit"],
      ["delete", "track"],
    ]);
  });

  it("drops a record the form created and the user then removed", () => {
    const plan = planSave(
      tree(
        {
          [ROOT_ID]: trackNode(),
          [`${credits}[new:1]`]: created("credit", {}, ["track"]),
        },
        // `removed` never holds a created record; the list simply forgets it.
        { [credits]: list([]) },
      ),
    );
    expect(plan.operations).toEqual([]);
  });

  it("inserts a linked record before the field that points at it", () => {
    const child = scalarChildId(ROOT_ID, "album");
    const plan = planSave(
      tree({
        [ROOT_ID]: edited(trackNode(), { album: null }),
        [child]: created("album", { title: "Renaissance" }),
      }),
    );
    expect(plan.operations).toEqual([
      {
        operation: "insert",
        id: "op1",
        table: "album",
        values: { title: "Renaissance" },
      },
      {
        operation: "update",
        id: "op2",
        table: "track",
        where: { id: "track-1" },
        // The reference the server resolves to the album it just created.
        values: { album: { id: "op1" } },
      },
    ]);
    expect(plan.created).toEqual([child]);
  });

  it("carries a new parent's operation id down to the records under it", () => {
    const child = scalarChildId(ROOT_ID, "album");
    const grandchild = `${listId(child, "#track")}[new:1]`;
    const plan = planSave(
      tree(
        {
          [ROOT_ID]: edited(trackNode(), { album: null }),
          [child]: created("album", { title: "Renaissance" }),
          [grandchild]: created("track", { title: "Cuff It" }, ["album"]),
        },
        { [listId(child, "#track")]: list([grandchild]) },
      ),
    );
    // The album, then the track filed under it, then the field pointing at the
    // album — each reference resolving against an operation already run.
    expect(plan.operations.map((op) => [op.operation, op.table])).toEqual([
      ["insert", "album"],
      ["insert", "track"],
      ["update", "track"],
    ]);
    expect(plan.operations[1]).toMatchObject({
      values: { title: "Cuff It", album: { id: "op1" } },
    });
  });

  it("edits a record reached through a link, in its own operation", () => {
    const child = scalarChildId(ROOT_ID, "album");
    const plan = planSave(
      tree({
        [ROOT_ID]: trackNode(),
        [child]: edited(
          loaded("album", [{ column: "id", value: "album-1" }], {
            id: "album-1",
            title: "Lemonade",
          }),
          { title: "Lemonade (Deluxe)" },
        ),
      }),
    );
    expect(plan.operations).toEqual([
      {
        operation: "update",
        id: "op1",
        table: "album",
        where: { id: "album-1" },
        values: { title: "Lemonade (Deluxe)" },
      },
    ]);
  });

  it("leaves an untouched child of an edited record alone", () => {
    const child = `${credits}[0]`;
    const plan = planSave(
      tree(
        {
          [ROOT_ID]: edited(trackNode(), { title: "Renamed" }),
          [child]: loaded(
            "credit",
            [
              { column: "track", value: "track-1" },
              { column: "artist", value: "artist-1" },
            ],
            { track: "track-1", artist: "artist-1", role: null },
            ["track"],
          ),
        },
        { [credits]: list([child]) },
      ),
    );
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({ table: "track" });
  });
});
