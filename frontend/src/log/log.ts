// The app's log: what the app did, kept so that a problem nobody was watching
// as it happened (playback that stops on a locked phone, a request that fails
// in the background) can be looked into afterwards. It's kept only while the
// user has logging turned on (Settings → Logging), and is read by people, not
// programs: every entry says in plain words what happened, with any state
// worth knowing listed under it, one fact to a line.
//
// The entries live in the app store (`logging`, `logEntries`), which writes
// them through the store's `log` action; anything outside the store — the
// audio engine — is handed a {@link Logger}. This module is the vocabulary
// they share: what an entry is, how the log is kept in storage, and how it
// reads as text when it's copied out.

/** Where an entry came from — the part of the app that wrote it. */
export type LogSource = "app" | "page" | "network" | "server" | "playback";

/** Each source's name, as the log shows it. */
export const LOG_SOURCE_NAMES: Record<LogSource, string> = {
  app: "App",
  page: "Page",
  network: "Network",
  server: "Server",
  playback: "Playback",
};

/** One thing that happened. */
export interface LogEntry {
  /** Unique within the log, and increasing — the order entries were written. */
  readonly id: number;
  /** When it happened, in epoch milliseconds. */
  readonly time: number;
  readonly source: LogSource;
  /** What happened, as a sentence without its full stop. */
  readonly message: string;
  /** The state around it, one fact per line. */
  readonly details?: readonly string[];
}

/** Where code outside the store writes to the log. */
export interface Logger {
  /** Whether logging is on. Anything that costs something to describe checks
   * this first: {@link add} drops entries while it's off anyway. */
  readonly enabled: boolean;
  add(source: LogSource, message: string, details?: readonly string[]): void;
}

/** Entries kept, oldest dropped first: over an hour of locked playback at the
 * background status rate, while staying small enough to paste somewhere. */
export const MAX_LOG_ENTRIES = 2000;

// ── Storage ─────────────────────────────────────────────────────────────────
//
// The log outlives the page: a backgrounded tab can be discarded and reloaded
// without the user ever seeing it, and the reload is part of the story. So
// both the entries and whether logging is on are kept in storage.

/** `localStorage`, narrowed to what the log needs. */
export type LogStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const ENTRIES_KEY = "log";
const LOGGING_KEY = "logging";
/** Where an earlier build kept a playback-only log, always on. Removed on
 * load: it can run to a megabyte nobody asked for. */
const LEGACY_KEY = "playbackLog";

const SOURCES = new Set(Object.keys(LOG_SOURCE_NAMES));

function isEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "number" &&
    typeof e.time === "number" &&
    typeof e.source === "string" &&
    SOURCES.has(e.source) &&
    typeof e.message === "string" &&
    (e.details === undefined ||
      (Array.isArray(e.details) &&
        e.details.every((d) => typeof d === "string")))
  );
}

/** Whether logging was left on, and the log as it was left. Anything
 * unreadable is dropped rather than trusted. */
export function loadLog(storage: LogStorage): {
  logging: boolean;
  entries: LogEntry[];
} {
  let logging = false;
  let entries: LogEntry[] = [];
  try {
    storage.removeItem(LEGACY_KEY);
    logging = storage.getItem(LOGGING_KEY) === "on";
    const raw = storage.getItem(ENTRIES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      entries = parsed.filter(isEntry).slice(-MAX_LOG_ENTRIES);
    }
  } catch {
    // Unavailable or corrupt: start with logging off and nothing logged.
  }
  return { logging, entries };
}

/** Writes the log to storage, or removes it when it's empty. */
export function saveLogEntries(
  storage: LogStorage,
  entries: readonly LogEntry[],
): void {
  try {
    if (entries.length === 0) storage.removeItem(ENTRIES_KEY);
    else storage.setItem(ENTRIES_KEY, JSON.stringify(entries));
  } catch {
    // Full or unavailable: the log in memory is still there to copy.
  }
}

/** Remembers whether logging is on. */
export function saveLogging(storage: LogStorage, logging: boolean): void {
  try {
    if (logging) storage.setItem(LOGGING_KEY, "on");
    else storage.removeItem(LOGGING_KEY);
  } catch {
    // Unavailable: logging lasts as long as this page.
  }
}

// ── Text ────────────────────────────────────────────────────────────────────

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `HH:MM:SS.mmm`, in local time — so a log lines up with what the user
 * remembers ("it went quiet just after 9:41"). */
export function formatLogTime(time: number): string {
  const d = new Date(time);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** The local date, written out: "Tuesday, November 10, 2026". */
export function formatLogDate(time: number): string {
  return new Date(time).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Whether two times fall on the same local day. */
export function sameLogDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

const SOURCE_WIDTH = Math.max(
  ...Object.values(LOG_SOURCE_NAMES).map((name) => name.length),
);

/** The log as text, for pasting into a bug report: a line saying what it is,
 * then the entries oldest first, in columns — time, source, message — with
 * each entry's details indented under its message, and a line naming the
 * date wherever it changes. */
export function formatLog(entries: readonly LogEntry[], now: number): string {
  const noun = entries.length === 1 ? "entry" : "entries";
  const lines = [
    `RadioCrate log: ${entries.length} ${noun}, copied ${formatLogDate(now)} at ${formatLogTime(now).slice(0, 5)}.`,
    "Times are this device's local time. Lines indented under an entry describe the state at that moment.",
  ];
  const indent = " ".repeat(12 + 2 + SOURCE_WIDTH + 2);
  let previous: number | undefined;
  for (const entry of entries) {
    if (previous === undefined || !sameLogDay(previous, entry.time)) {
      lines.push("", `── ${formatLogDate(entry.time)} ──`);
    }
    previous = entry.time;
    const source = LOG_SOURCE_NAMES[entry.source].padEnd(SOURCE_WIDTH);
    lines.push(`${formatLogTime(entry.time)}  ${source}  ${entry.message}`);
    for (const detail of entry.details ?? []) lines.push(indent + detail);
  }
  return lines.join("\n");
}

// ── Describing values ───────────────────────────────────────────────────────

/** A duration or position in seconds, as `m:ss` — or `m:ss.s` with `tenths`,
 * for a position a status is comparing against the clock. */
export function formatSeconds(seconds: number, tenths = false): string {
  if (!Number.isFinite(seconds)) return "?";
  const sign = seconds < 0 ? "-" : "";
  // Rounded before it's split, so 59.96 s reads 1:00.0 rather than 0:60.0.
  const total = tenths
    ? Math.round(Math.abs(seconds) * 10) / 10
    : Math.floor(Math.abs(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  const secs = tenths ? rest.toFixed(1).padStart(4, "0") : pad(rest);
  return `${sign}${minutes}:${secs}`;
}

/** A byte count, in the largest unit that keeps it above one. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** An error, as one line: its name (unless it's the plain `Error`) and its
 * message. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.name && err.name !== "Error"
      ? `${err.name}: ${err.message}`
      : err.message;
  }
  return String(err);
}

/** The top of an error's stack, minus the line repeating its message: where
 * it was thrown. */
export function stackLines(err: unknown, max = 5): string[] {
  if (!(err instanceof Error) || !err.stack) return [];
  return err.stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at ") || line.includes("@"))
    .slice(0, max);
}
