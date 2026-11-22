import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventsHello, Topic } from "api-client";
import type { ChangeStreamHandlers } from "../api/events";
import {
  createLiveUpdates,
  LIVE_TOPICS,
  WriteTracker,
  type LiveUpdates,
  type Refetch,
} from "./liveUpdates";

/** A change stream the test speaks for. */
function fakeStream() {
  let handlers!: ChangeStreamHandlers;
  const state = { open: false, opens: 0 };
  return {
    state,
    openStream: (h: ChangeStreamHandlers) => {
      handlers = h;
      return {
        open: () => {
          if (state.open) return;
          state.open = true;
          state.opens++;
        },
        close: () => {
          state.open = false;
        },
      };
    },
    hello: (epoch: string, versions: Partial<Record<Topic, number>> = {}) =>
      handlers.onHello({ epoch, versions } as EventsHello),
    changed: (topic: Topic, version: number, origin: string | null = null) =>
      handlers.onChanged({ topic, version, origin }),
    down: (reason: string) => handlers.onDown?.(reason),
  };
}

/** A refetch whose calls can be held open and let go of, one at a time. */
function controllableRefetch() {
  const calls: { topic: Topic; release: () => void }[] = [];
  const refetch = vi.fn(
    (topic: Topic) =>
      new Promise<boolean>((resolve) => {
        calls.push({ topic, release: () => resolve(true) });
      }),
  );
  return { calls, refetch };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("live updates", () => {
  let live: LiveUpdates | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    live?.dispose();
    live = undefined;
    vi.useRealTimers();
  });

  const start = (refetch: (topic: Topic) => Promise<boolean>) => {
    const stream = fakeStream();
    const writes = new WriteTracker();
    live = createLiveUpdates({
      openStream: stream.openStream,
      clientId: "me",
      refetch,
      writes,
    });
    live.show();
    return { stream, writes, live };
  };

  it("lets the boot loads go on the first hello, refetching nothing", async () => {
    const refetch = vi.fn<(topic: Topic) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const { stream, live } = start(refetch);
    const ready = vi.fn();
    void live.ready.then(ready);
    await flush();
    expect(ready).not.toHaveBeenCalled();
    stream.hello("a", { sources: 3 });
    await flush();
    expect(ready).toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
  });

  it("lets the boot loads go without a stream that fails or dawdles", async () => {
    const ready = vi.fn();
    const first = start(() => Promise.resolve(true));
    void first.live.ready.then(ready);
    first.stream.down("502");
    await flush();
    expect(ready).toHaveBeenCalled();
    first.live.dispose();

    const late = vi.fn();
    const refetch = vi.fn<(topic: Topic) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const second = start(refetch);
    void second.live.ready.then(late);
    await vi.advanceTimersByTimeAsync(1000);
    expect(late).toHaveBeenCalled();
    // The loads went before the stream started, so a change may have landed
    // in between: its first hello catches up on everything.
    second.stream.hello("a");
    await flush();
    expect(refetch.mock.calls.map(([topic]) => topic)).toEqual(LIVE_TOPICS);
  });

  it("refetches another device's change, and skips its own echo", async () => {
    const refetch = vi.fn<(topic: Topic) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const { stream } = start(refetch);
    stream.hello("a");
    stream.changed("presets", 1, "someone-else");
    stream.changed("settings", 1, "me");
    // A version already seen is old news.
    stream.changed("presets", 1, "someone-else");
    await flush();
    expect(refetch.mock.calls.map(([topic]) => topic)).toEqual(["presets"]);
  });

  it("catches up on reconnect with only the topics that moved", async () => {
    const refetch = vi.fn<(topic: Topic) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const { stream, live } = start(refetch);
    stream.hello("a", { sources: 1, presets: 4 });
    // Its own write moved settings while it was connected.
    stream.changed("settings", 1, "me");
    live.hide();
    await vi.advanceTimersByTimeAsync(5000);
    expect(stream.state.open).toBe(false);
    live.show();
    expect(stream.state.open).toBe(true);
    stream.hello("a", { sources: 2, presets: 4, settings: 1 });
    await flush();
    expect(refetch.mock.calls.map(([topic]) => topic)).toEqual(["sources"]);
  });

  it("refetches everything when the server has restarted", async () => {
    const refetch = vi.fn<(topic: Topic) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const { stream } = start(refetch);
    stream.hello("a", { sources: 5 });
    stream.hello("b", {});
    await flush();
    expect(refetch.mock.calls.map(([topic]) => topic)).toEqual(LIVE_TOPICS);
  });

  it("stays connected through a quick look away", async () => {
    const { stream, live } = start(() => Promise.resolve(true));
    live.hide();
    await vi.advanceTimersByTimeAsync(3000);
    live.show();
    await vi.advanceTimersByTimeAsync(5000);
    expect(stream.state).toEqual({ open: true, opens: 1 });
  });

  it("coalesces a burst into one refetch in flight and one behind it", async () => {
    const { calls, refetch } = controllableRefetch();
    const { stream } = start(refetch);
    stream.hello("a");
    for (let version = 1; version <= 10; version++) {
      stream.changed("settings", version, "other");
    }
    await flush();
    expect(calls).toHaveLength(1);
    calls[0].release();
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].release();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("waits out this device's own write to the topic before refetching", async () => {
    const refetch = vi.fn<(topic: Topic) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const { stream, writes } = start(refetch);
    stream.hello("a");
    let land!: () => void;
    writes.track(
      "preset.update",
      new Promise<void>((resolve) => {
        land = resolve;
      }),
    );
    stream.changed("presets", 1, "other");
    await flush();
    expect(refetch).not.toHaveBeenCalled();
    land();
    await flush();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("refetches again when one of its own writes overtakes the refetch", async () => {
    const writes = new WriteTracker();
    let attempts = 0;
    const refetch = vi.fn<Refetch>(async (_, superseded) => {
      attempts++;
      // This device writes while the first fetch is on its way.
      if (attempts === 1) writes.track("setting.set", Promise.resolve());
      await Promise.resolve();
      return !superseded();
    });
    const stream = fakeStream();
    live = createLiveUpdates({
      openStream: stream.openStream,
      clientId: "me",
      refetch,
      writes,
    });
    live.show();
    stream.hello("a");
    stream.changed("settings", 1, "other");
    await flush();
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("knows which topics each write touches", () => {
    const writes = new WriteTracker();
    writes.track("dml", Promise.resolve());
    writes.track("source.list", Promise.resolve());
    expect(writes.generation("sources")).toBe(1);
    expect(writes.generation("ratings")).toBe(1);
    expect(writes.generation("keybindings")).toBe(0);
    writes.track("metadata.computed_column.rename", Promise.resolve());
    expect(writes.generation("field-metadata")).toBe(1);
  });
});
