import { describe, expect, it } from "vitest";
import {
  fingerForPull,
  PULL_HOLD,
  PULL_TRIGGER,
  pullDistance,
  ROW_SWIPE_DISTANCE,
  rowSwipeCommits,
  settle,
} from "./rowGestures";

describe("pullDistance", () => {
  it("lags behind the finger", () => {
    expect(pullDistance(40)).toBe(20);
  });

  it("stops at its limit, and reaches the trigger well before it", () => {
    expect(pullDistance(10_000)).toBe(pullDistance(20_000));
    expect(pullDistance(10_000)).toBeGreaterThan(PULL_TRIGGER);
  });

  it("is nothing for a finger that has come back past where it began", () => {
    expect(pullDistance(-30)).toBe(0);
  });

  it("is undone by fingerForPull", () => {
    expect(pullDistance(fingerForPull(PULL_HOLD))).toBe(PULL_HOLD);
  });

  it("waits short of the trigger, so a touch at rest isn't another pull", () => {
    expect(PULL_HOLD).toBeLessThan(PULL_TRIGGER);
  });
});

describe("rowSwipeCommits", () => {
  it("goes by distance without a flick", () => {
    expect(rowSwipeCommits(-ROW_SWIPE_DISTANCE, 0, -1)).toBe(true);
    expect(rowSwipeCommits(-ROW_SWIPE_DISTANCE + 1, 0, -1)).toBe(false);
    expect(rowSwipeCommits(ROW_SWIPE_DISTANCE, 0, 1)).toBe(true);
    expect(rowSwipeCommits(ROW_SWIPE_DISTANCE - 1, 0, 1)).toBe(false);
  });

  it("commits on a flick its own way, however short", () => {
    expect(rowSwipeCommits(-20, -500, -1)).toBe(true);
    expect(rowSwipeCommits(20, 500, 1)).toBe(true);
  });

  it("springs back on a flick the other way, however far", () => {
    expect(rowSwipeCommits(-300, 500, -1)).toBe(false);
    expect(rowSwipeCommits(300, -500, 1)).toBe(false);
  });
});

describe("settle", () => {
  it("moves toward its target, and further in a longer step", () => {
    const short = settle(100, 0, 16);
    const long = settle(100, 0, 64);
    expect(short).toBeLessThan(100);
    expect(long).toBeLessThan(short);
    expect(settle(0, 44, 16)).toBeGreaterThan(0);
  });

  it("arrives exactly", () => {
    let value = 100;
    for (let i = 0; i < 100; i++) value = settle(value, 44, 16);
    expect(value).toBe(44);
  });
});
