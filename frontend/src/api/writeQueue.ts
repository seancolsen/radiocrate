// Writes to one playlist's entries, run one at a time.
//
// A write to a playlist's entries is usually a read and then a write: the
// maximum position to append after, the entries a filter leaves out, the
// positions a drop lands between. Two of them interleaved could each read
// before the other wrote. So every write to one playlist goes through here,
// keyed by its source id, and waits for the one before it to settle — whether
// that one succeeded or failed — before it starts.
//
// Writes under different keys don't wait for one another.

/** Runs writes one at a time per key (see the module comment), and reports
 * when a key starts and stops having writes in flight or waiting. */
export class WriteQueue {
  /** Settles once the last write queued under each key has. */
  private readonly tails = new Map<string, Promise<void>>();
  /** How many writes each key has in flight or waiting. */
  private readonly counts = new Map<string, number>();
  private readonly onBusyChange: (key: string, busy: boolean) => void;

  constructor(onBusyChange: (key: string, busy: boolean) => void) {
    this.onBusyChange = onBusyChange;
  }

  /** Runs `write` once every write queued under `key` before it has settled.
   * Settles as `write` does, and by then `key` no longer counts it as busy. */
  run<T>(key: string, write: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    this.adjust(key, 1);
    const result = previous.then(write).finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
      this.adjust(key, -1);
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    return result;
  }

  /** Whether `key` has a write in flight or waiting. */
  busy(key: string): boolean {
    return (this.counts.get(key) ?? 0) > 0;
  }

  private adjust(key: string, delta: 1 | -1): void {
    const count = (this.counts.get(key) ?? 0) + delta;
    if (count === 0) this.counts.delete(key);
    else this.counts.set(key, count);
    if (count === 0) this.onBusyChange(key, false);
    else if (count === 1 && delta === 1) this.onBusyChange(key, true);
  }
}
