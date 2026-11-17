import { describe, expect, it } from "vitest";
import {
  compileFind,
  DEFAULT_FIND_OPTIONS,
  hasMatch,
  matchRanges,
  parseFindOptions,
  replaceMatches,
  splitByMatches,
  type FindOptions,
} from "./findReplace";

const opts = (o: Partial<FindOptions> = {}): FindOptions => ({
  ...DEFAULT_FIND_OPTIONS,
  ...o,
});

/** Compiles, insisting it worked. */
function finder(find: string, o: Partial<FindOptions> = {}) {
  const f = compileFind(find, opts(o));
  if (f === null || "error" in f) throw new Error(`no pattern for ${find}`);
  return f;
}

describe("compileFind", () => {
  it("finds nothing for nothing typed", () => {
    expect(compileFind("", opts())).toBeNull();
  });

  it("takes plain text literally, ignoring case by default", () => {
    const f = finder("a.b (c)");
    expect(replaceMatches("A.B (C) axb (c)", f, "x")).toBe("x axb (c)");
    // Including a replacement that looks like a capture reference.
    expect(replaceMatches("a.b (c)", f, "$&$1")).toBe("$&$1");
  });

  it("matches case when asked", () => {
    const f = finder("you", { matchCase: true });
    expect(matchRanges("You you YOU", f.pattern)).toEqual([
      { start: 4, end: 7 },
    ]);
  });

  it("matches whole words only when asked, in any script", () => {
    const f = finder("you", { wholeWord: true });
    expect(replaceMatches("You, Yourself, you_ you", f, "U")).toBe(
      "U, Yourself, you_ U",
    );
    const e = finder("cafe", { wholeWord: true });
    expect(hasMatch("cafeé", e.pattern)).toBe(false);
    expect(hasMatch("le cafe", e.pattern)).toBe(true);
  });

  it("reads a regular expression, whose replacement names its captures", () => {
    const f = finder(String.raw`(\w+) \(feat\. (.+)\)`, { regex: true });
    expect(replaceMatches("Freedom (feat. Kendrick Lamar)", f, "$1 [$2]")).toBe(
      "Freedom [Kendrick Lamar]",
    );
  });

  it("applies whole word around a whole alternation", () => {
    const f = finder("a|b", { regex: true, wholeWord: true });
    expect(replaceMatches("a ab b", f, "x")).toBe("x ab x");
  });

  it("says why a regular expression doesn't parse", () => {
    const f = compileFind("(", opts({ regex: true }));
    expect(f).toEqual({ error: expect.any(String) });
    if (f && "error" in f) expect(f.error).not.toMatch(/^Invalid regular/);
  });
});

describe("matchRanges", () => {
  it("leaves out matches of no characters", () => {
    const f = finder("^|o", { regex: true });
    expect(matchRanges("Hold Up", f.pattern)).toEqual([{ start: 1, end: 2 }]);
    // …which still count as matches, since replacing one changes the text.
    expect(hasMatch("Up", f.pattern)).toBe(true);
    expect(replaceMatches("Up", f, ">")).toBe(">Up");
  });
});

describe("splitByMatches", () => {
  it("marks the matched runs among the rest", () => {
    expect(
      splitByMatches("Pray You Catch Me", [
        { start: 0, end: 4 },
        { start: 9, end: 14 },
      ]),
    ).toEqual([
      { start: 0, text: "Pray", matched: true },
      { start: 4, text: " You ", matched: false },
      { start: 9, text: "Catch", matched: true },
      { start: 14, text: " Me", matched: false },
    ]);
  });
});

describe("parseFindOptions", () => {
  it("reads what was stored, defaulting anything missing or unreadable", () => {
    expect(parseFindOptions(null)).toEqual(DEFAULT_FIND_OPTIONS);
    expect(parseFindOptions("{")).toEqual(DEFAULT_FIND_OPTIONS);
    expect(parseFindOptions('{"regex":true,"matchCase":"yes"}')).toEqual({
      matchCase: false,
      wholeWord: false,
      regex: true,
    });
  });
});
