import { afterEach, describe, expect, it, vi } from "vitest";
import { inZone } from "../dev/inZone";
import { playInsert } from "./track";

// A play is stamped in UTC civil time, as every stored timestamp is, whatever
// zone the listener is in (specs/2026-11-utc-timestamps/decision.md) — so
// `last_play:<1h`, which DuckDB measures against its UTC `NOW()`, finds it.
describe("playInsert in New York", () => {
  inZone("America/New_York");
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the play with the current UTC time, not the local one", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 5));
    expect(playInsert("t1")).toEqual({
      id: "play",
      operation: "insert",
      table: "play",
      values: { track: "t1", timestamp: "2026-01-15 12:00:05" },
    });
  });
});
