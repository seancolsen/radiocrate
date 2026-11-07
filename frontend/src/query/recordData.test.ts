import * as arrow from "apache-arrow";
import { describe, expect, it } from "vitest";
import { recordRowsOf } from "./recordData";
import { buildResultFromArrow } from "./result";

/** A one-value `Interval(MONTH_DAY_NANO)` vector: what `file.duration` arrives as. */
function intervalOf(seconds: bigint): arrow.Vector {
  const buffer = new ArrayBuffer(16);
  new DataView(buffer).setBigInt64(8, seconds * 1_000_000_000n, true);
  return new arrow.Vector([
    arrow.makeData({
      type: new arrow.Interval(arrow.IntervalUnit.MONTH_DAY_NANO),
      length: 1,
      nullCount: 0,
      data: new Int32Array(buffer),
    }),
  ]);
}

describe("recordRowsOf", () => {
  it("reads cells as plain text, whatever their annotations say", () => {
    const table = new arrow.Table({
      name: arrow.vectorFromArray(["Lemonade"]),
      missing: arrow.vectorFromArray([null], new arrow.Utf8()),
    });
    const result = buildResultFromArrow(table, [{ prefix: "x" }, null]);
    expect(recordRowsOf(result)).toEqual([["Lemonade", null]]);
  });

  it("reads an interval as its text, which a duration formatter can parse", () => {
    const table = new arrow.Table({ duration: intervalOf(222n) });
    expect(recordRowsOf(buildResultFromArrow(table, [null]))).toEqual([
      ["00:03:42"],
    ]);
  });
});
