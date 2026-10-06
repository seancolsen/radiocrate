import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  checkpoint,
  EMPTY_HISTORY,
  hasUnrunEdit,
  pushStep,
  stepBack,
  stepForward,
  stepToRedo,
  stepToUndo,
  type UndoHistory,
} from "./undoHistory";
import type { EntryWrites } from "../query/playlistEntries";

// Definitions are plain strings here; equality is by value.
const equals = (a: string, b: string) => a === b;
const empty: UndoHistory<string> = EMPTY_HISTORY;

const writes: EntryWrites = {
  apply: [{ operation: "delete", table: "playlist_track", where: { id: "e" } }],
  revert: [
    {
      operation: "insert",
      table: "playlist_track",
      values: { id: "e", playlist: "p", track: "t", position: 1 },
    },
  ],
};

/** A history checkpointed at each of `defs` in turn. */
const ran = (...defs: string[]) =>
  defs.reduce((h, d) => checkpoint(h, d, equals), empty);

describe("undo history", () => {
  it("tells an edit not yet run from the definition last run", () => {
    expect(hasUnrunEdit(empty, "a", equals)).toBe(false);
    const h = ran("a", "b");
    expect(hasUnrunEdit(h, "b", equals)).toBe(false);
    expect(hasUnrunEdit(h, "c", equals)).toBe(true);
  });

  it("records the first checkpoint as where it starts, not as a step", () => {
    const h = ran("a");
    expect(h).toEqual({ current: "a", steps: [], index: 0 });
    expect(canUndo(h, "a", equals)).toBe(false);
    expect(canRedo(h, "a", equals)).toBe(false);
  });

  it("makes each change between checkpoints a step, collapsing repeats", () => {
    const h = ran("a", "a", "b", "b", "c");
    expect(h.steps.map((s) => s.definition)).toEqual([
      { before: "a", after: "b" },
      { before: "b", after: "c" },
    ]);
    expect(h.index).toBe(2);
    expect(checkpoint(h, "c", equals)).toBe(h);
  });

  it("can undo an edit that hasn't been checkpointed yet", () => {
    expect(canUndo(ran("a"), "b", equals)).toBe(true);
  });

  it("steps back and forward across definition steps", () => {
    const back = stepBack(ran("a", "b", "c"));
    expect(back.current).toBe("b");
    expect(canRedo(back, "b", equals)).toBe(true);
    // An edit since the undo leaves nothing to redo.
    expect(canRedo(back, "x", equals)).toBe(false);
    const forward = stepForward(back);
    expect(forward.current).toBe("c");
    expect(forward.index).toBe(2);
  });

  it("drops what was undone when a new step is recorded", () => {
    const h = checkpoint(stepBack(ran("a", "b")), "c", equals);
    expect(h.steps.map((s) => s.definition?.after)).toEqual(["c"]);
    expect(stepToRedo(h)).toBeUndefined();
  });

  it("keeps the definition where it was across a step of writes alone", () => {
    const h = pushStep(ran("a"), { writes });
    expect(h.current).toBe("a");
    expect(stepToUndo(h)).toEqual({ writes });
    const back = stepBack(h);
    expect(back).toEqual({ current: "a", steps: [{ writes }], index: 0 });
    expect(canRedo(back, "a", equals)).toBe(true);
    expect(stepForward(back)).toEqual(h);
  });

  it("moves the definition with a step that carries both halves", () => {
    const h = pushStep(ran("a"), {
      writes,
      definition: { before: "a", after: "b" },
    });
    expect(h.current).toBe("b");
    expect(stepBack(h).current).toBe("a");
  });

  it("leaves a history with nowhere to step as it is", () => {
    expect(stepBack(ran("a"))).toEqual(ran("a"));
    expect(stepForward(ran("a", "b"))).toEqual(ran("a", "b"));
  });
});
