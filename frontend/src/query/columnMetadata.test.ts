import { describe, expect, it } from "vitest";
import {
  anyFieldHidden,
  arrangeFields,
  fieldMoveOrders,
  groupColumnMetadata,
  orderFields,
  type TableMetadata,
} from "./columnMetadata";

const fields = (...keys: string[]) => keys.map((key) => ({ key }));
const keysOf = (list: readonly { key: string }[]) => list.map((f) => f.key);
const ordered = (...keys: string[]): TableMetadata =>
  Object.fromEntries(
    keys.map((key, i) => [key, { visible: true, order: i + 1 }]),
  );

describe("groupColumnMetadata", () => {
  it("keys rows by table and column", () => {
    expect(
      groupColumnMetadata([
        { table: "track", column: "title", visible: false, order: null },
        { table: "track", column: "id", visible: true, order: 2 },
        { table: "album", column: "title", visible: true, order: 1 },
      ]),
    ).toEqual({
      track: {
        title: { visible: false, order: null },
        id: { visible: true, order: 2 },
      },
      album: { title: { visible: true, order: 1 } },
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
        album: { b: { visible: false, order: null } },
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
        orderFields(fields("a", "b", "c", "d"), {
          c: { visible: true, order: 2 },
          d: { visible: true, order: 1 },
          b: { visible: false, order: null },
        }),
      ),
    ).toEqual(["d", "c", "a", "b"]);
  });

  it("ignores a row for a field the table no longer has", () => {
    expect(
      keysOf(orderFields(fields("a"), { gone: { visible: true, order: 1 } })),
    ).toEqual(["a"]);
  });
});

describe("arrangeFields", () => {
  const metadata: TableMetadata = {
    a: { visible: false, order: 2 },
    b: { visible: true, order: 1 },
  };

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

  it("resequences every field when any has no sort key", () => {
    expect(fieldMoveOrders(KEYS, {}, "c", undefined, "a")).toEqual([
      { column: "c", order: 1 },
      { column: "a", order: 2 },
      { column: "b", order: 3 },
      { column: "d", order: 4 },
    ]);
  });

  it("skips fields already at their place when resequencing", () => {
    const metadata: TableMetadata = {
      a: { visible: true, order: 1 },
      b: { visible: true, order: 2 },
      d: { visible: false, order: null },
    };
    expect(fieldMoveOrders(KEYS, metadata, "d", "b", "c")).toEqual([
      { column: "d", order: 3 },
      { column: "c", order: 4 },
    ]);
  });

  it("writes only the moved field between two sort keys", () => {
    expect(
      fieldMoveOrders(KEYS, ordered("a", "b", "c", "d"), "d", "a", "b"),
    ).toEqual([{ column: "d", order: 1.5 }]);
  });

  it("writes only the moved field at either edge", () => {
    const metadata = ordered("a", "b", "c", "d");
    expect(fieldMoveOrders(KEYS, metadata, "c", undefined, "a")).toEqual([
      { column: "c", order: 0 },
    ]);
    expect(fieldMoveOrders(KEYS, metadata, "b", "d", undefined)).toEqual([
      { column: "b", order: 5 },
    ]);
  });

  it("resequences when two sort keys leave no room between them", () => {
    const metadata: TableMetadata = {
      a: { visible: true, order: 1 },
      b: { visible: true, order: 1 + Number.EPSILON },
      c: { visible: true, order: 5 },
    };
    expect(fieldMoveOrders(["a", "b", "c"], metadata, "c", "a", "b")).toEqual([
      { column: "c", order: 2 },
      { column: "b", order: 3 },
    ]);
  });

  it("resequences when two fields tie", () => {
    const metadata: TableMetadata = {
      a: { visible: true, order: 1 },
      b: { visible: true, order: 1 },
      c: { visible: true, order: 5 },
    };
    expect(fieldMoveOrders(["a", "b", "c"], metadata, "c", "a", "b")).toEqual([
      { column: "c", order: 2 },
      { column: "b", order: 3 },
    ]);
  });

  it("lands right after the neighbor above, ahead of a field not on show", () => {
    // `b` is hidden: the form shows a, c, d, and `d` was dropped between a and c.
    // Halfway between the *shown* neighbors would be exactly where `b` is.
    expect(
      fieldMoveOrders(KEYS, ordered("a", "b", "c", "d"), "d", "a", "c"),
    ).toEqual([{ column: "d", order: 1.5 }]);
  });

  it("lands right before the neighbor below when dropped at the top", () => {
    // `a` is hidden: the form shows b, c, d, and `d` was dropped above `b`.
    expect(
      fieldMoveOrders(KEYS, ordered("a", "b", "c", "d"), "d", undefined, "b"),
    ).toEqual([{ column: "d", order: 1.5 }]);
  });

  it("does nothing for a drop that goes nowhere", () => {
    const metadata = ordered("a", "b", "c", "d");
    expect(fieldMoveOrders(KEYS, metadata, "b", "a", "c")).toEqual([]);
    expect(fieldMoveOrders(KEYS, metadata, "a", undefined, "b")).toEqual([]);
  });

  it("does nothing without a field or a neighbor to go by", () => {
    const metadata = ordered("a", "b", "c", "d");
    expect(fieldMoveOrders(KEYS, metadata, "gone", "a", "b")).toEqual([]);
    expect(fieldMoveOrders(KEYS, metadata, "a", "gone", "b")).toEqual([]);
    expect(fieldMoveOrders(KEYS, metadata, "a", undefined, "gone")).toEqual([]);
    expect(fieldMoveOrders(KEYS, metadata, "a", undefined, undefined)).toEqual(
      [],
    );
  });
});
