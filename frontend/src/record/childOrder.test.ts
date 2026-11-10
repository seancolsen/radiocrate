import { describe, expect, it } from "vitest";
import { movedTo, nextOrder, reorderedValues, sortByOrder } from "./childOrder";

describe("nextOrder", () => {
  it("is one more than the greatest value", () => {
    expect(nextOrder(["1", "3", "2"])).toBe("4");
    expect(nextOrder(["1.5", null])).toBe("2");
  });

  it("starts from 1", () => {
    expect(nextOrder([])).toBe("1");
    expect(nextOrder([null, undefined, ""])).toBe("1");
  });
});

describe("sortByOrder", () => {
  it("sorts by value, stably, with the unnumbered last", () => {
    const values: Record<string, string | null> = {
      a: "2",
      b: null,
      c: "1",
      d: "2",
      e: "0.5",
    };
    expect(sortByOrder(["a", "b", "c", "d", "e"], (id) => values[id])).toEqual([
      "e",
      "c",
      "a",
      "d",
      "b",
    ]);
  });
});

describe("reorderedValues", () => {
  it("hands the values out again, lowest first", () => {
    // The last of four moved up to second: only it and those it passed change.
    expect(reorderedValues(["1", "4", "2", "3"])).toEqual(["1", "2", "3", "4"]);
    expect(reorderedValues(["10", "30", "20"])).toEqual(["10", "20", "30"]);
  });

  it("keeps each value's own spelling", () => {
    expect(reorderedValues(["2.0", "1.0"])).toEqual(["1.0", "2.0"]);
  });

  it("numbers afresh when the values can't say an order", () => {
    expect(reorderedValues(["1", null, "2"])).toEqual(["1", "2", "3"]);
    expect(reorderedValues(["1", "1"])).toEqual(["1", "2"]);
  });
});

describe("movedTo", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("moves records to a gap of the list as it was", () => {
    expect(movedTo(ids, ["d"], 1)).toEqual(["a", "d", "b", "c", "e"]);
    expect(movedTo(ids, ["a"], 5)).toEqual(["b", "c", "d", "e", "a"]);
  });

  it("keeps several together, in the order they had", () => {
    expect(movedTo(ids, ["e", "b"], 0)).toEqual(["b", "e", "a", "c", "d"]);
    expect(movedTo(ids, ["a", "c"], 4)).toEqual(["b", "d", "a", "c", "e"]);
  });
});
