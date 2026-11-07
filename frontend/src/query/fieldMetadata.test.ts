import { describe, expect, it } from "vitest";
import type { FieldRef } from "api-client";
import {
  anyFieldHidden,
  arrangeFields,
  defaultFieldMetadata,
  embedChanges,
  fieldMoveOrders,
  fieldRefKey,
  groupFieldMetadata,
  orderFields,
  type FieldMetadata,
  type TableMetadata,
} from "./fieldMetadata";
import { fieldRef, type FormField } from "./recordForm";

const fieldMeta = (visible: boolean, order: number | null) => ({
  ...defaultFieldMetadata(),
  visible,
  order,
});

const column = (columnName: string): FieldRef => ({ columnName });
const link = (relatedTableName: string, fkColumnName: string): FieldRef => ({
  multiLink: { relatedTableName, fkColumnName },
});
const fields = (...keys: string[]): FormField[] =>
  keys.map((key) => ({
    kind: "primitive",
    key,
    label: key,
    column: key,
    valueType: "text",
    nullable: true,
    readOnly: false,
    unique: false,
  }));
const keysOf = (list: readonly { key: string }[]) => list.map((f) => f.key);
/** Metadata for columns named by key. */
const metadataOf = (entries: Record<string, FieldMetadata>): TableMetadata =>
  Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [
      fieldRefKey(column(key)),
      entry,
    ]),
  );
const ordered = (...keys: string[]): TableMetadata =>
  metadataOf(
    Object.fromEntries(keys.map((key, i) => [key, fieldMeta(true, i + 1)])),
  );
const placed = (name: string, order: number) => ({
  field: column(name),
  order,
});

describe("fieldRefKey", () => {
  it("tells apart any two different fields", () => {
    const refs = [
      column("credit"),
      column("#credit"),
      column('["credit","track"]'),
      link("credit", "track"),
      link("credit", "other"),
      link("track", "credit"),
      link('credit","track', ""),
      link("credit", 'track","'),
    ];
    expect(new Set(refs.map(fieldRefKey)).size).toBe(refs.length);
  });
});

describe("fieldRef", () => {
  it("names a column by its column, and a multi-record field by its link", () => {
    const [primitive] = fields("title");
    expect(fieldRef(primitive)).toEqual(column("title"));
    expect(
      fieldRef({
        kind: "scalarLink",
        key: "album",
        label: "album",
        column: "album",
        table: "album",
        keyColumn: "id",
        nullable: true,
      }),
    ).toEqual(column("album"));
    expect(
      fieldRef({
        kind: "multiRecord",
        key: "#credit",
        label: "credits",
        table: "credit",
        column: "track",
        keyColumns: ["id"],
      }),
    ).toEqual(link("credit", "track"));
  });
});

describe("embedChanges", () => {
  const TITLE = fieldRefKey(column("title"));
  const CREDITS = fieldRefKey(link("credit", "track"));
  const custom = (display: string | null, sorting: string | null = null) => ({
    ...defaultFieldMetadata(),
    display,
    sorting,
  });

  it("names the fields whose display or sorting changed", () => {
    expect(
      embedChanges(
        { track: { [TITLE]: custom("$a"), [CREDITS]: custom(null, "\\\\a") } },
        { track: { [TITLE]: custom("$a"), [CREDITS]: custom(null, "\\\\b") } },
      ),
    ).toEqual([{ table: "track", fieldKey: CREDITS }]);
  });

  it("takes a field appearing or going as a change only if it says anything", () => {
    expect(embedChanges({}, { track: { [TITLE]: custom("$a") } })).toEqual([
      { table: "track", fieldKey: TITLE },
    ]);
    expect(embedChanges({ track: { [TITLE]: custom("$a") } }, {})).toEqual([
      { table: "track", fieldKey: TITLE },
    ]);
    expect(embedChanges({}, { track: { [TITLE]: custom(null) } })).toEqual([]);
  });

  it("has nothing to say about hiding or moving a field", () => {
    expect(
      embedChanges(
        { track: { [TITLE]: fieldMeta(true, 1) } },
        { track: { [TITLE]: fieldMeta(false, 2) } },
      ),
    ).toEqual([]);
  });
});

describe("groupFieldMetadata", () => {
  it("keys rows by table and field", () => {
    expect(
      groupFieldMetadata([
        {
          tableName: "track",
          field: column("title"),
          visible: false,
          order: null,
          display: "$a",
          sorting: null,
        },
        {
          tableName: "track",
          field: link("credit", "track"),
          visible: true,
          order: 2,
          display: null,
          sorting: "\\\\a",
        },
        {
          tableName: "album",
          field: column("title"),
          visible: true,
          order: 1,
          display: null,
          sorting: null,
        },
      ]),
    ).toEqual({
      track: {
        [fieldRefKey(column("title"))]: {
          ...fieldMeta(false, null),
          display: "$a",
        },
        [fieldRefKey(link("credit", "track"))]: {
          ...fieldMeta(true, 2),
          sorting: "\\\\a",
        },
      },
      album: { [fieldRefKey(column("title"))]: fieldMeta(true, 1) },
    });
  });
});

describe("anyFieldHidden", () => {
  it("looks across every table", () => {
    expect(anyFieldHidden({})).toBe(false);
    expect(anyFieldHidden({ track: ordered("a") })).toBe(false);
    expect(
      anyFieldHidden({
        track: ordered("a"),
        album: metadataOf({ b: fieldMeta(false, null) }),
      }),
    ).toBe(true);
  });
});

describe("orderFields", () => {
  it("leaves fields as they came without any metadata", () => {
    expect(keysOf(orderFields(fields("c", "a", "b"), {}))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("puts sort keys first, and the rest after them as they came", () => {
    expect(
      keysOf(
        orderFields(
          fields("a", "b", "c", "d"),
          metadataOf({
            c: fieldMeta(true, 2),
            d: fieldMeta(true, 1),
            b: fieldMeta(false, null),
          }),
        ),
      ),
    ).toEqual(["d", "c", "a", "b"]);
  });

  it("ignores a row for a field the table no longer has", () => {
    expect(
      keysOf(orderFields(fields("a"), { gone: fieldMeta(true, 1) })),
    ).toEqual(["a"]);
  });
});

describe("arrangeFields", () => {
  const metadata = metadataOf({
    a: fieldMeta(false, 2),
    b: fieldMeta(true, 1),
  });

  it("leaves hidden fields out", () => {
    expect(keysOf(arrangeFields(fields("a", "b"), metadata, false))).toEqual([
      "b",
    ]);
  });

  it("puts hidden fields in their places when they're on show", () => {
    expect(keysOf(arrangeFields(fields("a", "b"), metadata, true))).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("fieldMoveOrders", () => {
  const KEYS = ["a", "b", "c", "d"];
  /** `fieldMoveOrders`, with every field a column named by key. */
  const move = (
    keys: readonly string[],
    metadata: TableMetadata,
    moved: string,
    above: string | undefined,
    below: string | undefined,
  ) =>
    fieldMoveOrders(
      keys.map(column),
      metadata,
      column(moved),
      above === undefined ? undefined : column(above),
      below === undefined ? undefined : column(below),
    );

  it("resequences every field when any has no sort key", () => {
    expect(move(KEYS, {}, "c", undefined, "a")).toEqual([
      placed("c", 1),
      placed("a", 2),
      placed("b", 3),
      placed("d", 4),
    ]);
  });

  it("skips fields already at their place when resequencing", () => {
    const metadata = metadataOf({
      a: fieldMeta(true, 1),
      b: fieldMeta(true, 2),
      d: fieldMeta(false, null),
    });
    expect(move(KEYS, metadata, "d", "b", "c")).toEqual([
      placed("d", 3),
      placed("c", 4),
    ]);
  });

  it("writes only the moved field between two sort keys", () => {
    expect(move(KEYS, ordered("a", "b", "c", "d"), "d", "a", "b")).toEqual([
      placed("d", 1.5),
    ]);
  });

  it("writes only the moved field at either edge", () => {
    const metadata = ordered("a", "b", "c", "d");
    expect(move(KEYS, metadata, "c", undefined, "a")).toEqual([placed("c", 0)]);
    expect(move(KEYS, metadata, "b", "d", undefined)).toEqual([placed("b", 5)]);
  });

  it("resequences when two sort keys leave no room between them", () => {
    const metadata = metadataOf({
      a: fieldMeta(true, 1),
      b: fieldMeta(true, 1 + Number.EPSILON),
      c: fieldMeta(true, 5),
    });
    expect(move(["a", "b", "c"], metadata, "c", "a", "b")).toEqual([
      placed("c", 2),
      placed("b", 3),
    ]);
  });

  it("resequences when two fields tie", () => {
    const metadata = metadataOf({
      a: fieldMeta(true, 1),
      b: fieldMeta(true, 1),
      c: fieldMeta(true, 5),
    });
    expect(move(["a", "b", "c"], metadata, "c", "a", "b")).toEqual([
      placed("c", 2),
      placed("b", 3),
    ]);
  });

  it("lands right after the neighbor above, ahead of a field not on show", () => {
    // `b` is hidden: the form shows a, c, d, and `d` was dropped between a and c.
    // Halfway between the *shown* neighbors would be exactly where `b` is.
    expect(move(KEYS, ordered("a", "b", "c", "d"), "d", "a", "c")).toEqual([
      placed("d", 1.5),
    ]);
  });

  it("lands right before the neighbor below when dropped at the top", () => {
    // `a` is hidden: the form shows b, c, d, and `d` was dropped above `b`.
    expect(
      move(KEYS, ordered("a", "b", "c", "d"), "d", undefined, "b"),
    ).toEqual([placed("d", 1.5)]);
  });

  it("does nothing for a drop that goes nowhere", () => {
    const metadata = ordered("a", "b", "c", "d");
    expect(move(KEYS, metadata, "b", "a", "c")).toEqual([]);
    expect(move(KEYS, metadata, "a", undefined, "b")).toEqual([]);
  });

  it("does nothing without a field or a neighbor to go by", () => {
    const metadata = ordered("a", "b", "c", "d");
    expect(move(KEYS, metadata, "gone", "a", "b")).toEqual([]);
    expect(move(KEYS, metadata, "a", "gone", "b")).toEqual([]);
    expect(move(KEYS, metadata, "a", undefined, "gone")).toEqual([]);
    expect(move(KEYS, metadata, "a", undefined, undefined)).toEqual([]);
  });

  it("moves a link among columns, and keeps links through other columns apart", () => {
    const refs = [column("a"), link("credit", "track"), link("credit", "b")];
    expect(fieldMoveOrders(refs, {}, refs[2], undefined, refs[0])).toEqual([
      { field: refs[2], order: 1 },
      { field: refs[0], order: 2 },
      { field: refs[1], order: 3 },
    ]);
  });
});
