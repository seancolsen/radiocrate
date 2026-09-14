import { describe, expect, it } from "vitest";
import * as arrow from "apache-arrow";
import { castDraft } from "immer";
import { buildResultFromStringRows } from "../../query/result";
import { emptyPage } from "./state";
import { createAppVanillaStore } from "./vanillaStore";
import { fakeEnv } from "./testEnv";

// Pins down Immer's behavior around the two state shapes every action relies
// on it handling: a class-instance result that is patched in place, and
// selection `Set`s that are replaced wholesale.

describe("Immer compatibility", () => {
  it("holds a QueryResult by reference, undrafted and unfrozen", () => {
    const store = createAppVanillaStore(fakeEnv());
    const result = buildResultFromStringRows([
      ["a", "1"],
      ["b", "2"],
    ]);

    store.setState((s) => {
      s.pages["t1"] = castDraft({ ...emptyPage(), result });
    });

    // The same instance, not a drafted/cloned copy — QueryResult has no
    // `[immerable]` marker, so Immer neither drafts nor deep-freezes it (see
    // `actions.ts`'s `setTabResult` doc comment).
    expect(store.getState().pages["t1"]?.result).toBe(result);

    // `patchRow` mutates the instance's private `patches` map in place. If
    // autoFreeze had touched it, this would throw.
    const table = new arrow.Table({
      "0": arrow.vectorFromArray(["patched"]),
      "1": arrow.vectorFromArray(["9"]),
    });
    expect(() => result.patchRow(0, table, 0)).not.toThrow();
    expect(result.value(0, 0)).toBe("patched");
  });

  it("treats a selection Set as opaque: replaced wholesale, never mutated through a draft", () => {
    const store = createAppVanillaStore(fakeEnv());
    const first = new Set([1, 2, 3]);

    store.setState((s) => {
      s.pages["t1"] = castDraft({ ...emptyPage(), selection: first });
    });
    expect(store.getState().pages["t1"]?.selection).toBe(first);
    expect([...(store.getState().pages["t1"]?.selection ?? [])]).toEqual([
      1, 2, 3,
    ]);

    // No `enableMapSet()` is called anywhere in the store (see the doc comment
    // on `QueryPageState.selection`) — writes always swap in a fresh `Set`
    // rather than mutating the stored one, exactly like every other action in
    // `actions.ts` (`clickRow`, `moveRowSelection`, …).
    const second = new Set([4]);
    store.setState((s) => {
      s.pages["t1"].selection = second;
    });
    expect(store.getState().pages["t1"]?.selection).toBe(second);
    expect(first.has(1)).toBe(true); // the old Set is untouched, just orphaned
  });
});
