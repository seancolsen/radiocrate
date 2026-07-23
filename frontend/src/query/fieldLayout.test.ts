import { describe, expect, it } from "vitest";
import {
  computeFieldLayout,
  createLayoutMemo,
  type ColSize,
  type FieldLayout,
} from "./fieldLayout";

// Mirrors the Rust unit tests in `frontend-old-egui/src/field_layout.rs`, which
// pin the wrapping/balancing math.

const col = (min: number, max: number): ColSize => ({ min, max });

/** Sum of widths on a given line, plus the gaps between them. */
function lineExtent(layout: FieldLayout, line: number, gap: number): number {
  const widths = layout.placements
    .filter((p) => p.line === line)
    .map((p) => p.width);
  const gaps = gap * Math.max(0, widths.length - 1);
  return widths.reduce((a, b) => a + b, 0) + gaps;
}

describe("computeFieldLayout", () => {
  it("empty input", () => {
    const layout = computeFieldLayout([], 1000, 8);
    expect(layout.lineCount).toBe(0);
    expect(layout.placements).toHaveLength(0);
  });

  it("wide window expands past max and fills width", () => {
    const cols = [col(50, 100), col(50, 300)];
    const layout = computeFieldLayout(cols, 1000, 0);
    expect(layout.lineCount).toBe(1);
    expect(layout.placements.every((p) => p.line === 0)).toBe(true);
    expect(Math.abs(lineExtent(layout, 0, 0) - 1000)).toBeLessThan(0.5);
    expect(layout.placements[0].width).toBeGreaterThan(100);
    expect(layout.placements[1].width).toBeGreaterThan(300);
    // Surplus is proportional to max, so the wider column stays wider.
    expect(layout.placements[1].width).toBeGreaterThan(
      layout.placements[0].width,
    );
  });

  it("mid window shrinks toward min", () => {
    const cols = [col(50, 200), col(50, 200)];
    const layout = computeFieldLayout(cols, 300, 0);
    expect(layout.lineCount).toBe(1);
    expect(Math.abs(lineExtent(layout, 0, 0) - 300)).toBeLessThan(0.5);
    for (const p of layout.placements) {
      expect(p.width).toBeGreaterThanOrEqual(50 - 0.5);
      expect(p.width).toBeLessThanOrEqual(200 + 0.5);
    }
  });

  it("exact min width", () => {
    const cols = [col(100, 200), col(100, 200)];
    const layout = computeFieldLayout(cols, 200, 0);
    expect(layout.lineCount).toBe(1);
    for (const p of layout.placements) {
      expect(Math.abs(p.width - 100)).toBeLessThan(0.5);
    }
  });

  it("wraps and balances evenly", () => {
    const cols = [col(100, 100), col(100, 100), col(100, 100), col(100, 100)];
    const layout = computeFieldLayout(cols, 250, 0);
    expect(layout.lineCount).toBe(2);
    const line0 = layout.placements.filter((p) => p.line === 0).length;
    const line1 = layout.placements.filter((p) => p.line === 1).length;
    expect([line0, line1]).toEqual([2, 2]);
  });

  it("wrapping preserves column order", () => {
    const cols = [
      col(100, 100),
      col(100, 100),
      col(100, 100),
      col(100, 100),
      col(100, 100),
    ];
    const layout = computeFieldLayout(cols, 250, 0);
    for (let i = 1; i < layout.placements.length; i++) {
      expect(layout.placements[i].line).toBeGreaterThanOrEqual(
        layout.placements[i - 1].line,
      );
    }
  });

  it("single oversized column overflows on its own line", () => {
    const cols = [col(100, 100), col(400, 400), col(100, 100)];
    const layout = computeFieldLayout(cols, 200, 0);
    const bigLine = layout.placements[1].line;
    expect(Math.abs(layout.placements[1].width - 400)).toBeLessThan(0.5);
    expect(layout.placements.filter((p) => p.line === bigLine)).toHaveLength(1);
  });

  it("all equal columns get equal widths", () => {
    const cols = [col(50, 100), col(50, 100), col(50, 100)];
    const layout = computeFieldLayout(cols, 600, 0);
    expect(layout.lineCount).toBe(1);
    const first = layout.placements[0].width;
    for (const p of layout.placements) {
      expect(Math.abs(p.width - first)).toBeLessThan(0.5);
    }
  });

  it("x offsets account for gaps", () => {
    const cols = [col(100, 100), col(100, 100)];
    const layout = computeFieldLayout(cols, 208, 8);
    expect(Math.abs(layout.placements[0].x - 0)).toBeLessThan(0.5);
    expect(Math.abs(layout.placements[1].x - 108)).toBeLessThan(0.5);
  });
});

describe("createLayoutMemo", () => {
  it("returns the same layout object for an unchanged rounded key", () => {
    const memo = createLayoutMemo();
    const cols = [col(50, 100), col(50, 100)];
    const a = memo(cols, 500, 16);
    // Sub-pixel change rounds to the same key → cached instance reused.
    const b = memo(cols, 500.4, 16);
    expect(b).toBe(a);
    // A meaningful width change recomputes.
    const c = memo(cols, 400, 16);
    expect(c).not.toBe(a);
  });
});
