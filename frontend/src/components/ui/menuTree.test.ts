import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_DELAY_MS,
  GRACE_MS,
  MenuTree,
  OPEN_DELAY_MS,
  type OpenSubmenu,
} from "./menuTree";
import type { Rect } from "./menuGeometry";

// A root menu (level 0) at x 100–300 with rows 24px tall from y=100:
//
//   y 100  "Colors ▸"   → submenu panel at x 304–504, y 100–260
//   y 124  "Sizes ▸"
//   y 148  "Omega"
const COLORS = Symbol("colors");
const SIZES = Symbol("sizes");
const COLORS_PANEL: Rect = { left: 304, top: 100, right: 504, bottom: 260 };

const onColors = { x: 200, y: 110 };
const onSizes = { x: 200, y: 134 };
const onOmega = { x: 200, y: 158 };
const inPanel = { x: 400, y: 150 };

function makeTree() {
  const closed: OpenSubmenu[] = [];
  const tree = new MenuTree({
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (handle) => clearTimeout(handle),
    panelRect: (depth) => (depth === 1 ? COLORS_PANEL : undefined),
    beforeClose: (submenu) => closed.push(submenu),
  });
  const ids = () => tree.path.map((s) => s.id);
  return { tree, ids, closed };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("hovering a submenu's row", () => {
  it("opens it once the pointer has rested there for the open delay", () => {
    const { tree, ids } = makeTree();
    tree.pointerMove(0, { kind: "submenu", id: COLORS }, onColors);
    vi.advanceTimersByTime(OPEN_DELAY_MS - 1);
    expect(ids()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([COLORS]);
    // A hover doesn't pull focus into the panel.
    expect(tree.path[0]?.focus).toBe(false);
  });

  it("doesn't restart the delay while the pointer drifts within the row", () => {
    const { tree, ids } = makeTree();
    tree.pointerMove(0, { kind: "submenu", id: COLORS }, onColors);
    vi.advanceTimersByTime(100);
    tree.pointerMove(0, { kind: "submenu", id: COLORS }, { x: 210, y: 112 });
    vi.advanceTimersByTime(OPEN_DELAY_MS - 100);
    expect(ids()).toEqual([COLORS]);
  });

  it("never opens it when the pointer only sweeps across", () => {
    const { tree, ids } = makeTree();
    tree.pointerMove(0, { kind: "submenu", id: COLORS }, onColors);
    vi.advanceTimersByTime(50);
    tree.pointerLeaveSubmenuRow(0, COLORS, { x: 200, y: 124 });
    tree.pointerMove(0, { kind: "item" }, onOmega);
    vi.advanceTimersByTime(1000);
    expect(ids()).toEqual([]);
  });

  it("highlights the row straight away", () => {
    const { tree } = makeTree();
    const accept = vi.fn();
    tree.pointerMove(0, { kind: "submenu", id: COLORS }, onColors, accept);
    expect(accept).toHaveBeenCalledOnce();
  });
});

/** A tree with "Colors" hover-opened and the pointer resting on its row. */
function withColorsOpen() {
  const t = makeTree();
  t.tree.pointerMove(0, { kind: "submenu", id: COLORS }, onColors);
  vi.advanceTimersByTime(OPEN_DELAY_MS);
  expect(t.ids()).toEqual([COLORS]);
  return t;
}

describe("moving off an open submenu", () => {
  it("closes it only after the close delay", () => {
    const { tree, ids, closed } = withColorsOpen();
    // Straight down, the way no one heads for a panel to the right.
    tree.pointerLeaveSubmenuRow(0, COLORS, { x: 200, y: 124 });
    tree.pointerMove(0, { kind: "item" }, onOmega);
    vi.advanceTimersByTime(CLOSE_DELAY_MS - 1);
    expect(ids()).toEqual([COLORS]);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
    expect(closed.map((s) => s.id)).toEqual([COLORS]);
  });

  it("keeps it when the pointer comes back to its row within the delay", () => {
    const { tree, ids } = withColorsOpen();
    tree.pointerLeaveSubmenuRow(0, COLORS, { x: 200, y: 124 });
    tree.pointerMove(0, { kind: "item" }, onOmega);
    vi.advanceTimersByTime(CLOSE_DELAY_MS - 50);
    tree.pointerMove(0, { kind: "submenu", id: COLORS }, onColors);
    vi.advanceTimersByTime(1000);
    expect(ids()).toEqual([COLORS]);
  });

  it("keeps it when the pointer slips back into the panel within the delay", () => {
    const { tree, ids } = withColorsOpen();
    tree.pointerMove(1, { kind: "item" }, inPanel);
    // Out of the panel, back across the parent's rows…
    tree.pointerMove(0, { kind: "item" }, onOmega);
    vi.advanceTimersByTime(CLOSE_DELAY_MS - 50);
    // …and in again, even onto the panel's padding.
    tree.pointerMove(1, { kind: "none" }, inPanel);
    vi.advanceTimersByTime(1000);
    expect(ids()).toEqual([COLORS]);
  });

  it("switches to a sibling submenu after the open delay", () => {
    const { tree, ids, closed } = withColorsOpen();
    tree.pointerLeaveSubmenuRow(0, COLORS, { x: 150, y: 124 });
    // Leftward, i.e. away from the panel: no grace.
    tree.pointerMove(0, { kind: "submenu", id: SIZES }, { x: 140, y: 134 });
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(ids()).toEqual([SIZES]);
    expect(closed.map((s) => s.id)).toEqual([COLORS]);
  });

  it("stays open when the pointer leaves the menus altogether", () => {
    const { tree, ids } = withColorsOpen();
    tree.pointerMove(1, { kind: "item" }, inPanel);
    tree.pointerLeaveTree();
    vi.advanceTimersByTime(5000);
    expect(ids()).toEqual([COLORS]);
  });
});

describe("the grace area", () => {
  it("lets the pointer cut diagonally across a sibling's row to the panel", () => {
    const { tree, ids } = withColorsOpen();
    const accept = vi.fn();
    tree.pointerLeaveSubmenuRow(0, COLORS, { x: 290, y: 124 });
    // Across the bottom of "Sizes", heading right and down.
    tree.pointerMove(
      0,
      { kind: "submenu", id: SIZES },
      { x: 295, y: 130 },
      accept,
    );
    vi.advanceTimersByTime(100);
    tree.pointerMove(1, { kind: "item" }, { x: 310, y: 140 });
    vi.advanceTimersByTime(1000);
    expect(ids()).toEqual([COLORS]);
    // "Sizes" never took the highlight on the way across.
    expect(accept).not.toHaveBeenCalled();
  });

  it("lasts as long as the pointer keeps moving, however slowly", () => {
    const { tree, ids } = withColorsOpen();
    const accept = vi.fn();
    tree.pointerLeaveSubmenuRow(0, COLORS, { x: 250, y: 124 });
    for (let i = 1; i <= 8; i++) {
      vi.advanceTimersByTime(GRACE_MS - 50);
      tree.pointerMove(
        0,
        { kind: "submenu", id: SIZES },
        { x: 250 + 5 * i, y: 124 + 2 * i },
        accept,
      );
    }
    tree.pointerMove(1, { kind: "item" }, { x: 310, y: 145 });
    vi.advanceTimersByTime(1000);
    expect(ids()).toEqual([COLORS]);
    expect(accept).not.toHaveBeenCalled();
  });

  it("gives out when the pointer turns back", () => {
    const { tree, ids } = withColorsOpen();
    const accept = vi.fn();
    tree.pointerLeaveSubmenuRow(0, COLORS, { x: 290, y: 124 });
    tree.pointerMove(0, { kind: "submenu", id: SIZES }, { x: 295, y: 130 });
    tree.pointerMove(
      0,
      { kind: "submenu", id: SIZES },
      { x: 280, y: 131 },
      accept,
    );
    expect(accept).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(ids()).toEqual([SIZES]);
  });

  it("acts on where the pointer came to rest once it runs out", () => {
    const { tree, ids } = withColorsOpen();
    const accept = vi.fn();
    tree.pointerLeaveSubmenuRow(0, COLORS, { x: 290, y: 124 });
    tree.pointerMove(
      0,
      { kind: "submenu", id: SIZES },
      { x: 295, y: 130 },
      accept,
    );
    vi.advanceTimersByTime(GRACE_MS);
    expect(accept).toHaveBeenCalledOnce();
    expect(ids()).toEqual([COLORS]);
    vi.advanceTimersByTime(OPEN_DELAY_MS);
    expect(ids()).toEqual([SIZES]);
  });
});

describe("clicks and keys", () => {
  it("open at once, cancelling whatever the pointer had pending", () => {
    const { tree, ids } = makeTree();
    tree.pointerMove(0, { kind: "submenu", id: SIZES }, onSizes);
    tree.open(0, COLORS, true);
    expect(ids()).toEqual([COLORS]);
    expect(tree.path[0]?.focus).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(ids()).toEqual([COLORS]);
  });

  it("reopening an open submenu keeps it, closing only what's inside it", () => {
    const { tree, ids, closed } = makeTree();
    const INNER = Symbol("inner");
    tree.open(0, COLORS, false);
    tree.open(1, INNER, false);
    tree.open(0, COLORS, true);
    expect(ids()).toEqual([COLORS]);
    expect(tree.path[0]?.focus).toBe(false);
    expect(closed.map((s) => s.id)).toEqual([INNER]);
  });

  it("close only the level asked, innermost first", () => {
    const { tree, ids, closed } = makeTree();
    const INNER = Symbol("inner");
    tree.open(0, COLORS, false);
    tree.open(1, INNER, false);
    tree.close(1);
    expect(ids()).toEqual([COLORS]);
    tree.close(0);
    expect(ids()).toEqual([]);
    expect(closed.map((s) => s.id)).toEqual([INNER, COLORS]);
  });

  it("notify subscribers only on a real change", () => {
    const { tree } = makeTree();
    const listener = vi.fn();
    tree.subscribe(listener);
    tree.open(0, COLORS, false);
    tree.open(0, COLORS, false);
    tree.close(1);
    expect(listener).toHaveBeenCalledOnce();
  });
});
