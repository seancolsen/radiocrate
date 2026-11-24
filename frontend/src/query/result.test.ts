import { describe, expect, it, vi } from "vitest";
import * as arrow from "apache-arrow";
import type { AnnotationValue } from "querydown-js";
import { buildResultFromArrow, reannotateResult } from "./result";
import { exportCellText, hasFormatting } from "./exportCsv";
import { inZone } from "../dev/inZone";

// Guards the full decode path against DuckDB list columns that apache-arrow
// can't classify by type. Builds a real Arrow table so the test exercises
// `getChildAt`/`.get()` exactly as production does.

function listColumn(rows: string[][]): arrow.Vector {
  const type = new arrow.List(
    arrow.Field.new({ name: "item", type: new arrow.Utf8(), nullable: true }),
  );
  const b = arrow.makeBuilder({ type, nullValues: [null] });
  // The List builder accepts a plain array at runtime; its typed value is a
  // Vector, so cast to satisfy the overload.
  for (const r of rows) b.append(r as unknown as arrow.Vector<arrow.Utf8>);
  return b.finish().toVector();
}

/** An annotation object, as querydown-js returns one. */
const anno = (entries: [string, AnnotationValue][]): AnnotationValue =>
  Object.fromEntries(entries);

describe("buildResultFromArrow", () => {
  const table = new arrow.Table({
    id: arrow.vectorFromArray(["t1", "t2"], new arrow.Utf8()),
    artists: listColumn([["Beyoncé"], ["Beyoncé", "Jack White"]]),
    duration: arrow.vectorFromArray(["196", "234"], new arrow.Utf8()),
  });

  const annotations: (AnnotationValue | null)[] = [
    anno([["hide", "yes"]]), // id: hidden
    null, // artists: no annotation → list detected from the value
    anno([
      ["align", "right"],
      ["formatter", { type: "duration" }],
    ]),
  ];

  it("keeps every column (hidden included), and classifies list vs. scalar", () => {
    const result = buildResultFromArrow(table, annotations);
    expect(result.rowCount).toBe(2);
    expect(result.columns).toHaveLength(3);
    expect(result.columns[0].meta.hide).toBe(true);
    expect(result.columns[1].isList).toBe(true);
    expect(result.columns[2].isList).toBe(false);
  });

  it("drops hidden columns from `visible`, keeping the rest in order", () => {
    const result = buildResultFromArrow(table, annotations);
    expect(result.visible).toHaveLength(2);
    expect(result.visible[0].isList).toBe(true);
    expect(result.visible[1].isList).toBe(false);
  });

  it("renders a list column as pill arrays (value-level fallback)", () => {
    const result = buildResultFromArrow(table, annotations);
    const artists = result.visible[0];
    expect(artists.isList).toBe(true);
    expect(result.pills(0, artists)).toEqual(["Beyoncé"]);
    expect(result.pills(1, artists)).toEqual(["Beyoncé", "Jack White"]);
  });

  it("applies the formatter from an annotation", () => {
    const result = buildResultFromArrow(table, annotations);
    const duration = result.visible[1];
    expect(duration.meta.text_align).toBe("right");
    // 196s → 3:16, 234s → 3:54.
    expect(result.text(0, duration)).toBe("3:16");
    expect(result.text(1, duration)).toBe("3:54");
  });

  it("reads a hidden column's raw value, even though it's dropped from `visible`", () => {
    const result = buildResultFromArrow(table, annotations);
    expect(result.value(0, 0)).toBe("t1");
    expect(result.keyText(1, 0)).toBe("t2");
  });
});

describe("buildResultFromArrow with a Timestamp column", () => {
  it("feeds the relativeTime formatter a value it parses correctly (not off by 1000x)", () => {
    // Regression: apache-arrow normalizes every Timestamp* unit to epoch ms,
    // and a naive `String(value)` produced a raw ms digit string that
    // `format.ts`'s relative-time parser then misread as epoch *seconds* and
    // multiplied by 1000 again — landing tens of thousands of years off.
    const oneDayAgoMs = Math.floor(Date.now() / 1000) * 1000 - 86_400_000;
    const type = new arrow.TimestampSecond();
    const played = new arrow.Table({
      played_at: arrow.vectorFromArray([oneDayAgoMs], type),
    });
    const annotations: (AnnotationValue | null)[] = [
      anno([["formatter", { type: "relativeTime", units: ["days"] }]]),
    ];
    const result = buildResultFromArrow(played, annotations);
    // The stored text is UTC, and read as UTC, so it's a day ago in any zone —
    // not (as the bug produced) tens of thousands of years away.
    expect(result.text(0, result.visible[0])).toBe("1 day ago");
  });

  it("shows a null cell without its prefix or suffix, and the rest with theirs", () => {
    const plays = new arrow.Table({
      plays: arrow.vectorFromArray([1, 2, null], new arrow.Int32()),
    });
    const result = buildResultFromArrow(plays, [
      anno([
        ["prefix", "#"],
        ["suffix", [" play", " plays"]],
      ]),
    ]);
    const col = result.visible[0];
    expect(result.text(0, col)).toBe("#1 play");
    expect(result.text(1, col)).toBe("#2 plays");
    expect(result.text(2, col)).toBe("");
  });

  it("re-derives a relativeTime cell on every read, not just at decode time", () => {
    // The whole point of deriving at paint time: the same stored value reads
    // differently once the clock has moved on, with no re-decode in between —
    // the regression a value frozen at decode time would fail.
    const oneMinuteAgoMs = Math.floor(Date.now() / 1000) * 1000 - 60_000;
    const type = new arrow.TimestampSecond();
    const played = new arrow.Table({
      played_at: arrow.vectorFromArray([oneMinuteAgoMs], type),
    });
    const annotations: (AnnotationValue | null)[] = [
      anno([
        ["formatter", { type: "relativeTime", units: ["minutes", "hours"] }],
      ]),
    ];
    const result = buildResultFromArrow(played, annotations);
    const col = result.visible[0];
    const first = result.text(0, col);
    expect(first).toMatch(/^[01] minutes? ago$/);

    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 90 * 60_000)); // jump 90 minutes
      const second = result.text(0, col);
      expect(second).not.toBe(first);
      expect(second).toMatch(/^\d+ hours? ago$/);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A timestamp's stored text is UTC civil time; the grid shows it in the
// viewer's zone, while keys and raw exports keep the stored text
// (specs/2026-11-utc-timestamps/decision.md). New York is UTC-4 in June.
describe("a Timestamp column in New York", () => {
  inZone("America/New_York");

  const at = Date.UTC(2026, 5, 7, 2, 30, 45);
  const element = new arrow.TimestampSecond();
  const table = new arrow.Table({
    added: arrow.vectorFromArray([at], new arrow.TimestampSecond()),
    plays: arrow.vectorFromArray(
      [[at]],
      new arrow.List(new arrow.Field("item", element, true)),
    ),
    day: arrow.vectorFromArray([new Date(at)], new arrow.DateDay()),
  });

  it("shows a cell with no formatter in local time, keyed by its stored text", () => {
    const result = buildResultFromArrow(table, [null, null, null]);
    const added = result.visible[0];
    expect(result.text(0, added)).toBe("2026-06-06 22:30:45");
    expect(result.keyText(0, added.index)).toBe("2026-06-07 02:30:45");
    expect(exportCellText(result, 0, added, false)).toBe("2026-06-06 22:30:45");
    expect(exportCellText(result, 0, added, true)).toBe("2026-06-07 02:30:45");
  });

  it("shows a list of timestamps' pills in local time, raw ones as stored", () => {
    const result = buildResultFromArrow(table, [null, null, null]);
    const plays = result.visible[1];
    expect(plays.isList).toBe(true);
    expect(result.pills(0, plays)).toEqual(["2026-06-06 22:30:45"]);
    expect(result.rawPills(0, plays)).toEqual(["2026-06-07 02:30:45"]);
  });

  it("never shifts a date", () => {
    const result = buildResultFromArrow(table, [null, null, null]);
    const day = result.visible[2];
    expect(result.text(0, day)).toBe("2026-06-07");
    expect(result.keyText(0, day.index)).toBe("2026-06-07");
  });

  it("lets the column's own formatter decide, from the same instant", () => {
    const result = buildResultFromArrow(table, [
      anno([["formatter", { type: "timestamp", format: "%H:%M" }]]),
      null,
      null,
    ]);
    expect(result.text(0, result.visible[0])).toBe("22:30");
  });

  it("counts the fallback as formatting, so export offers the raw text", () => {
    const result = buildResultFromArrow(table, [null, null, null]);
    const [added, , day] = result.visible;
    expect(hasFormatting(result.displayMeta(added))).toBe(true);
    expect(hasFormatting(result.displayMeta(day))).toBe(false);
  });
});

describe("QueryResult.patchRow", () => {
  const table = new arrow.Table({
    id: arrow.vectorFromArray(["t1", "t2", "t3"], new arrow.Utf8()),
    title: arrow.vectorFromArray(["Pray You Catch Me", "Hold Up", "Sorry"]),
  });
  const annotations: (AnnotationValue | null)[] = [
    anno([["hide", "yes"]]),
    null,
  ];

  it("re-points a patched row's cells, leaving its neighbours alone", () => {
    const result = buildResultFromArrow(table, annotations);
    const patch = new arrow.Table({
      id: arrow.vectorFromArray(["t2"], new arrow.Utf8()),
      title: arrow.vectorFromArray(["Hold Up (refreshed)"]),
    });
    expect(result.patchRow(1, patch, 0)).toBe(true);

    const title = result.visible[0];
    expect(result.text(0, title)).toBe("Pray You Catch Me");
    expect(result.text(1, title)).toBe("Hold Up (refreshed)");
    expect(result.text(2, title)).toBe("Sorry");
    expect(result.value(1, 0)).toBe("t2");
  });

  it("skips a patch whose projection doesn't match (a different column count)", () => {
    const result = buildResultFromArrow(table, annotations);
    const mismatched = new arrow.Table({
      title: arrow.vectorFromArray(["Hold Up (refreshed)"]),
    });
    expect(result.patchRow(1, mismatched, 0)).toBe(false);
    expect(result.text(1, result.visible[0])).toBe("Hold Up");
  });
});

describe("QueryResult.reordered", () => {
  const table = new arrow.Table({
    id: arrow.vectorFromArray(["t1", "t2", "t3"], new arrow.Utf8()),
    title: arrow.vectorFromArray(["Pray You Catch Me", "Hold Up", "Sorry"]),
  });
  const annotations: (AnnotationValue | null)[] = [
    anno([["hide", "yes"]]),
    null,
  ];
  const ids = (result: ReturnType<typeof buildResultFromArrow>) =>
    Array.from({ length: result.rowCount }, (_, row) => result.value(row, 0));

  it("reads the same rows in the new order, leaving the original as it was", () => {
    const result = buildResultFromArrow(table, annotations);
    const reordered = result.reordered([2, 0, 1]);
    expect(ids(reordered)).toEqual(["t3", "t1", "t2"]);
    expect(reordered.text(0, reordered.visible[0])).toBe("Sorry");
    expect(reordered.visible).toEqual(result.visible);
    expect(ids(result)).toEqual(["t1", "t2", "t3"]);
    // A reordering of a reordering reads through both.
    expect(ids(reordered.reordered([1, 2, 0]))).toEqual(["t1", "t2", "t3"]);
  });

  it("moves a patched row's patch with it", () => {
    const result = buildResultFromArrow(table, annotations);
    const patch = new arrow.Table({
      id: arrow.vectorFromArray(["t2"], new arrow.Utf8()),
      title: arrow.vectorFromArray(["Hold Up (refreshed)"]),
    });
    result.patchRow(1, patch, 0);
    const reordered = result.reordered([1, 2, 0]);
    expect(reordered.text(0, reordered.visible[0])).toBe("Hold Up (refreshed)");
    expect(reordered.text(1, reordered.visible[0])).toBe("Sorry");
  });

  it("refuses an order that doesn't list every row once", () => {
    const result = buildResultFromArrow(table, annotations);
    expect(() => result.reordered([0, 1])).toThrow();
    expect(() => result.reordered([0, 0, 1])).toThrow();
    expect(() => result.reordered([0, 1, 3])).toThrow();
  });
});

describe("reannotateResult", () => {
  const table = new arrow.Table({
    id: arrow.vectorFromArray(["t1", "t2", "t3"], new arrow.Utf8()),
    title: arrow.vectorFromArray(["Pray You Catch Me", "Hold Up", "Sorry"]),
  });
  const annotations: (AnnotationValue | null)[] = [
    anno([["hide", "yes"]]),
    null,
  ];

  it("shows the same rows the new annotations' way", () => {
    const result = buildResultFromArrow(table, annotations);
    const next = reannotateResult(result, [null, anno([["prefix", "♪ "]])]);
    expect(next).not.toBe(result);
    expect(next.visible.map((c) => c.index)).toEqual([0, 1]);
    expect(next.text(2, next.visible[1])).toBe("♪ Sorry");
    expect(result.visible.map((c) => c.index)).toEqual([1]);
  });

  it("keeps a reordering and a re-read row", () => {
    const result = buildResultFromArrow(table, annotations);
    result.patchRow(
      1,
      new arrow.Table({
        id: arrow.vectorFromArray(["t2"], new arrow.Utf8()),
        title: arrow.vectorFromArray(["Hold Up (refreshed)"]),
      }),
      0,
    );
    const next = reannotateResult(result.reordered([1, 2, 0]), [
      anno([["hide", "yes"]]),
      anno([["align", "right"]]),
    ]);
    expect(next.visible[0]?.meta.text_align).toBe("right");
    expect(next.text(0, next.visible[0])).toBe("Hold Up (refreshed)");
    expect(next.text(2, next.visible[0])).toBe("Pray You Catch Me");
  });

  it("is the result itself when nothing would look different", () => {
    const result = buildResultFromArrow(table, annotations);
    expect(reannotateResult(result, [anno([["hide", "yes"]]), null])).toBe(
      result,
    );
  });
});

// The third real-backend regression: a DuckDB INTERVAL column. apache-arrow
// decodes it to an `Int32Array` of nonsense — iterable, so the list-detection
// fallback above would classify the column as a list and paint a row of pills.
// The decode path has to read the buffer itself and keep the column scalar.
describe("buildResultFromArrow with an INTERVAL column", () => {
  /** `Interval(MONTH_DAY_NANO)` over the byte layout arrow-rs writes: int32
   * months, int32 days, int64 nanoseconds. */
  function intervalColumn(seconds: readonly number[]): arrow.Vector {
    const buffer = new ArrayBuffer(16 * seconds.length);
    const view = new DataView(buffer);
    seconds.forEach((s, i) => {
      view.setInt32(i * 16, 0, true);
      view.setInt32(i * 16 + 4, 0, true);
      view.setBigInt64(i * 16 + 8, BigInt(Math.round(s * 1e9)), true);
    });
    return new arrow.Vector([
      arrow.makeData({
        type: new arrow.Interval(arrow.IntervalUnit.MONTH_DAY_NANO),
        length: seconds.length,
        nullCount: 0,
        data: new Int32Array(buffer),
      }),
    ]);
  }

  const table = new arrow.Table({ duration: intervalColumn([196, 234.5]) });

  it("stays scalar and formats as a duration", () => {
    const result = buildResultFromArrow(table, [
      anno([["formatter", { type: "duration" }]]),
    ]);
    const column = result.columns[0];
    expect(column.isList).toBe(false);
    expect(result.text(0, column)).toBe("3:16");
    expect(result.text(1, column)).toBe("3:55");
  });

  it("reads as interval text with no formatter", () => {
    const result = buildResultFromArrow(table, [null]);
    expect(result.text(0, result.columns[0])).toBe("00:03:16");
    expect(result.text(1, result.columns[0])).toBe("00:03:54.5");
  });
});
