import { describe, expect, it } from "vitest";
import * as arrow from "apache-arrow";
import { stringifyArrowValue } from "./query";

// Regression coverage for the timestamp-stringification bug: apache-arrow's
// `.get()` normalizes every `Timestamp*` unit to milliseconds, so a naive
// `String(value)` produced a raw epoch-ms digit string DuckDB couldn't cast
// back into a `timestamp_s` column, and — one step downstream in
// `query/format.ts` — got double-converted by the relative-time formatter's
// epoch-seconds fallback. Passing the Arrow field type lets this render a
// proper naive datetime string instead.

describe("stringifyArrowValue", () => {
  it("renders a TimestampSecond cell as a naive datetime string, not raw epoch ms", () => {
    // vectorFromArray/builders always take Timestamp* input as epoch *ms*
    // (apache-arrow's own convention, regardless of the column's storage
    // unit) — this is the value shape `.get()` hands back too, and what
    // stringifyArrowValue must correctly turn into a naive datetime string.
    const type = new arrow.TimestampSecond();
    const vector = arrow.vectorFromArray([1782651944000], type);
    expect(stringifyArrowValue(vector.get(0), type)).toBe(
      "2026-06-28 13:05:44",
    );
  });

  it("renders TimestampMillisecond/Microsecond/Nanosecond cells identically for the same instant", () => {
    const ms = 1782651944000;

    const secType = new arrow.TimestampSecond();
    const expected = stringifyArrowValue(
      arrow.vectorFromArray([ms], secType).get(0),
      secType,
    );

    const msType = new arrow.TimestampMillisecond();
    const msVector = arrow.vectorFromArray([ms], msType);
    expect(stringifyArrowValue(msVector.get(0), msType)).toBe(expected);

    const usType = new arrow.TimestampMicrosecond();
    const usVector = arrow.vectorFromArray([ms], usType);
    expect(stringifyArrowValue(usVector.get(0), usType)).toBe(expected);

    const nsType = new arrow.TimestampNanosecond();
    const nsVector = arrow.vectorFromArray([ms], nsType);
    expect(stringifyArrowValue(nsVector.get(0), nsType)).toBe(expected);
  });

  it("falls back to String(value) for non-timestamp types", () => {
    expect(stringifyArrowValue(42, new arrow.Int32())).toBe("42");
    expect(stringifyArrowValue(42)).toBe("42");
  });

  it("returns '' for null/undefined regardless of type", () => {
    const type = new arrow.TimestampSecond();
    expect(stringifyArrowValue(null, type)).toBe("");
    expect(stringifyArrowValue(undefined, type)).toBe("");
  });
});
