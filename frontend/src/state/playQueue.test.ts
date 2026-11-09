import { describe, expect, it } from "vitest";
import { dequeue, enqueue, queuePositions } from "./playQueue";

const t = (id: string, from = "a") => ({ id, from });

describe("enqueue", () => {
  it("puts tracks after the queue, or ahead of it", () => {
    const queue = [t("1"), t("2")];
    expect(enqueue(queue, [t("3"), t("4")], "last").map((x) => x.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(enqueue(queue, [t("3"), t("4")], "next").map((x) => x.id)).toEqual([
      "3",
      "4",
      "1",
      "2",
    ]);
  });

  it("moves a track already queued rather than queuing it twice", () => {
    const queue = [t("1"), t("2"), t("3")];
    expect(enqueue(queue, [t("1")], "last").map((x) => x.id)).toEqual([
      "2",
      "3",
      "1",
    ]);
    expect(enqueue(queue, [t("3")], "next").map((x) => x.id)).toEqual([
      "3",
      "1",
      "2",
    ]);
  });

  it("queues a track given twice once, where it first appears", () => {
    const queued = enqueue([], [t("1", "a"), t("2"), t("1", "b")], "last");
    expect(queued).toEqual([t("1", "a"), t("2")]);
  });

  it("leaves its input alone", () => {
    const queue = [t("1")];
    enqueue(queue, [t("2")], "next");
    expect(queue).toEqual([t("1")]);
  });
});

describe("dequeue", () => {
  it("takes the named tracks out, keeping the rest in order", () => {
    const queue = [t("1"), t("2"), t("3")];
    expect(dequeue(queue, ["2", "9"]).map((x) => x.id)).toEqual(["1", "3"]);
  });
});

describe("queuePositions", () => {
  it("counts from 1", () => {
    expect(queuePositions([t("x"), t("y")])).toEqual(
      new Map([
        ["x", 1],
        ["y", 2],
      ]),
    );
  });
});
