import { describe, expect, it } from "vitest";
import {
  allRows,
  clickedSelection,
  singleRow,
  someRows,
  steppedSelection,
  trimmedSelection,
  type RowSelection,
} from "./rowSelection";

const plain = { shift: false, toggle: false };
const shift = { shift: true, toggle: false };
const toggle = { shift: false, toggle: true };

const view = (s: RowSelection | undefined) =>
  s && {
    rows: [...s.rows].sort((a, b) => a - b),
    anchor: s.anchor,
    lead: s.lead,
  };

describe("clickedSelection", () => {
  it("selects the clicked row alone on a plain click", () => {
    const prev = someRows([1, 2, 3]);
    expect(view(clickedSelection(prev, 5, plain))).toEqual({
      rows: [5],
      anchor: 5,
      lead: 5,
    });
  });

  it("grows a Shift range from the anchor, in either direction", () => {
    expect(view(clickedSelection(singleRow(4), 2, shift))).toEqual({
      rows: [2, 3, 4],
      anchor: 4,
      lead: 2,
    });
  });

  it("anchors a Shift click with nothing selected at the clicked row", () => {
    expect(view(clickedSelection(undefined, 3, shift))).toEqual({
      rows: [3],
      anchor: 3,
      lead: 3,
    });
  });

  it("toggles a row and re-anchors there", () => {
    const on = clickedSelection(singleRow(1), 4, toggle);
    expect(view(on)).toEqual({ rows: [1, 4], anchor: 4, lead: 4 });
    expect(view(clickedSelection(on, 1, toggle))).toEqual({
      rows: [4],
      anchor: 1,
      lead: 1,
    });
  });
});

describe("steppedSelection", () => {
  it("starts at the top going down and the bottom going up", () => {
    expect(view(steppedSelection(undefined, 5, true, false))?.rows).toEqual([
      0,
    ]);
    expect(view(steppedSelection(undefined, 5, false, false))?.rows).toEqual([
      4,
    ]);
  });

  it("steps from the lead, not the anchor", () => {
    const range = clickedSelection(singleRow(1), 3, shift);
    expect(view(steppedSelection(range, 10, true, false))).toEqual({
      rows: [4],
      anchor: 4,
      lead: 4,
    });
    expect(view(steppedSelection(range, 10, true, true))).toEqual({
      rows: [1, 2, 3, 4],
      anchor: 1,
      lead: 4,
    });
  });

  it("stops at the ends", () => {
    expect(steppedSelection(singleRow(0), 5, false, false)?.lead).toBe(0);
    expect(steppedSelection(singleRow(4), 5, true, false)?.lead).toBe(4);
  });

  it("lands on the last row from ends left past it", () => {
    expect(view(steppedSelection(singleRow(9), 5, false, true))).toEqual({
      rows: [4],
      anchor: 4,
      lead: 4,
    });
  });

  it("selects nothing among no rows", () => {
    expect(steppedSelection(singleRow(0), 0, true, false)).toBeUndefined();
  });
});

describe("allRows / someRows", () => {
  it("anchors every row at the top and leads from the bottom", () => {
    expect(view(allRows(3))).toEqual({ rows: [0, 1, 2], anchor: 0, lead: 2 });
    expect(allRows(0)).toBeUndefined();
  });

  it("anchors at the first row given and leads from the last", () => {
    expect(view(someRows([5, 2, 7]))).toEqual({
      rows: [2, 5, 7],
      anchor: 5,
      lead: 7,
    });
    expect(someRows([])).toBeUndefined();
  });
});

describe("trimmedSelection", () => {
  it("is the same selection when every row survived", () => {
    const s = someRows([1, 2])!;
    expect(trimmedSelection(s, 3)).toBe(s);
  });

  it("drops rows past the end and pulls the ends inside", () => {
    expect(view(trimmedSelection(someRows([1, 4])!, 3))).toEqual({
      rows: [1],
      anchor: 1,
      lead: 2,
    });
  });

  it("is nothing when no row survived", () => {
    expect(trimmedSelection(singleRow(4), 3)).toBeUndefined();
  });
});
