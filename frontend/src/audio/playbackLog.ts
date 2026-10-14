// A rolling record of what the audio engine — and the page around it — did,
// for diagnosing playback that misbehaves where no debugger can watch: a phone
// in a pocket with its screen locked.
//
// Each entry is one line of text, stamped with the local wall-clock time, so a
// copied log reads straight off the clipboard and lines up with what the user
// remembers ("it went quiet just after 9:41"). Gaps matter as much as entries:
// the engine writes a heartbeat every couple of seconds while a track is
// loaded, so a stretch with no lines at all means the page wasn't running.
//
// The log outlives the page — a backgrounded tab can be discarded and reloaded
// without the user ever seeing it — so it's kept in storage. Writing it on every
// entry would serialize the whole log every couple of seconds, so writes are
// batched, and {@link PlaybackLog.flush} is there for the moments a page may be
// about to stop running (hidden, frozen, unloaded).

/** `localStorage`, narrowed to what the log needs. */
export type LogStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_KEY = "playbackLog";

/** Lines kept, oldest dropped first: about an hour and a half of locked
 * playback at the hidden-page heartbeat rate, which is what a diagnosis needs,
 * while staying small enough to paste somewhere. */
const MAX_LINES = 2500;

/** How long an entry may wait in memory before the log is written to storage. */
const FLUSH_DELAY_MS = 5000;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `HH:MM:SS.mmm`, local time. */
function stamp(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export class PlaybackLog {
  private readonly storage: LogStorage;
  private readonly now: () => Date;
  private lines: string[];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(storage: LogStorage, now: () => Date = () => new Date()) {
    this.storage = storage;
    this.now = now;
    let saved: string | null = null;
    try {
      saved = storage.getItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: the log still works, for this page's life.
    }
    this.lines = saved ? saved.split("\n") : [];
  }

  /** Appends an entry: `kind` names what happened, `detail` the state around it. */
  add(kind: string, detail?: string): void {
    const time = stamp(this.now());
    this.lines.push(detail ? `${time} ${kind} ${detail}` : `${time} ${kind}`);
    if (this.lines.length > MAX_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LINES);
    }
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  /** Writes the log to storage now. */
  flush(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    try {
      this.storage.setItem(STORAGE_KEY, this.lines.join("\n"));
    } catch {
      // Full or unavailable: the in-memory log is still there to copy.
    }
  }

  /** The whole log, oldest entry first. */
  text(): string {
    return this.lines.join("\n");
  }

  get length(): number {
    return this.lines.length;
  }

  clear(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.lines = [];
    try {
      this.storage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clear.
    }
  }
}
