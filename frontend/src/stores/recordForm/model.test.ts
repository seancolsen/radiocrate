import type { FieldRef } from "api-client";
import {
  defaultFieldMetadata,
  fieldRefKey,
  type MetadataByTable,
} from "../../query/fieldMetadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DmlOperation, DmlResult } from "api-client";
import type { RecordRows } from "../../query/recordData";
import type { SchemaTable } from "../../query/schema";
import type {
  FormField,
  MultiRecordField,
  ScalarLinkField,
} from "../../query/recordForm";

vi.mock("../../query/recordData", () => ({
  runRecordQuery: vi.fn(),
  isCompileError: (err: unknown) =>
    err instanceof Error && err.message.startsWith("compile:"),
}));

import { runRecordQuery } from "../../query/recordData";
import {
  createFormsStore,
  selectFocusedForm,
  selectModifiedRecords,
} from "../forms";
import {
  createExpansionMemory,
  createRecordForm,
  distinctItemId,
  fieldItemId,
  listId,
  ROOT_ID,
  scalarChildId,
  selectCountMax,
  selectCountMin,
  distinctValues,
  selectDistinctCount,
  selectEmbedEditorFocusAsked,
  selectEmbedEditorOpen,
  selectFieldModified,
  selectAnyExpanded,
  selectCanAutocomplete,
  selectFormSummary,
  selectIsAutocompleting,
  selectFormModified,
  selectHiddenFieldCount,
  selectIsBulkBlocked,
  selectListsDistinct,
  selectSharedValue,
  VARIED,
  variedChildId,
  type ExpansionMemory,
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
  // Has a required timestamp, which a record drafted into it starts at "now".
  {
    name: "play",
    columns: [
      col("id", "UUID"),
      col("track", "UUID"),
      col("played_at", "TIMESTAMP"),
      col("skipped_at", "TIMESTAMP", true),
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

const fieldMeta = (visible: boolean, order: number | null) => ({
  ...defaultFieldMetadata(),
  visible,
  order,
});

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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

describe("selectHiddenFieldCount", () => {
  const hide = (...fields: (string | FieldRef)[]) =>
    Object.fromEntries(
      fields.map((field) => [
        fieldRefKey(typeof field === "string" ? { columnName: field } : field),
        fieldMeta(false, null),
      ]),
    );
  const CREDITS_LINK: FieldRef = {
    multiLink: { relatedTableName: "credit", fkColumnName: "track" },
  };

  it("is zero without any metadata", () => {
    expect(selectHiddenFieldCount(form().store.getState(), {})).toBe(0);
  });

  it("counts the fields of the form's table, whichever kind they are", () => {
    const s = form().store.getState();
    expect(
      selectHiddenFieldCount(s, {
        track: {
          ...hide("title", CREDITS_LINK),
          [fieldRefKey({ columnName: "genre" })]: fieldMeta(true, 1),
        },
      }),
    ).toBe(2);
  });

  it("ignores other tables, and fields the table no longer has", () => {
    const s = form().store.getState();
    expect(
      selectHiddenFieldCount(s, {
        track: hide("gone", {
          multiLink: { relatedTableName: "credit", fkColumnName: "gone" },
        }),
        credit: hide("role"),
      }),
    ).toBe(0);
  });

  it("counts a nested record's table, and each field once", async () => {
    serve({
      track: [trackRow("t1", "Formation", "Pop", 2)],
      credit: [creditRow("c1", "Lead"), creditRow("c2", "Featured")],
    });
    const model = form();
    model.start();
    await flush();
    model.toggleField(ROOT_ID, credits(model));
    await flush();
    const s = model.store.getState();
    expect(
      selectHiddenFieldCount(s, {
        track: hide("title"),
        // `track` is the credits' contextual filter here, so they have no such
        // field to hide. `role` is there on both of them.
        credit: hide("role", "track"),
      }),
    ).toBe(2);
  });
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

describe("customizing a field's embedded records", () => {
  const CREDITS_REF = fieldRefKey({
    multiLink: { relatedTableName: "credit", fkColumnName: "track" },
  });
  const ALBUM_REF = fieldRefKey({ columnName: "album" });
  /** A row of the credit list: the key, the given preview, then every column. */
  const listRow = (
    id: string,
    role: string | null,
    preview: readonly (string | null)[],
  ) => [id, ...preview, id, "t1", role];
  /** The settling `refreshEmbeds` waits for, and what lands after it. */
  const settle = () => vi.advanceTimersByTimeAsync(300);

  /** A form whose field metadata is `metadata.current` at the moment it's read. */
  function customizable(initial: MetadataByTable = {}) {
    const metadata = { current: initial };
    const model = form([trackKey("t1")], {
      fieldMetadata: () => metadata.current,
    });
    return { model, metadata };
  }
  const creditsCustom = (
    display: string | null,
    sorting: string | null = null,
  ) => ({
    track: { [CREDITS_REF]: { ...defaultFieldMetadata(), display, sorting } },
  });
  const albumCustom = (display: string | null) => ({
    track: { [ALBUM_REF]: { ...defaultFieldMetadata(), display } },
  });
  /** A form with its credits listed, in that order. */
  async function listed(
    rows: RecordRows,
    initial: MetadataByTable = creditsCustom("$role"),
  ) {
    serve({
      track: [trackRow("t1", "Formation", "Pop", rows.length)],
      credit: rows,
    });
    const built = customizable(initial);
    built.model.start();
    await settle();
    built.model.toggleField(ROOT_ID, credits(built.model), true);
    await settle();
    return built;
  }
  const cellsOf = (model: RecordFormModel, id: string) =>
    model.store.getState().embeds[id]?.cells;
  const childAt = (index: number) => `${CREDITS_LIST}[${index}]`;
  const childIds = (model: RecordFormModel) =>
    model.store.getState().lists[CREDITS_LIST]?.childIds;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lists a multi-record field by what the user wrote, however many columns it asks for", async () => {
    const { model } = await listed(
      [listRow("c1", "Vocals", ["Vocals", "One", "Two"])],
      creditsCustom("$role $a $b // note", "\\\\role \\d"),
    );
    const query = runner.mock.calls.at(-1)?.[0];
    expect(query?.display).toBe("$id $role $a $b // note\n$id $track $role");
    expect(query?.sort).toBe("\\\\role \\d");
    expect(cellsOf(model, childAt(0))).toEqual(["Vocals", "One", "Two"]);
  });

  it("previews a scalar linked record by what the user wrote", async () => {
    serve({
      track: [trackRow("t1", "Formation", "Pop", 0, 0, "a1")],
      albums: { a1: "Lemonade" },
    });
    const { model } = customizable(albumCustom("$title $id"));
    model.start();
    await settle();
    expect(runner.mock.calls.at(-1)?.[0].display).toBe("$title $id");
  });

  it("shows the key for a display left blank, with no query to run", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 0, 0, "a1")] });
    const { model } = customizable(albumCustom("  "));
    model.start();
    await settle();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(cellsOf(model, scalarChildId(ROOT_ID, "album"))).toEqual(["a1"]);
  });

  it("falls back to the generated query when a stored one won't run, on first listing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    serve({ track: [trackRow("t1", "Formation", "Pop", 1)] });
    const { model } = customizable(creditsCustom("$gone"));
    model.start();
    await settle();
    runner
      .mockRejectedValueOnce(new Error("compile: no column gone"))
      .mockResolvedValueOnce([["c1", "c1", "Vocals", "c1", "t1", "Vocals"]]);
    model.toggleField(ROOT_ID, credits(model), true);
    await settle();
    expect(model.store.getState().lists[CREDITS_LIST]?.status).toBe("loaded");
    expect(cellsOf(model, childAt(0))).toEqual(["c1", "Vocals"]);
    error.mockRestore();
  });

  it("re-fetches once the text has settled, not on every change", async () => {
    const { model, metadata } = await listed([
      listRow("c1", "Vocals", ["Vocals"]),
    ]);
    runner.mockClear();
    const change = [{ table: "track", fieldKey: CREDITS_REF }];
    metadata.current = creditsCustom("$id");
    model.refreshEmbeds(change);
    await vi.advanceTimersByTimeAsync(299);
    metadata.current = creditsCustom("$id $role");
    model.refreshEmbeds(change);
    await vi.advanceTimersByTimeAsync(299);
    expect(runner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0].display).toContain("$id $id $role\n");
  });

  it("leaves another field's records alone", async () => {
    const { model } = await listed([listRow("c1", "Vocals", ["Vocals"])]);
    runner.mockClear();
    model.refreshEmbeds([{ table: "track", fieldKey: ALBUM_REF }]);
    model.refreshEmbeds([{ table: "album", fieldKey: CREDITS_REF }]);
    await settle();
    expect(runner).not.toHaveBeenCalled();
  });

  it("re-sorts a list in place, its rows keeping their ids, edits and expansion", async () => {
    const { model, metadata } = await listed([
      listRow("c1", "Vocals", ["Vocals"]),
      listRow("c2", "Bass", ["Bass"]),
    ]);
    const [first, second] = [childAt(0), childAt(1)];
    model.toggleChild(first, true);
    await settle();
    model.editValue(second, "role", "Edited");
    model.clickEmbedded(second, { shift: false, ctrl: false });

    metadata.current = creditsCustom("$role $id", "\\\\role");
    runner.mockResolvedValueOnce([
      listRow("c2", "Bass", ["Bass", "c2"]),
      listRow("c1", "Vocals", ["Vocals", "c1"]),
    ]);
    model.refreshEmbeds([{ table: "track", fieldKey: CREDITS_REF }]);
    await settle();

    const s = model.store.getState();
    expect(childIds(model)).toEqual([second, first]);
    expect(cellsOf(model, first)).toEqual(["Vocals", "c1"]);
    expect(s.expanded[first]).toBe(true);
    expect(s.records[second]?.values["role"]).toEqual(["Edited"]);
    expect(s.selection).toEqual([second]);
    expect(s.lists[CREDITS_LIST]?.status).toBe("loaded");
  });

  it("keeps a list's own changes through a refresh", async () => {
    const { model, metadata } = await listed([
      listRow("c1", "Vocals", ["Vocals"]),
      listRow("c2", "Bass", ["Bass"]),
      listRow("c3", "Keys", ["Keys"]),
    ]);
    const field = credits(model);
    model.removeChild(ROOT_ID, field, childAt(0));
    model.addChild(ROOT_ID, field);
    const created = childIds(model)?.[0];

    metadata.current = creditsCustom("$role $id");
    runner.mockResolvedValueOnce([
      listRow("c1", "Vocals", ["Vocals", "c1"]),
      // The list hasn't heard of this one.
      listRow("c9", "Drums", ["Drums", "c9"]),
      // c3 isn't there any more, and c2 is.
      listRow("c2", "Bass", ["Bass", "c2"]),
    ]);
    model.refreshEmbeds([{ table: "track", fieldKey: CREDITS_REF }]);
    await settle();

    const ids = childIds(model) ?? [];
    expect(ids[0]).toBe(created);
    const newcomer = ids[1];
    expect(cellsOf(model, newcomer ?? "")).toEqual(["Drums", "c9"]);
    expect(ids.slice(2)).toEqual([childAt(1), childAt(2)]);
    expect(ids).not.toContain(childAt(0));
    expect(model.store.getState().records[childAt(0)]).toBeDefined(); // still on its way out, for the save
  });

  it("keeps what's on screen while a refresh runs, and when the database refuses it", async () => {
    const { model, metadata } = await listed([
      listRow("c1", "Vocals", ["Vocals"]),
    ]);
    const itemId = fieldItemId(ROOT_ID, "#credit");
    const change = [{ table: "track", fieldKey: CREDITS_REF }];

    const pending = deferred<RecordRows>();
    metadata.current = creditsCustom("$id");
    runner.mockReturnValueOnce(pending.promise);
    model.refreshEmbeds(change);
    await settle();
    expect(cellsOf(model, childAt(0))).toEqual(["Vocals"]);
    pending.reject(new Error("Binder Error: nope"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cellsOf(model, childAt(0))).toEqual(["Vocals"]);
    expect(model.store.getState().embedErrors[itemId]).toBe(
      "Binder Error: nope",
    );

    runner.mockResolvedValueOnce([listRow("c1", "Vocals", ["c1"])]);
    model.refreshEmbeds(change);
    await settle();
    expect(cellsOf(model, childAt(0))).toEqual(["c1"]);
    expect(model.store.getState().embedErrors[itemId]).toBeUndefined();
  });

  it("leaves Querydown that won't compile to the editor's own check", async () => {
    const { model, metadata } = await listed([
      listRow("c1", "Vocals", ["Vocals"]),
    ]);
    metadata.current = creditsCustom("$");
    runner.mockRejectedValueOnce(new Error("compile: expected a column"));
    model.refreshEmbeds([{ table: "track", fieldKey: CREDITS_REF }]);
    await settle();
    expect(model.store.getState().embedErrors).toEqual({});
    expect(cellsOf(model, childAt(0))).toEqual(["Vocals"]);
  });

  it("only ever lets the newest refresh land", async () => {
    const { model, metadata } = await listed([
      listRow("c1", "Vocals", ["Vocals"]),
    ]);
    const change = [{ table: "track", fieldKey: CREDITS_REF }];
    const stale = deferred<RecordRows>();
    metadata.current = creditsCustom("$id");
    runner.mockReturnValueOnce(stale.promise);
    model.refreshEmbeds(change);
    await settle();
    runner.mockResolvedValueOnce([listRow("c1", "Vocals", ["newest"])]);
    model.refreshEmbeds(change);
    await settle();
    stale.resolve([listRow("c1", "Vocals", ["stale"])]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cellsOf(model, childAt(0))).toEqual(["newest"]);
  });

  it("refreshes a scalar linked record's embedded record in place", async () => {
    serve({
      track: [trackRow("t1", "Formation", "Pop", 0, 0, "a1")],
      albums: { a1: "Lemonade" },
    });
    const { model, metadata } = customizable();
    model.start();
    await settle();
    const id = scalarChildId(ROOT_ID, "album");
    expect(cellsOf(model, id)).toEqual(["Lemonade"]);

    metadata.current = albumCustom("$title $id");
    const pending = deferred<RecordRows>();
    runner.mockReturnValueOnce(pending.promise);
    model.refreshEmbeds([{ table: "track", fieldKey: ALBUM_REF }]);
    await settle();
    expect(cellsOf(model, id)).toEqual(["Lemonade"]);
    expect(model.store.getState().embeds[id]?.status).toBe("loaded");
    pending.resolve([["Lemonade", "a1"]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(cellsOf(model, id)).toEqual(["Lemonade", "a1"]);
    expect(runner.mock.calls.at(-1)?.[0].display).toBe("$title $id");
  });

  it("refreshes each value's embedded record when the records disagree", async () => {
    serve({
      track: [
        trackRow("t1", "A", "Pop", 0, 0, "a1"),
        trackRow("t2", "B", "Pop", 0, 0, "a2"),
      ],
      albums: { a1: "One", a2: "Two" },
    });
    const metadata: { current: MetadataByTable } = { current: {} };
    const model = form([trackKey("t1"), trackKey("t2")], {
      fieldMetadata: () => metadata.current,
    });
    model.start();
    await settle();
    model.toggleField(
      ROOT_ID,
      fieldOf(model, ROOT_ID, "album") as ScalarLinkField,
      true,
    );
    await settle();
    metadata.current = albumCustom("$id");
    runner.mockClear();
    runner.mockImplementation(async (query) => [
      [`cell of ${/id:="([^"]*)"/.exec(query.filter)?.[1]}`],
    ]);
    model.refreshEmbeds([{ table: "track", fieldKey: ALBUM_REF }]);
    await settle();
    expect(runner).toHaveBeenCalledTimes(2);
    expect(cellsOf(model, variedChildId(ROOT_ID, "album", "a2"))).toEqual([
      "cell of a2",
    ]);
  });

  it("opens the same query in a new tab as the field lists", async () => {
    const openRecords = vi.fn();
    serve({ track: [trackRow("t1", "Formation", "Pop", 2)] });
    const model = form([trackKey("t1")], {
      openRecords,
      fieldMetadata: () => creditsCustom("$role", "\\\\role"),
    });
    model.start();
    await settle();
    model.openChildRecords(ROOT_ID, credits(model));
    expect(openRecords.mock.calls[0]?.[0]).toMatchObject({
      display: "$role",
      sort: "\\\\role",
    });
  });

  it("seeds the record picker with what the field shows", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 0)] });
    const { model } = customizable(albumCustom("$id $title"));
    model.start();
    await settle();
    const field = fieldOf(model, ROOT_ID, "album") as ScalarLinkField;
    expect(model.fieldSpec(ROOT_ID, field).display).toEqual(["$id $title"]);
  });

  it("previews a newly saved record the way its siblings are", async () => {
    const runDml = vi.fn(async () => ({
      op0: { id: "c9", track: "t1", role: "Drums" },
    }));
    const saved = form([trackKey("t1")], {
      runDml,
      fieldMetadata: () => creditsCustom("$role"),
    });
    serve({ track: [trackRow("t1", "Formation", "Pop", 0)] });
    saved.start();
    await settle();
    saved.addChild(ROOT_ID, credits(saved));
    await settle();
    const created =
      saved.store.getState().lists[CREDITS_LIST]?.childIds[0] ?? "";
    saved.editValue(created, "role", "Drums");
    runner.mockClear();
    runner.mockResolvedValue([["Drums"]]);
    await saved.save();
    await settle();
    expect(runner.mock.calls.at(-1)?.[0].display).toBe("$role");
  });

  it("opens an editor, and a multi-record field with it so its records show", async () => {
    const { model } = await listed([listRow("c1", "Vocals", ["Vocals"])]);
    const field = credits(model);
    model.toggleField(ROOT_ID, field, false);
    model.openEmbedEditor(ROOT_ID, field, "sorting");
    const s = model.store.getState();
    expect(selectEmbedEditorOpen(s, ROOT_ID, field.key, "sorting")).toBe(true);
    expect(selectEmbedEditorOpen(s, ROOT_ID, field.key, "display")).toBe(false);
    expect(s.expanded[fieldItemId(ROOT_ID, field.key)]).toBe(true);

    model.closeEmbedEditor(ROOT_ID, field.key, "sorting");
    expect(
      selectEmbedEditorOpen(
        model.store.getState(),
        ROOT_ID,
        field.key,
        "sorting",
      ),
    ).toBe(false);
  });

  it("asks for the caret when an editor is opened, until it has it", async () => {
    const { model } = await listed([listRow("c1", "Vocals", ["Vocals"])]);
    const field = credits(model);
    model.openEmbedEditor(ROOT_ID, field, "display");
    const asked = () =>
      selectEmbedEditorFocusAsked(
        model.store.getState(),
        ROOT_ID,
        field.key,
        "display",
      );
    expect(asked()).toBe(true);
    model.noteEmbedEditorFocused();
    expect(asked()).toBe(false);
  });

  it("doesn't open a field with no records to show", async () => {
    const { model } = await listed([]);
    const field = credits(model);
    model.toggleField(ROOT_ID, field, false);
    model.openEmbedEditor(ROOT_ID, field, "display");
    expect(
      model.store.getState().expanded[fieldItemId(ROOT_ID, field.key)],
    ).toBe(false);
  });

  it("drops a pending refresh when it's disposed", async () => {
    const { model } = await listed([listRow("c1", "Vocals", ["Vocals"])]);
    runner.mockClear();
    model.refreshEmbeds([{ table: "track", fieldKey: CREDITS_REF }]);
    model.dispose();
    await settle();
    expect(runner).not.toHaveBeenCalled();
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

    // Named for the field's table and the one record the form is on.
    expect(openRecords).toHaveBeenCalledWith(
      {
        base: "credit",
        filter: `track:="t1"`,
        sort: "\\\\id \\\\role",
        display: "$id $role",
      },
      "credits: Formation",
    );
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
    // …and with no one record to describe, named for the table alone.
    expect(openRecords).toHaveBeenCalledWith(
      {
        base: "credit",
        filter: `[\n  track:="t1"\n  track:="t2"\n]`,
        sort: "\\\\id \\\\role",
        display: "$id $role",
      },
      "credits",
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

  it("edits one value for the records holding it, and only those", async () => {
    serveThree();
    const runDml = vi.fn<(operations: DmlOperation[]) => Promise<DmlResult>>(
      () => Promise.resolve({}),
    );
    const model = form([trackKey("t1"), trackKey("t2"), trackKey("t3")], {
      runDml,
    });
    model.start();
    await flush();

    const genre = fieldOf(model, ROOT_ID, "genre");
    if (genre.kind !== "primitive") throw new Error("genre is a primitive");
    model.toggleField(ROOT_ID, genre, true);
    model.beginEditDistinct(ROOT_ID, genre, "Rock");
    expect(model.store.getState().editing).toBe(
      distinctItemId(ROOT_ID, "genre", "Rock"),
    );

    // Typing writes through to t2 and t3 as it goes. Passing through "Pop" —
    // what t1 holds — brings every record into agreement for a moment, but the
    // field keeps listing the values as they were when the edit began, so the
    // editor stays where it is.
    model.editDistinct("Pop");
    let s = model.store.getState();
    expect(s.records[ROOT_ID]?.values["genre"]).toEqual(["Pop", "Pop", "Pop"]);
    expect(selectListsDistinct(s, ROOT_ID, "genre")).toBe(true);
    expect(selectDistinctCount(s, ROOT_ID, "genre")).toBe(2);

    model.editDistinct("Pop rock");
    model.commitDistinct("Pop rock");
    s = model.store.getState();
    expect(s.editing).toBeNull();
    expect(s.records[ROOT_ID]?.values["genre"]).toEqual([
      "Pop",
      "Pop rock",
      "Pop rock",
    ]);
    expect(selectFieldModified(s, ROOT_ID, "genre")).toBe(true);
    // Still disagreeing, so the field stays open on its two values.
    expect(s.expanded[fieldItemId(ROOT_ID, "genre")]).toBe(true);

    await model.save();
    expect(runDml.mock.calls[0]?.[0]).toEqual([
      {
        operation: "update",
        id: "op1",
        table: "track",
        where: { id: "t2" },
        values: { genre: "Pop rock" },
      },
      {
        operation: "update",
        id: "op2",
        table: "track",
        where: { id: "t3" },
        values: { genre: "Pop rock" },
      },
    ]);
  });

  it("closes onto one value when an edit brings every record into agreement", async () => {
    serveThree();
    const model = threeTracks();
    model.start();
    await flush();

    const genre = fieldOf(model, ROOT_ID, "genre");
    if (genre.kind !== "primitive") throw new Error("genre is a primitive");
    model.toggleField(ROOT_ID, genre, true);
    // An expanded value stays expanded under its new value…
    model.toggleChild(distinctItemId(ROOT_ID, "genre", "Pop"), true);
    model.beginEditDistinct(ROOT_ID, genre, "Pop");
    model.commitDistinct("Rock");

    const s = model.store.getState();
    expect(s.records[ROOT_ID]?.values["genre"]).toEqual([
      "Rock",
      "Rock",
      "Rock",
    ]);
    expect(selectSharedValue(s, ROOT_ID, "genre")).toBe("Rock");
    expect(selectListsDistinct(s, ROOT_ID, "genre")).toBe(false);
    // …but with nothing left to list, the field itself closes.
    expect(s.expanded[fieldItemId(ROOT_ID, "genre")]).toBe(false);
    expect(s.expanded[distinctItemId(ROOT_ID, "genre", "Rock")]).toBe(true);
  });

  it("re-points the records holding one linked record at another", async () => {
    serveThree();
    const model = threeTracks();
    model.start();
    await flush();

    const album = fieldOf(model, ROOT_ID, "album");
    if (album.kind !== "scalarLink") throw new Error("album is a link");
    model.toggleField(ROOT_ID, album, true);
    await flush();
    const a1 = variedChildId(ROOT_ID, "album", "a1");
    model.toggleChild(a1, true);

    model.openPicker(ROOT_ID, "album", { value: "a1" });
    expect(model.store.getState().picker).toEqual({
      recordId: ROOT_ID,
      fieldKey: "album",
      distinct: { value: "a1" },
    });
    model.pickDistinctRecord(ROOT_ID, album, "a1", "a3", ["Renaissance"]);

    let s = model.store.getState();
    expect(s.picker).toBeNull();
    expect(s.records[ROOT_ID]?.values["album"]).toEqual(["a3", "a2", "a2"]);
    // The record it pointed at goes, with whatever was opened under it; the one
    // it points at now is previewed from what the picker loaded.
    expect(s.records[a1]).toBeUndefined();
    expect(s.expanded[a1]).toBeUndefined();
    const a3 = variedChildId(ROOT_ID, "album", "a3");
    expect(s.embeds[a3]?.cells).toEqual(["Renaissance"]);
    expect(s.records[a3]?.status).toBe("unloaded");

    // Re-pointing the last of them onto the others' record is taking it for
    // all: the field is an ordinary link again, showing that record.
    model.pickDistinctRecord(ROOT_ID, album, "a3", "a2", ["4"]);
    s = model.store.getState();
    expect(s.records[ROOT_ID]?.values["album"]).toEqual(["a2", "a2", "a2"]);
    expect(s.embeds[scalarChildId(ROOT_ID, "album")]?.cells).toEqual(["4"]);
    expect(s.records[a3]).toBeUndefined();
    expect(s.expanded[fieldItemId(ROOT_ID, "album")]).toBe(false);
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
  it("is unmodified again once an added record is removed", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 0)] });
    const model = form();
    model.start();
    await flush();

    model.addChild(ROOT_ID, credits(model));
    expect(
      selectFieldModified(model.store.getState(), ROOT_ID, "#credit"),
    ).toBe(true);
    model.removeChild(ROOT_ID, credits(model), `${CREDITS_LIST}[new:1]`);

    const s = model.store.getState();
    expect(s.lists[CREDITS_LIST]?.childIds).toEqual([]);
    expect(selectFieldModified(s, ROOT_ID, "#credit")).toBe(false);
    expect(selectFormModified(s)).toBe(false);
  });

  it("starts a required timestamp of a drafted record at now", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 0)] });
    const model = form();
    model.start();
    await flush();

    model.addChild(
      ROOT_ID,
      fieldOf(model, ROOT_ID, "#play") as MultiRecordField,
    );
    const child =
      model.store.getState().lists[listId(ROOT_ID, "#play")]?.childIds[0];
    const s = model.store.getState();
    expect(selectSharedValue(s, child!, "played_at")).toMatch(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/,
    );
    expect(selectSharedValue(s, child!, "skipped_at")).toBeNull();
  });

  it("collapses everything that is expanded", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 0)] });
    const model = form();
    model.start();
    await flush();
    expect(selectAnyExpanded(model.store.getState())).toBe(false);

    model.toggleField(ROOT_ID, credits(model), true);
    expect(selectAnyExpanded(model.store.getState())).toBe(true);
    model.collapseAll();
    expect(selectAnyExpanded(model.store.getState())).toBe(false);
  });

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

describe("remembered expansion", () => {
  /** A memory over a fake `localStorage`, returned with it so a test can start a
   * second memory from what the first one wrote, as a new visit would. */
  function memory(items = new Map<string, string>()) {
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
    return { expansion: createExpansionMemory({ storage }), items };
  }

  const CREDITS = fieldItemId(ROOT_ID, "#credit");
  const FIRST = `${CREDITS_LIST}[0]`;
  const SECOND = `${CREDITS_LIST}[1]`;

  function serveTracks() {
    serve({
      track: [
        trackRow("t1", "Formation", "Pop", 2, 0, "a1"),
        trackRow("t2", "Sorry", "Pop", 2, 0, "a1"),
      ],
      credit: [creditRow("c1", "Lead"), creditRow("c2", "Featured")],
      albums: { a1: "Lemonade" },
    });
  }

  /** A form on a track, opened and loaded. */
  async function opened(expansion: ExpansionMemory, id = "t1") {
    const model = form([trackKey(id)], { expansion });
    model.start();
    await flush();
    await flush();
    await flush();
    return model;
  }

  it("reopens the tree from the top, on another record, down to the same paths", async () => {
    serveTracks();
    const { expansion } = memory();
    const first = await opened(expansion);
    first.toggleField(ROOT_ID, credits(first));
    await flush();
    first.toggleChild(FIRST);
    await flush();

    const second = await opened(expansion, "t2");
    const s = second.store.getState();
    expect(s.expanded[CREDITS]).toBe(true);
    expect(s.lists[CREDITS_LIST]?.status).toBe("loaded");
    // Only the record the user opened, by its place in the list.
    expect(s.expanded[FIRST]).toBe(true);
    expect(s.records[FIRST]?.status).toBe("loaded");
    expect(s.expanded[SECOND]).toBeUndefined();
    expect(s.records[SECOND]?.status).toBe("unloaded");
  });

  it("survives into a new visit", async () => {
    serveTracks();
    const { expansion, items } = memory();
    const first = await opened(expansion);
    first.toggleField(ROOT_ID, credits(first));
    await flush();

    const later = await opened(memory(items).expansion);
    expect(later.store.getState().expanded[CREDITS]).toBe(true);
  });

  it("keeps a path to its root table", async () => {
    serveTracks();
    const { expansion } = memory();
    expansion.set("credit", CREDITS, true);
    const model = await opened(expansion);
    expect(model.store.getState().expanded[CREDITS]).toBeUndefined();
  });

  it("reopens a linked record's own fields under it", async () => {
    serveTracks();
    const { expansion } = memory();
    const album = fieldItemId(ROOT_ID, "album");
    const child = scalarChildId(ROOT_ID, "album");
    const tracks = fieldItemId(child, "#track");
    expansion.set("track", album, true);
    expansion.set("track", tracks, true);
    const model = await opened(expansion);
    const s = model.store.getState();
    expect(s.expanded[album]).toBe(true);
    expect(s.records[child]?.status).toBe("loaded");
    expect(s.expanded[tracks]).toBe(true);
  });

  it("forgets what the user closes, and only that", async () => {
    serveTracks();
    const { expansion } = memory();
    const first = await opened(expansion);
    first.toggleField(ROOT_ID, credits(first));
    await flush();
    first.toggleChild(FIRST);
    await flush();
    first.toggleField(ROOT_ID, credits(first));

    expect(expansion.has("track", CREDITS)).toBe(false);
    // What's inside stays, so the field opens back onto it, as it does in a form.
    expect(expansion.has("track", FIRST)).toBe(true);
    const second = await opened(expansion, "t2");
    expect(second.store.getState().expanded[FIRST]).toBeUndefined();
    second.toggleField(ROOT_ID, credits(second));
    await flush();
    expect(second.store.getState().expanded[FIRST]).toBe(true);
  });

  it("forgets the lot on Collapse all", async () => {
    serveTracks();
    const { expansion, items } = memory();
    expansion.set("track", `${CREDITS_LIST}[5]`, true);
    const model = await opened(expansion);
    model.toggleField(ROOT_ID, credits(model));
    await flush();
    model.collapseAll();
    expect(expansion.has("track", CREDITS)).toBe(false);
    expect(expansion.has("track", `${CREDITS_LIST}[5]`)).toBe(false);
    expect(items.size).toBe(0);
  });

  it("keeps the memory of a field with nothing to open on this record", async () => {
    serve({ track: [trackRow("t1", "Formation", "Pop", 0)] });
    const { expansion } = memory();
    expansion.set("track", CREDITS, true);
    const model = await opened(expansion);
    expect(model.store.getState().expanded[CREDITS]).toBeUndefined();
    expect(expansion.has("track", CREDITS)).toBe(true);
  });

  it("doesn't count an opening the user didn't ask for", async () => {
    serveTracks();
    const { expansion } = memory();
    const model = await opened(expansion);
    model.addChild(ROOT_ID, credits(model));
    expect(model.store.getState().expanded[CREDITS]).toBe(true);
    expect(expansion.has("track", CREDITS)).toBe(false);
  });

  it("opens a text field only once its row says it's cut off", async () => {
    serveTracks();
    const { expansion } = memory();
    const title = fieldItemId(ROOT_ID, "title");
    expansion.set("track", title, true);
    const model = await opened(expansion);
    expect(model.store.getState().expanded[title]).toBeUndefined();
    model.restoreTextField(ROOT_ID, "title");
    expect(model.store.getState().expanded[title]).toBe(true);
  });

  it("doesn't reopen what this form has closed", async () => {
    serveTracks();
    const { expansion } = memory();
    const title = fieldItemId(ROOT_ID, "title");
    const model = await opened(expansion);
    model.toggleField(ROOT_ID, scalarField(model, ROOT_ID, "title"), true);
    model.toggleField(ROOT_ID, scalarField(model, ROOT_ID, "title"), false);
    expansion.set("track", title, true);
    model.restoreTextField(ROOT_ID, "title");
    expect(model.store.getState().expanded[title]).toBe(false);
  });

  it("doesn't remember items that name a value or a made-up record", () => {
    const { expansion } = memory();
    const model = form([trackKey("t1")], { expansion });
    const ids = [
      distinctItemId(ROOT_ID, "genre", "Rock"),
      distinctItemId(ROOT_ID, "genre", null),
      variedChildId(ROOT_ID, "album", "a1"),
      `${CREDITS_LIST}[new:1]`,
    ];
    for (const id of ids) {
      model.toggleChild(id, true);
      expect(expansion.has("track", id)).toBe(false);
    }
  });

  it("restores nothing from a value it can't read", () => {
    const { expansion } = memory(new Map([["recordExpansion", "{not json"]]));
    expect(expansion.has("track", CREDITS)).toBe(false);
    const other = memory(
      new Map([
        ["recordExpansion", JSON.stringify({ track: "r", album: [1] })],
      ]),
    ).expansion;
    expect(other.has("track", "r")).toBe(false);
    expect(other.has("album", "1")).toBe(false);
  });
});

describe("autocomplete", () => {
  /** A form on `t1` with its data landed, and `title` in edit mode. */
  async function editing() {
    serve({ track: [trackRow("t1", "Sorry", "Pop", 0)] });
    const model = form();
    model.start();
    await flush();
    model.beginEdit(ROOT_ID, "title");
    return model;
  }
  const state = (model: RecordFormModel) => model.store.getState();
  const on = (model: RecordFormModel, key = "title") =>
    selectIsAutocompleting(state(model), fieldItemId(ROOT_ID, key));

  it("is only offered on a field in edit mode", async () => {
    const model = await editing();
    expect(selectCanAutocomplete(state(model))).toBe(true);
    model.commitEdit(ROOT_ID, "title", "Sorry");
    expect(selectCanAutocomplete(state(model))).toBe(false);
  });

  it("stands down while the value holds a line break", async () => {
    const model = await editing();
    model.editValue(ROOT_ID, "title", "two\nlines");
    expect(selectCanAutocomplete(state(model))).toBe(false);
    model.toggleAutocomplete();
    expect(on(model)).toBe(false);
  });

  it("isn't offered on a column with a unique constraint of its own", async () => {
    serve({ track: [trackRow("t1", "Sorry", "Pop", 0)] });
    const model = createRecordForm({
      tables: TABLES.map((t) =>
        t.name === "track"
          ? { ...t, uniqueConstraints: [...t.uniqueConstraints, ["title"]] }
          : t,
      ),
      table: "track",
      keys: [trackKey("t1")],
      schemaJson: "{}",
    });
    model.start();
    await flush();
    model.beginEdit(ROOT_ID, "title");
    expect(selectCanAutocomplete(state(model))).toBe(false);
  });

  it("toggles, and goes off with the edit", async () => {
    const model = await editing();
    model.toggleAutocomplete();
    expect(on(model)).toBe(true);
    model.toggleAutocomplete();
    expect(on(model)).toBe(false);
    model.toggleAutocomplete();
    model.commitEdit(ROOT_ID, "title", "Sorry");
    model.beginEdit(ROOT_ID, "title");
    expect(on(model)).toBe(false);
  });

  it("searches the column's distinct values, as a list to offer", async () => {
    const model = await editing();
    runner.mockResolvedValueOnce([
      ["Sorry", "2"],
      [null, "9"],
    ]);
    const field = scalarField(model, ROOT_ID, "title");
    if (field.kind !== "primitive") throw new Error("not primitive");
    await expect(model.searchValues(ROOT_ID, field, "SOR")).resolves.toEqual([
      { value: "Sorry", count: 2 },
    ]);
    expect(runner.mock.lastCall?.[0]).toEqual({
      base: "track",
      filter: 'title:"SOR"',
      sort: "",
      display: "$title \\gs2 $%count \\sd1",
    });
  });

  it("tells the forms store, whether or not an item has focus", async () => {
    const model = await editing();
    expect(state(model).focused).toBeNull();
    expect(selectFormSummary(state(model)).canAutocomplete).toBe(true);
  });

  it("is offered on a distinct value being edited", async () => {
    serve({
      track: [
        trackRow("t1", "Sorry", "Pop", 0),
        trackRow("t2", "Hold Up", "Pop", 0),
      ],
    });
    const model = form([trackKey("t1"), trackKey("t2")]);
    model.start();
    await flush();
    const field = scalarField(model, ROOT_ID, "title");
    if (field.kind !== "primitive") throw new Error("not primitive");
    model.beginEditDistinct(ROOT_ID, field, "Sorry");
    expect(selectCanAutocomplete(state(model))).toBe(true);
    model.toggleAutocomplete();
    const itemId = distinctItemId(ROOT_ID, "title", "Sorry");
    expect(selectIsAutocompleting(state(model), itemId)).toBe(true);
    model.editDistinct("two\nlines");
    expect(selectCanAutocomplete(state(model))).toBe(false);
    model.commitDistinct("Sorry");
    expect(selectIsAutocompleting(state(model), itemId)).toBe(false);
  });
});
