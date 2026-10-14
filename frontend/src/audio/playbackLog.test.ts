import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackLog, type LogStorage } from "./playbackLog";

function memoryStorage(): LogStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const at = (h: number, m: number, s: number, ms: number) => () =>
  new Date(2026, 9, 14, h, m, s, ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the playback log", () => {
  it("stamps each line with the local time", () => {
    const log = new PlaybackLog(memoryStorage(), at(9, 41, 3, 7));
    log.add("handoff", "B t=0.00");
    log.add("hb");
    expect(log.text()).toBe("09:41:03.007 handoff B t=0.00\n09:41:03.007 hb");
  });

  it("keeps only the newest lines", () => {
    const log = new PlaybackLog(memoryStorage());
    for (let i = 0; i < 3000; i++) log.add("hb", String(i));
    expect(log.length).toBe(2500);
    expect(log.text().split("\n")[0]).toMatch(/ hb 500$/);
  });

  it("writes to storage after a delay, or at once when flushed", () => {
    const storage = memoryStorage();
    const log = new PlaybackLog(storage);
    log.add("one");
    expect(storage.data.size).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(storage.data.size).toBe(1);

    log.add("two");
    log.flush();
    expect(new PlaybackLog(storage).length).toBe(2);
  });

  it("is empty everywhere once cleared", () => {
    const storage = memoryStorage();
    const log = new PlaybackLog(storage);
    log.add("one");
    log.flush();
    log.clear();
    vi.advanceTimersByTime(5000);
    expect(log.length).toBe(0);
    expect(new PlaybackLog(storage).length).toBe(0);
  });

  it("carries on in memory when storage refuses it", () => {
    const fail = () => {
      throw new Error("quota");
    };
    const log = new PlaybackLog({
      getItem: fail,
      setItem: fail,
      removeItem: fail,
    });
    log.add("one");
    log.flush();
    expect(log.length).toBe(1);
  });
});
