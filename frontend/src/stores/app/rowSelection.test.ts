import { describe, expect, it } from "vitest";
import {
  allRows,
  clearedSelection,
  clickedSelection,
  rangedSelection,
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

describe("rangedSelection", () => {
  it("grows from the selected anchor, keeping it as the origin", () => {
    const first = rangedSelection(singleRow(2), 5);
    expect(view(first)).toEqual({ rows: [2, 3, 4, 5], anchor: 2, lead: 5 });
    // A tap on the far side of the origin swings the range over…
    const second = rangedSelection(first, 0);
    expect(view(second)).toEqual({ rows: [0, 1, 2], anchor: 2, lead: 0 });
    // …and a nearer one shrinks it, rather than starting another.
    expect(view(rangedSelection(second, 1))).toEqual({
      rows: [1, 2],
      anchor: 2,
      lead: 1,
    });
  });

  it("keeps what was selected before the range began", () => {
    // Rows 0 and 8 toggled on, 8 last: the range grows from 8.
    const toggled = clickedSelection(someRows([0]), 8, toggle);
    const first = rangedSelection(toggled, 5);
    expect(view(first)?.rows).toEqual([0, 5, 6, 7, 8]);
    // Shrinking the range lets its own rows go, but not row 0.
    expect(view(rangedSelection(first, 7))?.rows).toEqual([0, 7, 8]);
  });

  it("sets the origin with the tap when the anchor isn't selected", () => {
    // The last toggle took row 3 out, so 3 is no origin.
    const toggled = clickedSelection(someRows([1, 3]), 3, toggle);
    const first = rangedSelection(toggled, 6);
    expect(view(first)).toEqual({ rows: [1, 6], anchor: 6, lead: 6 });
    expect(view(rangedSelection(first, 4))?.rows).toEqual([1, 4, 5, 6]);
    // Nothing selected at all: the tap starts from scratch.
    expect(view(rangedSelection(undefined, 2))).toEqual({
      rows: [2],
      anchor: 2,
      lead: 2,
    });
  });

  it("starts afresh after any other change to the selection", () => {
    const ranged = rangedSelection(singleRow(0), 2); // 0–2
    const toggled = clickedSelection(ranged, 6, toggle); // + 6, anchored there
    expect(view(rangedSelection(toggled, 8))?.rows).toEqual([0, 1, 2, 6, 7, 8]);
  });
});

describe("clearedSelection", () => {
  it("selects nothing but keeps both ends", () => {
    const prev = { ...someRows([2, 5])!, lead: 5 };
    expect(view(clearedSelection(prev))).toEqual({
      rows: [],
      anchor: 2,
      lead: 5,
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
