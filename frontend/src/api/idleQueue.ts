// Writes that can wait, held back until the app goes quiet.
//
// Some writes don't need to reach the backend the moment they're made, and are
// better off not competing with the requests that do. A saved query's
// definition is the case in point: the user edits it in bursts, every edit
// re-runs the query, and the moment the rows land is the moment they're likely
// to play a track — a stream that should have the connection, and the server,
// to itself. So the save is formulated as the edit is made but held here, and
// only sent once the app has been idle for a while: no request in flight, none
// sent, and no write deferred for the whole of the idle period. Anything that
// happens restarts it.
//
// A later write under the same key replaces the one waiting there, so a burst
// of edits sends one request, carrying the last of them. Writes under one key
// are also sent one at a time: a write deferred while the previous one is still
// in flight waits for it to settle, so the backend sees them in order.

/** One deferred write: sends its request, and settles once that has been
 * answered. It reports its own failure — the queue only waits for it. */
export type DeferredWrite = () => Promise<unknown>;

/** Defers writes until the app has been idle for `idleMs` (see the module
 * comment). What counts as activity is the owner's to report: {@link touch}
 * for a moment of it, {@link track} for a request in flight. Deferring a write
 * counts too. */
export class IdleQueue {
  private readonly idleMs: number;
  /** The writes waiting, by key. */
  private readonly waiting = new Map<string, DeferredWrite>();
  /** Keys whose previous write is still in flight. */
  private readonly sending = new Set<string>();
  /** Requests in flight anywhere in the app ({@link track}). */
  private inFlight = 0;
  /** When the app was last seen doing something (`Date.now()` time). */
  private lastActivity = -Infinity;
  /** The pending idle check, if one is set. */
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(idleMs: number) {
    this.idleMs = idleMs;
  }

  /** Holds `write` under `key` until the app has been idle, replacing any write
   * already waiting there. */
  defer(key: string, write: DeferredWrite): void {
    this.waiting.set(key, write);
    this.touch();
  }

  /** Drops the write waiting under `key`, if there is one. One already sent is
   * beyond recall. */
  cancel(key: string): void {
    this.waiting.delete(key);
  }

  /** Whether a write is waiting under `key`. */
  has(key: string): boolean {
    return this.waiting.has(key);
  }

  /** Sends the write waiting under `key` now, idle or not — unless the
   * previous write under it is still in flight, in which case it waits its
   * turn, and then for the app to go idle again. */
  flush(key: string): void {
    if (!this.sending.has(key)) this.send(key);
  }

  /** {@link flush} for every key. */
  flushAll(): void {
    for (const key of [...this.waiting.keys()]) this.flush(key);
  }

  /** Notes a moment of activity: the idle period starts again from now. */
  touch(): void {
    this.lastActivity = Date.now();
    this.arm();
  }

  /** Notes a request in flight. The app isn't idle until it has settled, and
   * the idle period then counts from when it did. */
  track(settled: Promise<unknown>): void {
    this.inFlight++;
    this.touch();
    const done = () => {
      this.inFlight--;
      this.touch();
    };
    void settled.then(done, done);
  }

  /** Stops the idle check and drops every waiting write. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.waiting.clear();
  }

  /** Sets the idle check for when the current idle period would end, if there's
   * anything for it to send. A no-op when one is already set: activity doesn't
   * move the timer, which instead checks, when it fires, whether there was any
   * since — so a stream of requests costs a timestamp each, not a timer. */
  private arm(): void {
    if (this.timer !== undefined || this.inFlight > 0) return;
    if (!this.anySendable()) return;
    const wait = Math.max(0, this.lastActivity + this.idleMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.check();
    }, wait);
  }

  /** Whether a write is waiting that isn't stuck behind its key's last one. */
  private anySendable(): boolean {
    for (const key of this.waiting.keys()) {
      if (!this.sending.has(key)) return true;
    }
    return false;
  }

  private check(): void {
    // A request in flight re-arms the check as it settles (see `track`).
    if (this.inFlight > 0) return;
    if (Date.now() - this.lastActivity < this.idleMs) {
      this.arm();
      return;
    }
    for (const key of [...this.waiting.keys()]) {
      if (!this.sending.has(key)) this.send(key);
    }
  }

  private send(key: string): void {
    const write = this.waiting.get(key);
    if (write === undefined) return;
    this.waiting.delete(key);
    this.sending.add(key);
    const done = () => {
      this.sending.delete(key);
      // A write deferred under this key meanwhile has been waiting on this one.
      this.arm();
    };
    let sent: Promise<unknown>;
    try {
      sent = write();
    } catch (err) {
      sent = Promise.reject(err);
    }
    void sent.then(done, done);
  }
}
