import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DmlOperation, DmlResult } from "api-client";
import type { RecordRows } from "../../query/recordData";
import type { SchemaTable } from "../../query/schema";
import type { FormField, MultiRecordField } from "../../query/recordForm";

vi.mock("../../query/recordData", () => ({ runRecordQuery: vi.fn() }));

import { runRecordQuery } from "../../query/recordData";
import {
  createFormsStore,
  selectFocusedForm,
  selectModifiedRecords,
} from "../forms";
import {
  createRecordForm,
  fieldItemId,
  listId,
  ROOT_ID,
  selectFieldModified,
  selectFormModified,
  selectIsBulkBlocked,
  selectSharedValue,
  VARIED,
  type RecordFormModel,
  type RecordFormOptions,
} from ".";

// The form model over a two-table schema — a track and the credits pointing at
// it — with the record query runner mocked, so each test decides what the
// "database" answers and when.

const col = (name: string, type: string, nullable = false) => ({
  name,
  type,
  nullable,
});
const TABLES: SchemaTable[] = [
  {
    name: "track",
    columns: [
      col("id", "UUID"),
      col("title", "VARCHAR"),
      col("genre", "VARCHAR", true),
    ],
    uniqueConstraints: [["id"]],
  },
  {
    name: "credit",
    columns: [
      col("id", "UUID"),
      col("track", "UUID"),
      col("role", "VARCHAR", true),
    ],
    uniqueConstraints: [["id"]],
  },
];

const runner = vi.mocked(runRecordQuery);

const trackKey = (id: string) => [{ column: "id", value: id }];

/** A row of the root's data query: the key, then `id`, `title`, `genre` and
 * the `#credit` count, positionally. */
const trackRow = (
  id: string,
  title: string,
  genre: string | null,
  credits: number,
) => [id, id, title, genre, String(credits)];

/** A credit row, which fits both queries that reach the table: a child list
 * (key, then the `$id $role` preview) and a credit's own data (key, then its
 * `id` and `role` fields — `track` is hidden under its parent). */
const creditRow = (id: string, role: string | null) => [id, id, role];

/** Answers every query from fixed rows, by table. */
function serve(rows: { track?: RecordRows; credit?: RecordRows }) {
  runner.mockImplementation(async (query) =>
    query.base === "track" ? (rows.track ?? []) : (rows.credit ?? []),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets every settled load's continuation run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function form(
  keys = [trackKey("t1")],
  extra: Partial<RecordFormOptions> = {},
): RecordFormModel {
  return createRecordForm({
    tables: TABLES,
    table: "track",
    keys,
    schemaJson: "{}",
    ...extra,
  });
}

const fieldOf = (model: RecordFormModel, recordId: string, key: string) => {
  const field = model.store
    .getState()
    .records[recordId]?.fields.find((f) => f.key === key);
  if (!field) throw new Error(`no field ${key} on ${recordId}`);
  return field;
};
const credits = (model: RecordFormModel) =>
  fieldOf(model, ROOT_ID, "#credit") as MultiRecordField;
const CREDITS_LIST = listId(ROOT_ID, "#credit");

beforeEach(() => {
  runner.mockReset();
});

describe("loading", () => {
  it("does nothing on construction, and start() loads the root once", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 2)] });
    const model = form();
    expect(runner).not.toHaveBeenCalled();
    expect(model.store.getState().records[ROOT_ID]?.status).toBe("unloaded");

    model.start();
    model.start();
    await flush();

    expect(runner).toHaveBeenCalledTimes(1);
    const s = model.store.getState();
    expect(s.records[ROOT_ID]?.status).toBe("loaded");
    expect(selectSharedValue(s, ROOT_ID, "title")).toBe("Formation");
    expect(s.records[ROOT_ID]?.counts["#credit"]).toEqual([2]);
  });

  it("loads a field's data the first time it opens, and keeps it", async () => {
    serve({
      track: [trackRow("t1", "Formation", "Pop", 1)],
      credit: [creditRow("c1", "Vocals")],
    });
    const model = form();
    model.start();
    await flush();

    model.toggleField(ROOT_ID, credits(model), true);
    await flush();
    model.toggleField(ROOT_ID, credits(model), false);
    model.toggleField(ROOT_ID, credits(model), true);
    await flush();

    expect(runner).toHaveBeenCalledTimes(2); // the root, then the list once
    const list = model.store.getState().lists[CREDITS_LIST];
    expect(list?.status).toBe("loaded");
    expect(list?.childIds).toEqual([`${CREDITS_LIST}[0]`]);
  });

  it("never lets a superseded load overwrite a newer one", async () => {
    const stale = deferred<RecordRows>();
    const fresh = deferred<RecordRows>();
    runner
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    const model = form();
    model.start();
    model.reset(); // reloads the root under a new token

    fresh.resolve([trackRow("t1", "Newer", "Pop", 0)]);
    await flush();
    stale.resolve([trackRow("t1", "Stale", "Pop", 0)]);
    await flush();

    expect(selectSharedValue(model.store.getState(), ROOT_ID, "title")).toBe(
      "Newer",
    );
  });
});

describe("several records at once", () => {
  it("blocks the fields the records disagree on, and edits the rest across all of them", async () => {
    // The database's own order, not the keys' — rows are matched by key.
    serve({
      track: [
        trackRow("t2", "Same", "Rock", 3),
        trackRow("t1", "Same", "Pop", 1),
      ],
    });
    const model = form([trackKey("t1"), trackKey("t2")]);
    model.start();
    await flush();

    let s = model.store.getState();
    expect(selectSharedValue(s, ROOT_ID, "genre")).toBe(VARIED);
    expect(selectIsBulkBlocked(s, ROOT_ID, "genre")).toBe(true);
    expect(selectIsBulkBlocked(s, ROOT_ID, "#credit")).toBe(true);
    expect(selectIsBulkBlocked(s, ROOT_ID, "title")).toBe(false);

    model.beginEdit(ROOT_ID, "genre");
    model.clearField(ROOT_ID, fieldOf(model, ROOT_ID, "genre"));
    model.toggleField(ROOT_ID, credits(model), true);
    s = model.store.getState();
    expect(s.editing).toBeNull();
    expect(s.records[ROOT_ID]?.values["genre"]).toEqual(["Pop", "Rock"]);
    expect(s.expanded[fieldItemId(ROOT_ID, "#credit")]).toBeUndefined();

    model.beginEdit(ROOT_ID, "title");
    expect(model.store.getState().editing).toBe(fieldItemId(ROOT_ID, "title"));
    model.commitEdit(ROOT_ID, "title", "Both");
    expect(model.store.getState().records[ROOT_ID]?.values["title"]).toEqual([
      "Both",
      "Both",
    ]);
  });

  it("never blocks anything on a single record", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 1)] });
    const model = form();
    model.start();
    await flush();
    const s = model.store.getState();
    for (const field of s.records[ROOT_ID]?.fields ?? []) {
      expect(selectIsBulkBlocked(s, ROOT_ID, field.key)).toBe(false);
    }
  });
});

describe("saving", () => {
  it("waits for the keys a cleared, unopened list has to delete", async () => {
    const removal = deferred<RecordRows>();
    runner
      .mockResolvedValueOnce([trackRow("t1", "Formation", "Pop", 2)])
      .mockReturnValueOnce(removal.promise);
    const runDml = vi.fn<(operations: DmlOperation[]) => Promise<DmlResult>>(
      () => Promise.resolve({}),
    );
    const model = form(undefined, { runDml });
    model.start();
    await flush();

    model.clearField(ROOT_ID, credits(model));
    expect(runner).toHaveBeenCalledTimes(2); // the keys, fetched right away
    expect(model.store.getState().lists[CREDITS_LIST]?.childIds).toEqual([]);

    const saving = model.save();
    await flush();
    expect(runDml).not.toHaveBeenCalled();
    expect(model.store.getState().saving).toBe(true);

    removal.resolve([creditRow("c1", "Vocals"), creditRow("c2", null)]);
    await saving;

    expect(runDml).toHaveBeenCalledTimes(1);
    expect(runDml.mock.calls[0]?.[0]).toEqual([
      { operation: "delete", id: "op1", table: "credit", where: { id: "c1" } },
      { operation: "delete", id: "op2", table: "credit", where: { id: "c2" } },
    ]);
    const s = model.store.getState();
    expect(s.saving).toBe(false);
    expect(s.saveError).toBeNull();
    expect(selectFormModified(s)).toBe(false);
  });

  it("takes a successful save as the new baseline", async () => {
    serve({
      track: [trackRow("t1", "Formation", "Pop", 1)],
      credit: [creditRow("c1", "Vocals")],
    });
    const runDml = vi.fn<(operations: DmlOperation[]) => Promise<DmlResult>>(
      () =>
        Promise.resolve({
          op2: { id: "t1", title: "Renamed", genre: "Pop" },
          op3: { id: "c9", track: "t1", role: "Producer" },
        }),
    );
    const model = form(undefined, { runDml });
    model.start();
    await flush();
    model.toggleField(ROOT_ID, credits(model), true);
    await flush();

    const removedChild = `${CREDITS_LIST}[0]`;
    model.commitEdit(ROOT_ID, "title", "Renamed");
    model.removeChild(ROOT_ID, credits(model), removedChild);
    model.addChild(ROOT_ID, credits(model));
    const created = `${CREDITS_LIST}[new:1]`;
    // Scaffolding a record opens its first editable field for typing.
    expect(model.store.getState().editing).toBe(fieldItemId(created, "role"));
    model.commitEdit(created, "role", "Producer");

    await model.save();

    expect(runDml.mock.calls[0]?.[0]).toEqual([
      { operation: "delete", id: "op1", table: "credit", where: { id: "c1" } },
      {
        operation: "update",
        id: "op2",
        table: "track",
        where: { id: "t1" },
        values: { title: "Renamed" },
      },
      {
        operation: "insert",
        id: "op3",
        table: "credit",
        values: { role: "Producer", track: "t1" },
      },
    ]);
    const s = model.store.getState();
    // Rebaselined: what was typed is what the database now holds.
    expect(s.records[ROOT_ID]?.original["title"]).toEqual(["Renamed"]);
    expect(selectFormModified(s)).toBe(false);
    // The removed record is gone, node and preview both.
    expect(s.records[removedChild]).toBeUndefined();
    expect(s.embeds[removedChild]).toBeUndefined();
    // The created one is a record now, keyed by the id the database issued.
    expect(s.records[created]?.isNew).toBe(false);
    expect(s.records[created]?.keys).toEqual([[{ column: "id", value: "c9" }]]);
    expect(s.lists[CREDITS_LIST]).toMatchObject({ removed: [], dirty: false });
  });

  it("keeps the changes and reports why when a save fails", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 0)] });
    const model = form(undefined, {
      runDml: () => Promise.reject(new Error("constraint violated")),
    });
    model.start();
    await flush();
    model.commitEdit(ROOT_ID, "title", "Renamed");

    await model.save();

    const s = model.store.getState();
    expect(s.saveError).toBe("constraint violated");
    expect(s.saving).toBe(false);
    expect(selectFormModified(s)).toBe(true);
  });
});

describe("reset", () => {
  it("discards every unsaved change and reloads the root", async () => {
    serve({
      track: [trackRow("t1", "Formation", "Pop", 0)],
    });
    const model = form();
    model.start();
    await flush();
    model.commitEdit(ROOT_ID, "title", "Renamed");
    model.addChild(ROOT_ID, credits(model));
    expect(selectFormModified(model.store.getState())).toBe(true);

    model.reset();
    let s = model.store.getState();
    expect(Object.keys(s.records)).toEqual([ROOT_ID]);
    expect(s.lists).toEqual({});
    expect(s.editing).toBeNull();

    await flush();
    s = model.store.getState();
    // The root, the list `addChild` opened, and the root again.
    expect(runner).toHaveBeenCalledTimes(3);
    expect(selectSharedValue(s, ROOT_ID, "title")).toBe("Formation");
    expect(selectFormModified(s)).toBe(false);
  });
});

describe("modification", () => {
  it("stars a collapsed field for an edit made anywhere inside it", async () => {
    serve({
      track: [trackRow("t1", "Formation", "Pop", 1)],
      credit: [creditRow("c1", "Vocals")],
    });
    const model = form();
    model.start();
    await flush();
    model.toggleField(ROOT_ID, credits(model), true);
    await flush();
    const child = `${CREDITS_LIST}[0]`;
    model.toggleChild(child, true);
    await flush();

    model.commitEdit(child, "role", "Lead");
    model.toggleField(ROOT_ID, credits(model), false);

    const s = model.store.getState();
    expect(selectFieldModified(s, ROOT_ID, "#credit")).toBe(true);
    expect(selectFieldModified(s, ROOT_ID, "title")).toBe(false);
    expect(selectFieldModified(s, child, "role")).toBe(true);
    expect(selectFormModified(s)).toBe(true);
  });

  it("mirrors the form's summary into the forms store", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 0)] });
    const forms = createFormsStore();
    const identities = ["track(id=t1)"];
    const model = forms.actions.stashedForm("tab", identities, () => form());
    forms.actions.mount("tab", identities);
    model.start();
    await flush();
    const modified = () => selectModifiedRecords(forms.store.getState(), "tab");

    expect(modified()).toEqual([]);
    model.commitEdit(ROOT_ID, "title", "Renamed");
    expect(modified()).toEqual(identities);
    model.commitEdit(ROOT_ID, "title", "Formation"); // back to the baseline
    expect(modified()).toEqual([]);

    const field: FormField = fieldOf(model, ROOT_ID, "title");
    model.noteFocus(fieldItemId(ROOT_ID, field.key));
    expect(selectFocusedForm(forms.store.getState())).toBe(model);
    model.noteBlur();
    expect(selectFocusedForm(forms.store.getState())).toBeUndefined();
  });
});
