import { describe, expect, it } from "vitest";
import type { Completer } from "querydown-codemirror";
import { prepending } from "./querydownEditor";

/** A completer that records what it was asked, and offers the word ending at
 * the cursor. */
function recording() {
  const calls: { source: string; cursor: number }[] = [];
  const completer: Completer = {
    complete(source: string, cursor: number) {
      calls.push({ source, cursor });
      const from = source.slice(0, cursor).search(/\w*$/);
      return { from, to: cursor, items: [], annotation: null };
    },
  };
  return { calls, completer };
}

describe("prepending", () => {
  it("completes a whole query with the definitions before it", () => {
    const { calls, completer } = recording();
    const found = prepending(
      completer,
      () => "#track.year = album.year",
    ).complete("#track $ye", 10);
    expect(calls).toEqual([
      { source: "#track.year = album.year\n#track $ye", cursor: 35 },
    ]);
    // Back in the editor's own text: `ye`, after the `$`.
    expect(found).toMatchObject({ from: 8, to: 10 });
  });

  it("passes the text through alone when there are no definitions", () => {
    const { calls, completer } = recording();
    const found = prepending(completer, () => "").complete("#tr", 3);
    expect(calls).toEqual([{ source: "#tr", cursor: 3 }]);
    expect(found).toMatchObject({ from: 1, to: 3 });
  });
});
