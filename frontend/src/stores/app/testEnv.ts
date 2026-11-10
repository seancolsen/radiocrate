import { vi } from "vitest";
import type { EngineEvents, LoadedRange, Player } from "../../audio/engine";
import type { AppEnv } from "../env";

/** A stand-in for the audio engine that plays nothing: it keeps the play
 * context the store hands it (`history`, `current`, `queue`) and moves through
 * it as the engine would, reporting each move the way the engine does — so a
 * test can play, skip and let tracks end and watch what the store makes of it.
 * Build one through {@link fakeEnv}'s `createPlayer`. */
export class FakePlayer implements Player {
  history: string[] = [];
  current: string | undefined;
  queue: string[] = [];
  isPlaying = false;
  position = 0;
  duration: number | null = null;
  pastHalfway = false;
  loading = false;
  buffered: LoadedRange[] = [];
  error: string | null = null;

  constructor(private readonly events: EngineEvents) {}

  get hasNext(): boolean {
    return this.queue.length > 0;
  }

  setQueue(preceding: string[], current: string, upcoming: string[]): void {
    this.history = [...preceding];
    this.current = current;
    this.queue = [...upcoming];
    this.isPlaying = true;
  }

  updateQueue(preceding: string[] | null, upcoming: string[]): void {
    if (this.current === undefined) return;
    if (preceding !== null) this.history = [...preceding];
    this.queue = [...upcoming];
  }

  skipNext(): void {
    const next = this.queue.shift();
    if (next === undefined) return;
    if (this.current !== undefined) this.history.push(this.current);
    this.current = next;
    this.events.onTrackChange(next, "next");
  }

  skipPrevious(): void {
    const prev = this.history.pop();
    if (prev === undefined) return;
    if (this.current !== undefined) this.queue.unshift(this.current);
    this.current = prev;
    this.events.onTrackChange(prev, "previous");
  }

  /** The playing track reaches its end: it's logged, and the next one starts,
   * or there's none and the queue has run dry. */
  end(): void {
    if (this.current !== undefined) this.events.onPlayCompleted(this.current);
    if (this.queue.length === 0) this.events.onQueueDry();
    else this.skipNext();
  }

  play(): void {
    this.isPlaying = true;
  }
  pause(): void {
    this.isPlaying = false;
  }
  seek(): void {}
  stop(): void {
    this.current = undefined;
    this.history = [];
    this.queue = [];
    this.isPlaying = false;
  }
  setMetadata(): void {}
  logSettings(): void {}
}

/** A fake {@link AppEnv} for store unit tests: an in-memory `storage`, a
 * `matchMedia` that always reports light/no-match (tests that care about dark
 * mode pass their own), spies for `setDocumentTheme`, the clipboard and
 * file saving instead of a real DOM, and a {@link FakePlayer} for playback
 * (vitest runs these tests in the `node` environment — see
 * `vitest.config.ts`). */
export function fakeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  const backing = new Map<string, string>();
  return {
    storage: {
      getItem: (key) => backing.get(key) ?? null,
      setItem: (key, value) => {
        backing.set(key, value);
      },
      removeItem: (key) => {
        backing.delete(key);
      },
    },
    matchMedia: vi.fn(
      () =>
        ({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    ),
    setDocumentTheme: vi.fn(),
    writeClipboardText: vi.fn(() => Promise.resolve()),
    saveTextFile: vi.fn(() => Promise.resolve(true)),
    createPlayer: (events) => new FakePlayer(events),
    describeEnvironment: () => ["Test environment"],
    ...overrides,
  };
}
