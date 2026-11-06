import { describe, expect, it } from "vitest";
import { releaseVelocity, shouldClose, swipeAxis } from "./swipe";

describe("swipeAxis", () => {
  it("doesn't judge a touch that has barely moved", () => {
    expect(swipeAxis(0, 0)).toBeNull();
    expect(swipeAxis(-4, 2)).toBeNull();
  });

  it("goes with the dominant direction once it has moved enough", () => {
    expect(swipeAxis(-8, 3)).toBe("horizontal");
    expect(swipeAxis(8, -3)).toBe("horizontal");
    expect(swipeAxis(3, 8)).toBe("vertical");
    expect(swipeAxis(-3, -8)).toBe("vertical");
  });

  it("leaves a dead-on diagonal to the scroll", () => {
    expect(swipeAxis(6, 6)).toBe("vertical");
  });
});

describe("releaseVelocity", () => {
  it("measures over the samples just before the release", () => {
    const samples = [
      { x: 500, t: 0 }, // too old to count
      { x: 200, t: 110 },
      { x: 180, t: 130 },
      { x: 160, t: 150 },
    ];
    expect(releaseVelocity(samples, 160)).toBeCloseTo(-1000);
  });

  it("is zero for a finger that stopped before lifting", () => {
    const samples = [
      { x: 300, t: 0 },
      { x: 100, t: 50 },
    ];
    expect(releaseVelocity(samples, 400)).toBe(0);
  });

  it("is zero without two samples to compare", () => {
    expect(releaseVelocity([], 10)).toBe(0);
    expect(releaseVelocity([{ x: 100, t: 5 }], 10)).toBe(0);
  });
});

describe("shouldClose", () => {
  const WIDTH = 200;

  it("closes on a leftward flick, however short the drag", () => {
    expect(shouldClose(-5, WIDTH, -800)).toBe(true);
  });

  it("stays open on a rightward flick, however far the drag", () => {
    expect(shouldClose(-190, WIDTH, 800)).toBe(false);
  });

  it("goes by distance when released slowly", () => {
    expect(shouldClose(-40, WIDTH, -50)).toBe(false);
    expect(shouldClose(-120, WIDTH, -50)).toBe(true);
    expect(shouldClose(-120, WIDTH, 50)).toBe(true);
  });
});
