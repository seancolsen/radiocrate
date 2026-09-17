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
  scalarChildId,
  selectCountMax,
  selectCountMin,
  distinctValues,
  selectFieldModified,
  selectFormModified,
  selectIsBulkBlocked,
  selectSharedValue,
  VARIED,
  variedChildId,
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
  // A table `track` points *at*, by the UUID-column-named-after-a-table
  // convention `inferLinks` reads — which is what makes `track.album` a scalar
  // linked record field rather than an id to type.
  {
    name: "album",
    columns: [col("id", "UUID"), col("title", "VARCHAR")],
    uniqueConstraints: [["id"]],
  },
  {
    name: "track",
    columns: [
      col("id", "UUID"),
      col("title", "VARCHAR"),
      col("genre", "VARCHAR", true),
      col("album", "UUID", true),
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
  // A join table, keyed by the pair rather than by an id of its own — the shape
  // that *groups*: two tracks tagged the same way say the same thing, and the
  // form lists that as one row (`record/childGroups.ts`). A child table with an
  // id of its own, like `credit` above, never groups: its records are distinct
  // by that id however much else they agree on.
  {
    name: "track_tag",
    columns: [
      col("track", "UUID"),
      col("tag", "VARCHAR"),
      col("note", "VARCHAR", true),
    ],
    uniqueConstraints: [["track", "tag"]],
  },
];

const runner = vi.mocked(runRecordQuery);

const trackKey = (id: string) => [{ column: "id", value: id }];

/** A row of the root's data query: the key, then `id`, `title`, `genre`,
 * `album` and the `#credit` and `#track_tag` counts, positionally (referencing
 * tables come alphabetically). */
const trackRow = (
  id: string,
  title: string,
  genre: string | null,
  credits: number,
  tags = 0,
  album: string | null = null,
) => [id, id, title, genre, album, String(credits), String(tags)];

/** A credit row, which fits both queries that reach the table: a child list
 * (key, then the `$id $role` preview) and a credit's own data (key, then its
 * `id` and `role` fields — `track` is hidden under its parent). */
const creditRow = (id: string, role: string | null) => [id, id, role];

/** A row of a `track_tag` list query: the key `(track, tag)`, the `$tag`
 * preview, then every column — which is what decides how the records group. */
const tagRow = (track: string, tag: string, note: string | null = null) => [
  track,
  tag,
  tag,
  track,
  tag,
  note,
];

/** A row of one `track_tag` row's own data query: the key, then its `tag` and
 * `note` fields (`track` is hidden under its parent). */
const tagDataRow = (track: string, tag: string, note: string | null = null) => [
  track,
  tag,
  tag,
  note,
];

/** Answers every query from fixed rows, by table. */
function serve(rows: {
  track?: RecordRows;
  credit?: RecordRows;
  track_tag?: RecordRows;
  /** The albums, by id → title: two queries reach one (its own data and the
   * preview an embedded record shows), and both are answered from this. */
  albums?: Record<string, string>;
}) {
  runner.mockImplementation(async (query) => {
    if (query.base === "track") return rows.track ?? [];
    if (query.base === "track_tag") return rows.track_tag ?? [];
    if (query.base === "credit") return rows.credit ?? [];
    // Two queries reach an album, both for the one the filter names: its own
    // data — the key, then `id`, `title` and the `#track` count — and the
    // `$title` preview an embedded record shows.
    const id = /id:="([^"]*)"/.exec(query.filter)?.[1] ?? "";
    const title = rows.albums?.[id];
    if (title === undefined) return [];
    return query.display.startsWith("$id") ? [[id, id, title, "1"]] : [[title]];
  });
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
/** A scalar field by key — a primitive or a link, which is what the actions
 * that take one value across every record the form is on are about. */
const scalarField = (model: RecordFormModel, recordId: string, key: string) => {
  const field = fieldOf(model, recordId, key);
  if (field.kind === "multiRecord") throw new Error(`${key} is not scalar`);
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

describe("opening child records", () => {
  it("hands over the field's records as a query, filtered and sorted as the field lists them", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 2)] });
    const openRecords = vi.fn();
    const model = form([trackKey("t1")], { openRecords });
    model.start();
    await flush();

    model.openChildRecords(ROOT_ID, credits(model));

    expect(openRecords).toHaveBeenCalledWith({
      base: "credit",
      filter: `track:="t1"`,
      sort: "\\\\id \\\\role",
      display: "$id $role",
    });
  });

  it("opens the records of every record the form is on", async () => {
    serve({
      track: [
        trackRow("t1", "Formation", "Pop", 2),
        trackRow("t2", "Sorry", "Pop", 2),
      ],
    });
    const openRecords = vi.fn();
    const model = form([trackKey("t1"), trackKey("t2")], { openRecords });
    model.start();
    await flush();

    model.openChildRecords(ROOT_ID, credits(model));

    // Both tracks' credits, filtered to either of them — and as the records
    // they are: a query tab shows rows, not the rows the form groups them into.
    expect(openRecords).toHaveBeenCalledWith({
      base: "credit",
      filter: `[\n  track:="t1"\n  track:="t2"\n]`,
      sort: "\\\\id \\\\role",
      display: "$id $role",
    });
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
    expect(selectIsBulkBlocked(s, ROOT_ID, "title")).toBe(false);
    // A multi-record field is never blocked: its records group into rows that
    // say the same thing about every record the form is on.
    expect(selectIsBulkBlocked(s, ROOT_ID, "#credit")).toBe(false);

    model.beginEdit(ROOT_ID, "genre");
    model.clearField(ROOT_ID, fieldOf(model, ROOT_ID, "genre"));
    model.toggleField(ROOT_ID, credits(model), true);
    s = model.store.getState();
    expect(s.editing).toBeNull();
    expect(s.records[ROOT_ID]?.values["genre"]).toEqual(["Pop", "Rock"]);
    expect(s.expanded[fieldItemId(ROOT_ID, "#credit")]).toBe(true);

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

describe("a field the records disagree on", () => {
  /** Three tracks: two on one album, one on another, each with its own genre —
   * a link and a primitive the form's records both disagree about, and disagree
   * about *unevenly*, so "commonest first" has something to order. */
  const serveThree = () =>
    serve({
      track: [
        trackRow("t1", "Same", "Pop", 0, 0, "a1"),
        trackRow("t2", "Same", "Rock", 0, 0, "a2"),
        trackRow("t3", "Same", "Rock", 0, 0, "a2"),
      ],
      albums: { a1: "Lemonade", a2: "4" },
    });

  const threeTracks = () =>
    form([trackKey("t1"), trackKey("t2"), trackKey("t3")]);

  it("lists the values they hold, the commonest first", async () => {
    serveThree();
    const model = threeTracks();
    model.start();
    await flush();

    const values = model.store.getState().records[ROOT_ID]?.values["genre"];
    expect(distinctValues(values)).toEqual([
      { value: "Rock", count: 2 },
      { value: "Pop", count: 1 },
    ]);
  });

  it("opens a disagreeing field although it blocks editing it", async () => {
    serveThree();
    const model = threeTracks();
    model.start();
    await flush();

    const genre = fieldOf(model, ROOT_ID, "genre");
    expect(selectIsBulkBlocked(model.store.getState(), ROOT_ID, "genre")).toBe(
      true,
    );
    model.toggleField(ROOT_ID, genre);
    expect(model.store.getState().expanded[fieldItemId(ROOT_ID, "genre")]).toBe(
      true,
    );
  });

  it("takes one value for every record, and opens it for editing", async () => {
    serveThree();
    const model = threeTracks();
    model.start();
    await flush();

    const genre = scalarField(model, ROOT_ID, "genre");
    model.toggleField(ROOT_ID, genre, true);
    model.useValueForAll(ROOT_ID, genre, "Rock");

    const s = model.store.getState();
    expect(s.records[ROOT_ID]?.values["genre"]).toEqual([
      "Rock",
      "Rock",
      "Rock",
    ]);
    expect(selectSharedValue(s, ROOT_ID, "genre")).toBe("Rock");
    // No longer varied, so no longer blocked — and the field has closed onto
    // the value it now holds, with the editor open on it.
    expect(selectIsBulkBlocked(s, ROOT_ID, "genre")).toBe(false);
    expect(s.expanded[fieldItemId(ROOT_ID, "genre")]).toBe(false);
    expect(s.editing).toBe(fieldItemId(ROOT_ID, "genre"));
    expect(selectFieldModified(s, ROOT_ID, "genre")).toBe(true);
  });

  it("previews a record per distinct value of a link, and opens any of them", async () => {
    serveThree();
    const model = threeTracks();
    model.start();
    await flush();

    model.toggleField(ROOT_ID, fieldOf(model, ROOT_ID, "album"), true);
    await flush();

    const a1 = variedChildId(ROOT_ID, "album", "a1");
    const a2 = variedChildId(ROOT_ID, "album", "a2");
    let s = model.store.getState();
    expect(s.embeds[a1]?.cells).toEqual(["Lemonade"]);
    expect(s.embeds[a2]?.cells).toEqual(["4"]);
    // The records themselves wait to be opened.
    expect(s.records[a1]?.status).toBe("unloaded");

    model.toggleChild(a1);
    await flush();
    s = model.store.getState();
    expect(s.records[a1]?.status).toBe("loaded");
    expect(selectSharedValue(s, a1, "title")).toBe("Lemonade");

    // An edit inside it is the field's, which is what the star above says.
    model.commitEdit(a1, "title", "Lemonade (Deluxe)");
    expect(selectFieldModified(model.store.getState(), ROOT_ID, "album")).toBe(
      true,
    );
  });

  it("points every record at one of those, keeping the preview it showed", async () => {
    serveThree();
    const model = threeTracks();
    model.start();
    await flush();

    const album = scalarField(model, ROOT_ID, "album");
    model.toggleField(ROOT_ID, album, true);
    await flush();
    model.useValueForAll(ROOT_ID, album, "a2");

    const s = model.store.getState();
    expect(s.records[ROOT_ID]?.values["album"]).toEqual(["a2", "a2", "a2"]);
    // The chosen record's preview becomes the field's own, without a further
    // request; the list it came from is gone, along with everything under it.
    expect(s.embeds[scalarChildId(ROOT_ID, "album")]?.cells).toEqual(["4"]);
    expect(s.embeds[variedChildId(ROOT_ID, "album", "a1")]).toBeUndefined();
    expect(s.records[variedChildId(ROOT_ID, "album", "a2")]).toBeUndefined();
    // A link has no text to type, so nothing is put into edit mode.
    expect(s.editing).toBeNull();
  });
});

describe("a multi-record field on several records", () => {
  const tagsField = (model: RecordFormModel) =>
    fieldOf(model, ROOT_ID, "#track_tag") as MultiRecordField;
  const TAGS_LIST = listId(ROOT_ID, "#track_tag");
  const ROCK = `${TAGS_LIST}[0]`;

  /** Two tracks tagged "Rock" alike, and "Soul" on the first alone. */
  const serveTags = () =>
    serve({
      track: [
        trackRow("t1", "Same", "Pop", 0, 2),
        trackRow("t2", "Same", "Pop", 0, 1),
      ],
      track_tag: [
        tagRow("t1", "Rock"),
        tagRow("t2", "Rock"),
        tagRow("t1", "Soul"),
      ],
    });

  /** The form on both tracks, with the `track_tag` field opened out. */
  async function opened(extra: Partial<RecordFormOptions> = {}) {
    serveTags();
    const model = form([trackKey("t1"), trackKey("t2")], extra);
    model.start();
    await flush();
    model.toggleField(ROOT_ID, tagsField(model), true);
    await flush();
    return model;
  }

  const saves = () =>
    vi.fn<(operations: DmlOperation[]) => Promise<DmlResult>>(() =>
      Promise.resolve({}),
    );

  it("collapses the records that say the same thing into one row", async () => {
    const model = await opened();
    const s = model.store.getState();

    // One query for both tracks' tags, filtered to either of them.
    expect(runner.mock.calls[1]?.[0].filter).toBe(
      `[\n  track:="t1"\n  track:="t2"\n]`,
    );
    expect(s.lists[TAGS_LIST]?.childIds).toEqual([ROCK, `${TAGS_LIST}[1]`]);
    // "Rock" is on both tracks: one row standing for two records, previewed by
    // what both of them say.
    expect(s.records[ROCK]?.keys).toEqual([
      [
        { column: "track", value: "t1" },
        { column: "tag", value: "Rock" },
      ],
      [
        { column: "track", value: "t2" },
        { column: "tag", value: "Rock" },
      ],
    ]);
    expect(s.embeds[ROCK]?.cells).toEqual(["Rock"]);
    // "Soul" is on the first track alone.
    expect(s.records[`${TAGS_LIST}[1]`]?.keys).toHaveLength(1);

    // So the field's count is a range: two tags on one track, one on the other.
    expect(selectCountMin(s, ROOT_ID, "#track_tag")).toBe(1);
    expect(selectCountMax(s, ROOT_ID, "#track_tag")).toBe(2);
  });

  it("edits every record a row stands for", async () => {
    const runDml = saves();
    const model = await opened({ runDml });
    // Expanding a row loads the records it stands for — both of them, in the
    // one query any node standing for several records makes.
    runner.mockImplementation(async () => [
      tagDataRow("t1", "Rock"),
      tagDataRow("t2", "Rock"),
    ]);
    model.toggleChild(ROCK, true);
    await flush();

    model.commitEdit(ROCK, "note", "Live");
    await model.save();

    expect(runDml.mock.calls[0]?.[0]).toEqual([
      {
        operation: "update",
        id: "op1",
        table: "track_tag",
        where: { track: "t1", tag: "Rock" },
        values: { note: "Live" },
      },
      {
        operation: "update",
        id: "op2",
        table: "track_tag",
        where: { track: "t2", tag: "Rock" },
        values: { note: "Live" },
      },
    ]);
  });

  it("deletes every record a row stands for", async () => {
    const runDml = saves();
    const model = await opened({ runDml });

    model.removeChild(ROOT_ID, tagsField(model), ROCK);
    // The row took a tag off each track, so both counts came down — one of
    // them to nothing.
    const s = model.store.getState();
    expect(s.records[ROOT_ID]?.counts["#track_tag"]).toEqual([1, 0]);

    await model.save();
    expect(runDml.mock.calls[0]?.[0]).toEqual([
      {
        operation: "delete",
        id: "op1",
        table: "track_tag",
        where: { track: "t1", tag: "Rock" },
      },
      {
        operation: "delete",
        id: "op2",
        table: "track_tag",
        where: { track: "t2", tag: "Rock" },
      },
    ]);
  });

  it("adds one record per record the form is on", async () => {
    const runDml = saves();
    const model = await opened({ runDml });

    model.addChild(ROOT_ID, tagsField(model));
    const created = `${TAGS_LIST}[new:1]`;
    const s = model.store.getState();
    // One row, standing for a record on each track — and both counts went up.
    expect(s.records[created]?.keys).toEqual([[], []]);
    expect(s.records[ROOT_ID]?.counts["#track_tag"]).toEqual([3, 2]);

    model.commitEdit(created, "tag", "Soul");
    await model.save();

    expect(runDml.mock.calls[0]?.[0]).toEqual([
      {
        operation: "insert",
        id: "op1",
        table: "track_tag",
        values: { tag: "Soul", track: "t1" },
      },
      {
        operation: "insert",
        id: "op2",
        table: "track_tag",
        values: { tag: "Soul", track: "t2" },
      },
    ]);
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
