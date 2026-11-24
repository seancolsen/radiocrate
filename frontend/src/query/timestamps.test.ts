import { afterEach, describe, expect, it, vi } from "vitest";
import { inZone } from "../dev/inZone";
import {
  isInstantType,
  LOCAL_TIME_CODEC,
  localToUtcText,
  nowUtcText,
  utcCivilText,
  utcToLocalText,
} from "./timestamps";

// Stored timestamps are UTC civil time; only what's shown and typed is local.
// New York is UTC-5 in January and UTC-4 in July.
describe("in New York", () => {
  inZone("America/New_York");
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is really in New York", () => {
    expect(new Date(Date.UTC(2026, 0, 15, 12)).getHours()).toBe(7);
  });

  it("writes now as UTC civil text, not local", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 5));
    expect(nowUtcText()).toBe("2026-01-15 12:00:05");
    expect(utcCivilText(Date.UTC(2026, 6, 4, 23, 59, 59, 999))).toBe(
      "2026-07-04 23:59:59",
    );
  });

  it("shows stored text in local time, DST and date changes included", () => {
    expect(utcToLocalText("2026-01-15 12:00:00")).toBe("2026-01-15 07:00:00");
    expect(utcToLocalText("2026-07-15 12:00:00")).toBe("2026-07-15 08:00:00");
    expect(utcToLocalText("2026-01-15 02:30:00")).toBe("2026-01-14 21:30:00");
  });

  it("declines what isn't stored timestamp text", () => {
    expect(utcToLocalText("2026-01-15")).toBeNull();
    expect(utcToLocalText("2026-02-30 00:00:00")).toBeNull();
    expect(utcToLocalText("2026-01-15 12:00")).toBeNull();
    expect(utcToLocalText("Lemonade")).toBeNull();
  });

  it("takes typed local time back to stored text", () => {
    expect(localToUtcText("2026-01-14 21:30:00")).toBe("2026-01-15 02:30:00");
    expect(localToUtcText("2026-07-15 08:00:00")).toBe("2026-07-15 12:00:00");
    expect(localToUtcText("2026-07-15 08:00")).toBeNull();
  });
});

describe("LOCAL_TIME_CODEC in New York", () => {
  inZone("America/New_York");
  const { show, input, commit } = LOCAL_TIME_CODEC;

  it("shows a stored value in local time and takes it back unchanged", () => {
    const stored = "2026-01-15 12:00:00";
    expect(show(stored)).toBe("2026-01-15 07:00:00");
    expect(input(show(stored))).toBe(stored);
    expect(commit(input(show(stored)))).toBe(stored);
  });

  it("converts a typed local time as soon as it's whole", () => {
    expect(input("2026-01-15 07:00:0")).toBe("2026-01-15 07:00:0");
    expect(input("2026-01-15 07:00:01")).toBe("2026-01-15 12:00:01");
    // What's half typed reads back as typed: the box never reshapes it.
    expect(show(input("2026-01-15 07:0"))).toBe("2026-01-15 07:0");
  });

  it("finishes a looser local spelling when the edit ends", () => {
    expect(commit("2026-01-15 07:00")).toBe("2026-01-15 12:00:00");
    expect(commit("2026-01-15T07:00:00.250")).toBe("2026-01-15 12:00:00");
    expect(commit("2026-01-15")).toBe("2026-01-15 05:00:00");
    expect(commit("2026-7-4 9:15")).toBe("2026-07-04 13:15:00");
  });

  it("never converts stored text twice, and leaves other text alone", () => {
    expect(commit("2026-01-15 12:00:00")).toBe("2026-01-15 12:00:00");
    expect(commit("yesterday")).toBe("yesterday");
    expect(commit("2026-02-30")).toBe("2026-02-30");
    expect(show("yesterday")).toBe("yesterday");
  });
});

describe("in Kolkata (a half-hour offset, UTC+5:30)", () => {
  inZone("Asia/Kolkata");

  it("converts both ways", () => {
    expect(utcToLocalText("2026-01-15 20:00:00")).toBe("2026-01-16 01:30:00");
    expect(localToUtcText("2026-01-16 01:30:00")).toBe("2026-01-15 20:00:00");
  });
});

describe("isInstantType", () => {
  it("is every TIMESTAMP, and neither DATE nor TIME", () => {
    expect(isInstantType("TIMESTAMP")).toBe(true);
    expect(isInstantType("TIMESTAMP_S")).toBe(true);
    expect(isInstantType("timestamp with time zone")).toBe(true);
    expect(isInstantType("DATE")).toBe(false);
    expect(isInstantType("TIME")).toBe(false);
    expect(isInstantType(undefined)).toBe(false);
  });
});
