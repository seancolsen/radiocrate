import { describe, expect, it } from "vitest";
import { deepEqual, keepIfEqual } from "./deepEqual";

describe("deepEqual", () => {
  it("compares plain data by value", () => {
    expect(deepEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(
      true,
    );
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: undefined }, {})).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual(NaN, NaN)).toBe(true);
  });

  it("keeps the old reference when nothing changed", () => {
    const previous = [{ id: "a" }];
    expect(keepIfEqual(previous, [{ id: "a" }])).toBe(previous);
    const next = [{ id: "b" }];
    expect(keepIfEqual(previous, next)).toBe(next);
  });
});
