import { describe, expect, it, vi } from "vitest";
import { WriteQueue } from "./writeQueue";

/** A promise and the functions that settle it. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise reaction run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("WriteQueue", () => {
  it("runs a key's writes one at a time, in order", async () => {
    const queue = new WriteQueue(() => {});
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    const a = queue.run("p", () => {
      started.push("first");
      return first.promise;
    });
    const b = queue.run("p", () => {
      started.push("second");
      return second.promise;
    });
    await flush();
    expect(started).toEqual(["first"]);
    first.resolve();
    await a;
    await flush();
    expect(started).toEqual(["first", "second"]);
    second.resolve();
    await b;
  });

  it("starts the next write after a failure, and passes the failure on", async () => {
    const queue = new WriteQueue(() => {});
    const failed = queue.run("p", () => Promise.reject(new Error("no")));
    const next = queue.run("p", () => Promise.resolve(2));
    await expect(failed).rejects.toThrow("no");
    await expect(next).resolves.toBe(2);
  });

  it("doesn't hold one key's writes behind another's", async () => {
    const queue = new WriteQueue(() => {});
    const held = deferred();
    void queue.run("p", () => held.promise);
    const other = vi.fn(() => Promise.resolve());
    await queue.run("q", other);
    expect(other).toHaveBeenCalledOnce();
    held.resolve();
  });

  it("is no longer busy by the time a write's caller hears it settled", async () => {
    const queue = new WriteQueue(() => {});
    await queue.run("p", () => Promise.resolve());
    expect(queue.busy("p")).toBe(false);
    await queue.run("p", () => Promise.reject(new Error("no"))).catch(() => {});
    expect(queue.busy("p")).toBe(false);
  });

  it("reports when a key starts and stops being busy", async () => {
    const changes: Array<[string, boolean]> = [];
    const queue = new WriteQueue((key, busy) => changes.push([key, busy]));
    const first = deferred();
    const second = deferred();
    void queue.run("p", () => first.promise);
    void queue.run("p", () => second.promise);
    expect(changes).toEqual([["p", true]]);
    expect(queue.busy("p")).toBe(true);
    first.resolve();
    await flush();
    expect(queue.busy("p")).toBe(true);
    second.resolve();
    await flush();
    expect(changes).toEqual([
      ["p", true],
      ["p", false],
    ]);
    expect(queue.busy("p")).toBe(false);
  });
});
