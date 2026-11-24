// Stored timestamps are UTC civil time: zone-less `YYYY-MM-DD HH:MM:SS` text
// that means UTC by convention (see specs/2026-11-utc-timestamps/decision.md).
// The browser writes "now" that way, and converts to and from the viewer's own
// zone only to show a value or to take one typed in — never in the text a key,
// a filter, an export or a write is built from.
//
// A `DATE` (or `TIME`) is a calendar value, not an instant, and is never
// shifted.

/** Civil datetime fields, month 1-based. */
export interface Civil {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function civilText(c: Civil): string {
  return (
    `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)} ` +
    `${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)}`
  );
}

/** The UTC civil fields of epoch milliseconds `ms`. */
function utcFields(ms: number): Civil {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** The viewer's local civil fields of epoch milliseconds `ms`. */
export function localFields(ms: number): Civil {
  const d = new Date(ms);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
  };
}

/** The instant UTC civil fields `c` name. (`Date.UTC` would read a two-digit
 * year as 19xx.) */
export function utcMs(c: Civil): number {
  const d = new Date(0);
  d.setUTCFullYear(c.year, c.month - 1, c.day);
  d.setUTCHours(c.hour, c.minute, c.second, 0);
  return d.getTime();
}

/** The instant the viewer's local civil fields `c` name. A time skipped by a
 * DST change lands after the gap, as `Date` places it. */
export function localMs(c: Civil): number {
  const d = new Date(0);
  d.setFullYear(c.year, c.month - 1, c.day);
  d.setHours(c.hour, c.minute, c.second, 0);
  return d.getTime();
}

/** Epoch milliseconds as stored timestamp text: UTC, to the second. */
export function utcCivilText(ms: number): string {
  return civilText(utcFields(ms));
}

/** The current moment as stored timestamp text. */
export function nowUtcText(): string {
  return utcCivilText(Date.now());
}

/** Epoch milliseconds as the viewer's local time, in the stored spelling. */
export function localCivilText(ms: number): string {
  return civilText(localFields(ms));
}

const CIVIL_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** `text` as civil fields when it is exactly `YYYY-MM-DD HH:MM:SS` and names a
 * real date and time; otherwise `null`. */
function parseExact(text: string): Civil | null {
  const m = CIVIL_RE.exec(text);
  if (!m) return null;
  const c: Civil = {
    year: +m[1],
    month: +m[2],
    day: +m[3],
    hour: +m[4],
    minute: +m[5],
    second: +m[6],
  };
  // Zone-free validation: a Feb 30 or a 25:00 doesn't survive the round trip.
  return civilText(utcFields(utcMs(c))) === text ? c : null;
}

/** Stored timestamp text in the viewer's local time, spelled the same way, or
 * `null` when `text` isn't stored timestamp text. */
export function utcToLocalText(text: string): string | null {
  const c = parseExact(text);
  return c ? localCivilText(utcMs(c)) : null;
}

/** Local `YYYY-MM-DD HH:MM:SS` text as stored timestamp text, or `null` when
 * it isn't exactly that spelling. */
export function localToUtcText(text: string): string | null {
  const c = parseExact(text);
  return c ? utcCivilText(localMs(c)) : null;
}

const LOOSE_RE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d*)?)?)?$/;

/** The looser spellings of a local time someone might finish typing on — a
 * bare date (midnight), no seconds, a `T`, a fraction of a second (dropped) —
 * as stored timestamp text; `null` for anything else. */
function looseLocalToUtcText(text: string): string | null {
  const m = LOOSE_RE.exec(text.trim());
  if (!m) return null;
  const c: Civil = {
    year: +m[1],
    month: +m[2],
    day: +m[3],
    hour: +(m[4] ?? 0),
    minute: +(m[5] ?? 0),
    second: +(m[6] ?? 0),
  };
  return parseExact(civilText(c)) ? utcCivilText(localMs(c)) : null;
}

/** How a value the form holds reads in its text box, and how what's typed
 * there goes back into the form. */
export interface ValueCodec {
  /** The held value as the box shows it. */
  show: (held: string) => string;
  /** A keystroke's text as the form holds it. The exact inverse of `show`, so
   * typing never reshapes what's in the box. */
  input: (typed: string) => string;
  /** The held value as the edit ends on it, which may finish a spelling
   * `input` left alone. */
  commit: (held: string) => string;
}

/** A stored timestamp's codec: the form holds UTC text, the box shows and
 * takes the viewer's local time. Text that isn't a timestamp passes through
 * as typed, for the database to accept or refuse. */
export const LOCAL_TIME_CODEC: ValueCodec = {
  show: (held) => utcToLocalText(held) ?? held,
  input: (typed) => localToUtcText(typed) ?? typed,
  // Exact text is already stored text — `input` converted it, or it came from
  // the database — so only a looser spelling is left to read as local time.
  commit: (held) =>
    parseExact(held) ? held : (looseLocalToUtcText(held) ?? held),
};

/** Whether a column of DuckDB type `type` holds an instant, stored as UTC
 * civil time: a `TIMESTAMP` of any precision (with or without a zone, both of
 * which read back as UTC text). A `DATE` or `TIME` doesn't. */
export function isInstantType(type: string | undefined): boolean {
  return (type ?? "").trim().toUpperCase().startsWith("TIMESTAMP");
}
