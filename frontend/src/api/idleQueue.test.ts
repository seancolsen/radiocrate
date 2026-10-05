import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdleQueue } from "./idleQueue";

/** A write that records each time it's sent and settles when told to. */
function heldWrite() {
  const settle: Array<() => void> = [];
  const write = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        settle.push(resolve);
      }),
  );
  return { write, settle };
}

describe("IdleQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a deferred write once the app has been idle for the whole period", async () => {
    const queue = new IdleQueue(5000);
    const write = vi.fn(() => Promise.resolve());
    queue.defer("a", write);
    await vi.advanceTimersByTimeAsync(4999);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(queue.has("a")).toBe(false);
  });

  it("restarts the idle period on activity", async () => {
    const queue = new IdleQueue(5000);
    const write = vi.fn(() => Promise.resolve());
    queue.defer("a", write);
    await vi.advanceTimersByTimeAsync(4000);
    queue.touch();
    await vi.advanceTimersByTimeAsync(4000);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("waits out a request in flight, then the whole period after it settles", async () => {
    const queue = new IdleQueue(5000);
    const write = vi.fn(() => Promise.resolve());
    let settle = () => {};
    queue.track(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    queue.defer("a", write);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(write).not.toHaveBeenCalled();
    settle();
    await vi.advanceTimersByTimeAsync(4999);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("sends only the latest write deferred under a key", async () => {
    const queue = new IdleQueue(5000);
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    queue.defer("a", first);
    await vi.advanceTimersByTimeAsync(3000);
    queue.defer("a", second);
    await vi.advanceTimersByTimeAsync(5000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a cancelled key", async () => {
    const queue = new IdleQueue(5000);
    const write = vi.fn(() => Promise.resolve());
    queue.defer("a", write);
    queue.cancel("a");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).not.toHaveBeenCalled();
  });

  it("flushes a key right away, leaving the others waiting", async () => {
    const queue = new IdleQueue(5000);
    const a = vi.fn(() => Promise.resolve());
    const b = vi.fn(() => Promise.resolve());
    queue.defer("a", a);
    queue.defer("b", b);
    queue.flush("a");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("holds a key's next write until its previous one has settled", async () => {
    const queue = new IdleQueue(5000);
    const first = heldWrite();
    const second = vi.fn(() => Promise.resolve());
    queue.defer("a", first.write);
    queue.flush("a");
    queue.defer("a", second);
    queue.flush("a");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(second).not.toHaveBeenCalled();
    first.settle[0]();
    await vi.advanceTimersByTimeAsync(5000);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("carries on after a write that fails or throws", async () => {
    const queue = new IdleQueue(5000);
    const rejecting = vi.fn(() => Promise.reject(new Error("nope")));
    const throwing = vi.fn((): Promise<unknown> => {
      throw new Error("nope");
    });
    const after = vi.fn(() => Promise.resolve());
    queue.defer("a", rejecting);
    queue.defer("b", throwing);
    await vi.advanceTimersByTimeAsync(5000);
    queue.defer("a", after);
    await vi.advanceTimersByTimeAsync(5000);
    expect(after).toHaveBeenCalledTimes(1);
  });
});
