import { describe, expect, it } from "vitest";
import {
  gracePolygon,
  placeAtPoint,
  placeDropdown,
  placeSubmenu,
  pointInPolygon,
  VIEWPORT_MARGIN as M,
  type Rect,
} from "./menuGeometry";

const VIEWPORT = { width: 1000, height: 800 };

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, right: left + width, bottom: top + height };
}

describe("placeDropdown", () => {
  const trigger = rect(100, 100, 30, 20);
  const size = { width: 200, height: 150 };

  it("hangs below the trigger, lined up with the edge `align` names", () => {
    expect(placeDropdown(trigger, size, VIEWPORT, "below", "start")).toEqual({
      left: 100,
      top: 124,
      maxHeight: 800 - M - 124,
    });
    const wide = rect(400, 100, 30, 20);
    expect(placeDropdown(wide, size, VIEWPORT, "below", "end").left).toBe(
      430 - 200,
    );
  });

  it("flips above when there's no room below, but room above", () => {
    const low = rect(100, 700, 30, 20);
    const p = placeDropdown(low, size, VIEWPORT, "below", "start");
    expect(p.top + size.height).toBe(700 - 4);
    expect(p.top).toBeGreaterThanOrEqual(M);
  });

  it("flips below when opened upward from the top edge", () => {
    const high = rect(100, 20, 30, 20);
    expect(placeDropdown(high, size, VIEWPORT, "above", "start").top).toBe(44);
  });

  it("takes the roomier side and caps its height when neither side fits", () => {
    const mid = rect(100, 300, 30, 20);
    const tall = { width: 200, height: 1000 };
    const p = placeDropdown(mid, tall, VIEWPORT, "above", "start");
    // 476px below against 288px above.
    expect(p.top).toBe(324);
    expect(p.maxHeight).toBe(800 - M - 324);
  });

  it("slides back inside the viewport horizontally", () => {
    const nearRight = rect(900, 100, 30, 20);
    expect(
      placeDropdown(nearRight, size, VIEWPORT, "below", "start").left,
    ).toBe(1000 - M - 200);
    const nearLeft = rect(10, 100, 30, 20);
    expect(placeDropdown(nearLeft, size, VIEWPORT, "below", "end").left).toBe(
      M,
    );
  });
});

describe("placeSubmenu", () => {
  const size = { width: 200, height: 150 };

  it("opens to the row's right, top-aligned with it", () => {
    const p = placeSubmenu(rect(100, 100, 180, 24), size, VIEWPORT, "right");
    expect(p).toMatchObject({ left: 284, top: 100, side: "right" });
  });

  it("flips left when the right side hasn't room", () => {
    const p = placeSubmenu(rect(700, 100, 180, 24), size, VIEWPORT, "right");
    expect(p).toMatchObject({ left: 700 - 4 - 200, side: "left" });
  });

  it("keeps going left, as its parent did, while there's room", () => {
    const p = placeSubmenu(rect(300, 100, 180, 24), size, VIEWPORT, "left");
    expect(p).toMatchObject({ left: 96, side: "left" });
  });

  it("overlaps its parent rather than leave the viewport when neither side fits", () => {
    const narrow = { width: 400, height: 800 };
    const p = placeSubmenu(rect(20, 100, 300, 24), size, narrow, "right");
    expect(p.left).toBe(400 - M - 200);
    expect(p.side).toBe("right");
  });

  it("slides up to clear the bottom edge, and caps a panel taller than the viewport", () => {
    const low = placeSubmenu(rect(100, 740, 180, 24), size, VIEWPORT, "right");
    expect(low.top).toBe(800 - M - 150);
    const tall = placeSubmenu(
      rect(100, 400, 180, 24),
      { width: 200, height: 2000 },
      VIEWPORT,
      "right",
    );
    expect(tall).toMatchObject({ top: M, maxHeight: 800 - 2 * M });
  });
});

describe("placeAtPoint", () => {
  it("puts the top-left corner at the point when it fits", () => {
    expect(
      placeAtPoint({ x: 50, y: 60 }, { width: 170, height: 100 }, VIEWPORT),
    ).toMatchObject({ left: 50, top: 60 });
  });

  it("slides back inside from the bottom-right corner", () => {
    expect(
      placeAtPoint({ x: 990, y: 790 }, { width: 170, height: 100 }, VIEWPORT),
    ).toMatchObject({ left: 1000 - M - 170, top: 800 - M - 100 });
  });
});

describe("grace area", () => {
  // A submenu row whose right edge is at x=300, its panel just beyond it.
  const panel = rect(304, 100, 200, 160);
  const polygon = gracePolygon({ x: 300, y: 110 }, panel, "right");

  it("covers a diagonal crossing towards the panel", () => {
    expect(pointInPolygon({ x: 300, y: 110 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 302, y: 125 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 400, y: 200 }, polygon)).toBe(true);
  });

  it("excludes moves straight down or back the way the pointer came", () => {
    expect(pointInPolygon({ x: 200, y: 130 }, polygon)).toBe(false);
    expect(pointInPolygon({ x: 280, y: 110 }, polygon)).toBe(false);
  });

  it("mirrors for a submenu opening to the left", () => {
    const leftPanel = rect(0, 100, 200, 160);
    const left = gracePolygon({ x: 205, y: 110 }, leftPanel, "left");
    expect(pointInPolygon({ x: 203, y: 125 }, left)).toBe(true);
    expect(pointInPolygon({ x: 230, y: 110 }, left)).toBe(false);
  });
});
