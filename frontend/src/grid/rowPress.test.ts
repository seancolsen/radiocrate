import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS } from "../gestures/press";
import { RowPress, type PressPoint, type RowPressHost } from "./rowPress";

/** A host that records every call, and accepts or refuses drags. */
function host(canDrag = true, drops = false) {
  const calls: string[] = [];
  const h: RowPressHost = {
    onPickUp: () => calls.push("pickUp"),
    onDragStart: (row, x, y) => {
      calls.push(`dragStart ${row} ${x},${y}`);
      return canDrag;
    },
    onDragMove: (x, y) => calls.push(`dragMove ${x},${y}`),
    onDragEnd: (x, y, drop) => {
      calls.push(`dragEnd ${x},${y} ${drop ? "drop" : "cancel"}`);
      return drop && drops;
    },
    onHold: (row, x, y) => calls.push(`hold ${row} ${x},${y}`),
  };
  return { h, calls };
}

const mouse = (x: number, y: number): PressPoint => ({
  pointerId: 1,
  pointerType: "mouse",
  x,
  y,
});
const touch = (x: number, y: number): PressPoint => ({
  pointerId: 2,
  pointerType: "touch",
  x,
  y,
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a mouse press", () => {
  it("is a click until it moves past the threshold", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(mouse(10, 10), 3);
    press.move(mouse(12, 11));
    expect(press.up(mouse(12, 11))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("drags once it moves past the threshold, and drops on release", () => {
    const { h, calls } = host(true, true);
    const press = new RowPress(h);
    press.down(mouse(10, 10), 3);
    press.move(mouse(20, 10));
    expect(press.dragging).toBe(true);
    press.move(mouse(40, 50));
    expect(press.up(mouse(40, 60))).toBe(true);
    expect(calls).toEqual([
      "dragStart 3 20,10",
      "dragMove 40,50",
      "dragEnd 40,60 drop",
    ]);
    expect(press.dragging).toBe(false);
  });

  it("never raises a menu, even when it drops nothing near where it began", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(mouse(10, 10), 0);
    press.move(mouse(20, 10));
    press.up(mouse(10, 10));
    expect(calls).not.toContain("hold 0 10,10");
  });

  it("stays a click when the rows can't be dragged", () => {
    const { h, calls } = host(false);
    const press = new RowPress(h);
    press.down(mouse(10, 10), 3);
    press.move(mouse(30, 10));
    press.move(mouse(60, 10));
    expect(press.up(mouse(60, 10))).toBe(false);
    expect(calls).toEqual(["dragStart 3 30,10"]);
  });

  it("drops nothing when it's called off", () => {
    const { h, calls } = host(true, true);
    const press = new RowPress(h);
    press.down(mouse(10, 10), 3);
    press.move(mouse(30, 10));
    press.cancel();
    expect(calls.at(-1)).toBe("dragEnd 30,10 cancel");
    expect(press.up(mouse(30, 10))).toBe(false);
  });

  it("is put down by Escape, and still owns its release's click", () => {
    const { h, calls } = host(true, true);
    const press = new RowPress(h);
    press.down(mouse(10, 10), 3);
    press.move(mouse(30, 10));
    press.putDown();
    expect(press.dragging).toBe(false);
    expect(press.pickedUp).toBe(true);
    press.move(mouse(80, 10));
    expect(press.up(mouse(80, 10))).toBe(true);
    expect(calls).toEqual(["dragStart 3 30,10", "dragEnd 30,10 cancel"]);
  });

  it("ignores other pointers, and a second press while one is tracked", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(mouse(10, 10), 3);
    press.down(touch(50, 50), 4);
    press.move(touch(90, 90));
    expect(press.up(touch(90, 90))).toBe(false);
    press.move(mouse(30, 10));
    expect(calls).toEqual(["dragStart 3 30,10"]);
  });
});

describe("a touch press", () => {
  it("picks the rows up once it has rested long enough", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(touch(10, 10), 2);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["pickUp", "dragStart 2 10,10"]);
    expect(press.dragging).toBe(true);
  });

  it("is a scroll when it travels before then", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(touch(10, 10), 2);
    press.move(touch(10, 30));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(press.up(touch(10, 30))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("may wander a little while it rests", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(touch(10, 10), 2);
    press.move(touch(14, 13));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(calls).toEqual(["pickUp", "dragStart 2 14,13"]);
  });

  it("is a tap when it lets go before then", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(touch(10, 10), 2);
    expect(press.up(touch(10, 10))).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(calls).toEqual([]);
  });

  it("raises the menu when it lets go without moving", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(touch(10, 10), 2);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(press.up(touch(12, 10))).toBe(true);
    expect(calls).toEqual([
      "pickUp",
      "dragStart 2 10,10",
      "dragEnd 12,10 drop",
      "hold 2 12,10",
    ]);
  });

  it("drags once picked up, and raises no menu when it drops", () => {
    const { h, calls } = host(true, true);
    const press = new RowPress(h);
    press.down(touch(10, 10), 2);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    press.move(touch(10, 300));
    expect(press.up(touch(10, 300))).toBe(true);
    expect(calls.slice(2)).toEqual(["dragMove 10,300", "dragEnd 10,300 drop"]);
  });

  it("raises no menu when it dragged far and dropped nothing", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(touch(10, 10), 2);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    press.move(touch(10, 300));
    press.up(touch(10, 300));
    expect(calls.at(-1)).toBe("dragEnd 10,300 drop");
  });

  it("still raises the menu when the rows can't be dragged", () => {
    const { h, calls } = host(false);
    const press = new RowPress(h);
    press.down(touch(10, 10), 2);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(press.dragging).toBe(false);
    press.move(touch(10, 20));
    expect(press.up(touch(10, 20))).toBe(true);
    expect(calls).toEqual(["pickUp", "dragStart 2 10,10", "hold 2 10,20"]);
  });

  it("raises nothing when it's called off", () => {
    const { h, calls } = host();
    const press = new RowPress(h);
    press.down(touch(10, 10), 2);
    expect(press.touching).toBe(true);
    press.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(calls).toEqual([]);
    expect(press.touching).toBe(false);
  });
});
