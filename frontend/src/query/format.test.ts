import { describe, expect, it } from "vitest";
import {
  displayText,
  formatSeconds,
  formatValue,
  LOCAL_TIMESTAMP,
  parseFormatter,
  relativeBetween,
  type Formatter,
} from "./format";
import { defaultColumnMetadata, type ColumnMetadata } from "./columns";
import { inZone } from "../dev/inZone";

// The relative-time cases use the exported `relativeBetween` with explicit
// instants (the public `formatValue` uses `Date.now()`).

const numberFmt = (dp: number | number[]): Formatter => ({
  type: "number",
  decimalPlaces: dp,
});

describe("Number formatter", () => {
  it("min/max fraction digits", () => {
    const f = numberFmt([0, 1]);
    expect(formatValue(f, "3")).toBe("3");
    expect(formatValue(f, "3.0")).toBe("3");
    expect(formatValue(f, "3.14")).toBe("3.1");
    expect(formatValue(f, "1234567.8")).toBe("1234567.8");
    expect(formatValue(f, "-3.0")).toBe("-3");
  });

  it("keeps minimum digits", () => {
    const f = numberFmt([2, 4]);
    expect(formatValue(f, "3.5")).toBe("3.50");
    expect(formatValue(f, "3")).toBe("3.00");
  });

  it("bad input is null", () => {
    const f = numberFmt([]);
    expect(formatValue(f, "")).toBeNull();
    expect(formatValue(f, "N/A")).toBeNull();
  });
});

describe("Duration formatter", () => {
  it("formats M:SS", () => {
    const f: Formatter = { type: "duration" };
    expect(formatValue(f, "245")).toBe("4:05");
    expect(formatValue(f, "245.0")).toBe("4:05");
    expect(formatValue(f, "0")).toBe("0:00");
    expect(formatValue(f, "66.4")).toBe("1:06");
    expect(formatValue(f, "3600")).toBe("60:00");
    expect(formatValue(f, "nope")).toBeNull();
  });

  // `file.duration` and the `track.*_position` columns are INTERVALs as of
  // migration 0003, so a duration cell now usually arrives as the interval text
  // `api/query.ts` reads out of the Arrow buffer rather than as bare seconds.
  it("formats an INTERVAL cell's text as well as bare seconds", () => {
    const f: Formatter = { type: "duration" };
    expect(formatValue(f, "00:03:42.25")).toBe("3:42");
    expect(formatValue(f, "00:00:00")).toBe("0:00");
    expect(formatValue(f, "01:02:05")).toBe("62:05");
    expect(formatValue(f, "-00:01:30")).toBe("-1:30");
    expect(formatValue(f, "2 days 00:01:30")).toBe("2881:30");
    expect(formatValue(f, "1 day -00:00:30")).toBe("1439:30");
  });

  // A month is not a fixed number of seconds, so an interval carrying one is
  // not a duration: the formatter declines it and the caller shows it raw.
  it("declines an interval with a month component", () => {
    expect(formatValue({ type: "duration" }, "14 months")).toBeNull();
  });
});

// The now-playing bar's clocks format seconds straight from the audio element.
describe("formatSeconds", () => {
  it("formats M:SS, rounded to the second", () => {
    expect(formatSeconds(0)).toBe("0:00");
    expect(formatSeconds(74.4)).toBe("1:14");
    expect(formatSeconds(254.6)).toBe("4:15");
    expect(formatSeconds(3725)).toBe("62:05");
  });
});

// A stored timestamp is UTC civil time, shown in the viewer's zone. New York
// is UTC-4 in June.
describe("Timestamp formatter", () => {
  inZone("America/New_York");

  it("formats via reduced strftime", () => {
    const f: Formatter = { type: "timestamp", format: "%Y-%m-%d" };
    expect(formatValue(f, "2026-06-07 14:30:45")).toBe("2026-06-07");
    expect(formatValue(f, "2026-06-07")).toBe("2026-06-07");
    expect(formatValue(f, "not a date")).toBeNull();
  });

  it("shows a stored timestamp in local time", () => {
    const f: Formatter = { type: "timestamp", format: "%H:%M:%S" };
    expect(formatValue(f, "2026-06-07 14:30:45")).toBe("10:30:45");
    // Early in the UTC day is the evening before in New York.
    const day: Formatter = { type: "timestamp", format: "%Y-%m-%d %H:%M" };
    expect(formatValue(day, "2026-06-07 02:30:45")).toBe("2026-06-06 22:30");
  });

  it("never shifts a bare date, which is a calendar date", () => {
    const f: Formatter = { type: "timestamp", format: "%Y-%m-%d %H:%M" };
    expect(formatValue(f, "2026-06-07")).toBe("2026-06-07 00:00");
  });

  it("shows epoch seconds in local time", () => {
    const f: Formatter = { type: "timestamp", format: "%Y-%m-%d %H:%M:%S" };
    const epoch = Date.UTC(2026, 5, 7, 14, 30, 45) / 1000;
    expect(formatValue(f, String(epoch))).toBe("2026-06-07 10:30:45");
  });
});

describe("displayText's clock", () => {
  const minutes = {
    ...defaultColumnMetadata(),
    formatter: {
      type: "relativeTime",
      units: ["minutes"],
    } satisfies Formatter,
  };

  it("counts a relative time back from the moment it's given", () => {
    const now = Date.UTC(2026, 5, 1, 12, 30);
    expect(displayText(minutes, "2026-06-01 12:00:00", now)).toBe(
      "30 minutes ago",
    );
  });

  describe("in New York", () => {
    inZone("America/New_York");

    // The stored text is UTC, so the zone the viewer is in changes nothing
    // about how long ago it was: read as local time, this would be four hours
    // off.
    it("reads a stored timestamp as UTC", () => {
      const now = Date.UTC(2026, 5, 1, 12, 30);
      expect(displayText(minutes, "2026-06-01 12:00:00", now)).toBe(
        "30 minutes ago",
      );
    });

    it("counts a bare date from its local midnight", () => {
      const hours = {
        ...defaultColumnMetadata(),
        formatter: { type: "relativeTime", units: ["hours"] } as Formatter,
      };
      // 06:00 on June 1 in New York.
      const now = Date.UTC(2026, 5, 1, 10, 0);
      expect(displayText(hours, "2026-06-01", now)).toBe("6 hours ago");
    });
  });
});

describe("displayText's fallback formatter", () => {
  inZone("America/New_York");

  it("shows a timestamp column with no formatter in local time", () => {
    expect(
      displayText(
        defaultColumnMetadata(),
        "2026-06-07 14:30:45",
        undefined,
        LOCAL_TIMESTAMP,
      ),
    ).toBe("2026-06-07 10:30:45");
  });

  it("gives way to the column's own formatter", () => {
    const meta = {
      ...defaultColumnMetadata(),
      formatter: { type: "timestamp", format: "%H:%M" } as Formatter,
    };
    expect(
      displayText(meta, "2026-06-07 14:30:45", undefined, LOCAL_TIMESTAMP),
    ).toBe("10:30");
  });

  it("leaves text that isn't a timestamp as it is", () => {
    expect(
      displayText(defaultColumnMetadata(), "soon", undefined, LOCAL_TIMESTAMP),
    ).toBe("soon");
  });
});

describe("relativeBetween", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) =>
    Date.UTC(y, mo - 1, d, h, mi, 0);

  it("picks the largest fitting unit", () => {
    const now = at(2026, 6, 7, 12, 0);
    const then = at(2026, 6, 3, 12, 0); // 4 days earlier
    expect(relativeBetween(then, now, [])).toBe("4 days ago");
  });

  it("singular and zero fallback", () => {
    const now = at(2026, 6, 7, 12, 0);
    expect(relativeBetween(at(2026, 6, 6, 12, 0), now, ["days"])).toBe(
      "1 day ago",
    );
    expect(relativeBetween(at(2026, 6, 7, 11, 59), now, ["minutes"])).toBe(
      "1 minute ago",
    );
    expect(relativeBetween(at(2026, 6, 7, 12, 0), now, ["minutes"])).toBe(
      "0 minutes ago",
    );
  });

  it("future uses 'in'", () => {
    const now = at(2026, 6, 7, 12, 0);
    const later = at(2026, 6, 10, 12, 0); // 3 days later
    expect(relativeBetween(later, now, [])).toBe("in 3 days");
  });
});

describe("parseFormatter", () => {
  it("parses a duration blob", () => {
    expect(parseFormatter({ type: "duration" })).toEqual({ type: "duration" });
  });

  it("defaults decimalPlaces when absent", () => {
    expect(parseFormatter({ type: "number" })).toEqual({
      type: "number",
      decimalPlaces: [],
    });
  });

  it("requires a timestamp format", () => {
    expect(parseFormatter({ type: "timestamp" })).toBeUndefined();
    expect(parseFormatter({ type: "timestamp", format: "%Y" })).toEqual({
      type: "timestamp",
      format: "%Y",
    });
  });

  it("returns undefined for unknown/malformed blobs", () => {
    expect(parseFormatter({ type: "bogus" })).toBeUndefined();
    expect(parseFormatter("nonsense")).toBeUndefined();
    expect(parseFormatter(null)).toBeUndefined();
  });
});

describe("displayText", () => {
  it("applies the formatter then wraps with prefix/suffix", () => {
    const meta = {
      ...defaultColumnMetadata(),
      prefix: "#",
      formatter: { type: "duration" } as Formatter,
    };
    expect(displayText(meta, "245")).toBe("#4:05");
  });

  it("falls back to the raw value when the formatter fails", () => {
    const meta = {
      ...defaultColumnMetadata(),
      formatter: { type: "duration" } as Formatter,
    };
    expect(displayText(meta, "nope")).toBe("nope");
  });

  it("passes the raw value through when there is no formatter", () => {
    expect(displayText(defaultColumnMetadata(), "Lemonade")).toBe("Lemonade");
  });
});

describe("displayText's prefix and suffix", () => {
  const meta = (over: Partial<ColumnMetadata>): ColumnMetadata => ({
    ...defaultColumnMetadata(),
    ...over,
  });

  it("surrounds a value", () => {
    expect(displayText(meta({ prefix: "#", suffix: " kg" }), "3")).toBe(
      "#3 kg",
    );
  });

  it("leaves a null value with nothing at all", () => {
    expect(displayText(meta({ prefix: "#", suffix: " kg" }), null)).toBe("");
    expect(
      displayText(
        meta({ formatter: { type: "number", decimalPlaces: 2 } }),
        null,
      ),
    ).toBe("");
  });

  it("still surrounds an empty string, which isn't null", () => {
    expect(displayText(meta({ prefix: "#", suffix: " kg" }), "")).toBe("# kg");
  });

  describe("given a singular and a plural", () => {
    const plays = meta({ suffix: [" play", " plays"] });

    it("picks by the value", () => {
      expect(displayText(plays, "1")).toBe("1 play");
      expect(displayText(plays, "2")).toBe("2 plays");
      expect(displayText(plays, "0")).toBe("0 plays");
      expect(displayText(plays, "11")).toBe("11 plays");
      expect(displayText(plays, "-1")).toBe("-1 play");
    });

    it("picks by the value as it reads, formatter applied", () => {
      const rounded = (decimalPlaces: number) =>
        meta({
          suffix: [" play", " plays"],
          formatter: { type: "number", decimalPlaces },
        });
      expect(displayText(rounded(0), "1.2")).toBe("1 play");
      expect(displayText(rounded(2), "1")).toBe("1.00 plays");
    });

    it("takes the plural for text that isn't a number", () => {
      expect(displayText(plays, "many")).toBe("many plays");
    });

    it("shows nothing for a null value", () => {
      expect(displayText(plays, null)).toBe("");
    });
  });
});
