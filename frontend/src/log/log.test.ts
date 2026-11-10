import { describe, expect, it } from "vitest";
import {
  MAX_LOG_ENTRIES,
  formatLog,
  formatSeconds,
  loadLog,
  saveLogEntries,
  saveLogging,
  type LogEntry,
  type LogStorage,
} from "./log";

function memoryStorage(): LogStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

/** Local time on November 10, 2026. */
function at(h: number, m: number, s: number, ms = 0, day = 10): number {
  return new Date(2026, 10, day, h, m, s, ms).getTime();
}

describe("formatLog", () => {
  it("lines entries up in columns, with details under the message and the date where it changes", () => {
    const entries: LogEntry[] = [
      {
        id: 1,
        time: at(23, 59, 58, 7),
        source: "app",
        message: "Logging started",
        details: ["App build abc1234", "Online"],
      },
      {
        id: 2,
        time: at(0, 0, 1, 250, 11),
        source: "playback",
        message: "Asked to pause",
      },
    ];
    expect(formatLog(entries, at(0, 5, 0, 0, 11)).split("\n")).toEqual([
      "RadioCrate log: 2 entries, copied Wednesday, November 11, 2026 at 00:05.",
      "Times are this device's local time. Lines indented under an entry describe the state at that moment.",
      "",
      "── Tuesday, November 10, 2026 ──",
      "23:59:58.007  App       Logging started",
      "                        App build abc1234",
      "                        Online",
      "",
      "── Wednesday, November 11, 2026 ──",
      "00:00:01.250  Playback  Asked to pause",
    ]);
  });
});

describe("formatSeconds", () => {
  it("writes minutes and seconds, with tenths when asked", () => {
    expect(formatSeconds(0)).toBe("0:00");
    expect(formatSeconds(225.9)).toBe("3:45");
    expect(formatSeconds(5.34, true)).toBe("0:05.3");
    expect(formatSeconds(59.96, true)).toBe("1:00.0");
  });
});

describe("storage", () => {
  it("starts with logging off and nothing logged", () => {
    expect(loadLog(memoryStorage())).toEqual({ logging: false, entries: [] });
  });

  it("keeps the log and whether logging is on", () => {
    const storage = memoryStorage();
    const entry: LogEntry = {
      id: 1,
      time: 5,
      source: "page",
      message: "The app is on screen again",
    };
    saveLogging(storage, true);
    saveLogEntries(storage, [entry]);
    expect(loadLog(storage)).toEqual({ logging: true, entries: [entry] });

    saveLogging(storage, false);
    saveLogEntries(storage, []);
    expect(storage.data.size).toBe(0);
  });

  it("drops entries it can't read, keeps the newest, and removes the old playback log", () => {
    const storage = memoryStorage();
    const good = (id: number): LogEntry => ({
      id,
      time: id,
      source: "app",
      message: `entry ${id}`,
    });
    storage.setItem("playbackLog", "09:41:03.007 hb t1");
    storage.setItem(
      "log",
      JSON.stringify([
        { id: 0, source: "nowhere", message: "?" },
        ...Array.from({ length: MAX_LOG_ENTRIES + 1 }, (_, i) => good(i + 1)),
      ]),
    );
    const { entries } = loadLog(storage);
    expect(entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(entries[0]!.id).toBe(2);
    expect(storage.data.has("playbackLog")).toBe(false);
  });

  it("survives a corrupt log, still logging", () => {
    const storage = memoryStorage();
    storage.setItem("logging", "on");
    storage.setItem("log", "{not json");
    expect(loadLog(storage)).toEqual({ logging: true, entries: [] });
  });
});
