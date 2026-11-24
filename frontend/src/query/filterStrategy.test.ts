import { describe, expect, it } from "vitest";
import {
  basicTextToQuerydown,
  convertFilterText,
  filterQuerydown,
} from "./filterStrategy";

describe("basicTextToQuerydown", () => {
  it.each([
    ["foo", "foo"],
    ["foo bar", "foo bar"],
    ["can't go", `"can't" go`],
    [`"cool"`, `'"cool"'`],
    [`"it's cool"`, `^e"\\"it's" 'cool"'`],
  ])("%s → %s", (basic, querydown) => {
    expect(basicTextToQuerydown(basic)).toBe(querydown);
  });

  it("quotes what Querydown wouldn't read as a search term", () => {
    // A number, a letter outside ASCII, an underscore (a column name), an
    // operator, a negation, a path.
    expect(basicTextToQuerydown("1999 café in_progress a:b !x a.b")).toBe(
      `"1999" "café" "in_progress" "a:b" "!x" "a.b"`,
    );
  });

  it("keeps a backslash in an escaped string literal", () => {
    expect(basicTextToQuerydown(`a\\"b'`)).toBe(`^e"a\\\\\\"b'"`);
    expect(basicTextToQuerydown(`a\\b`)).toBe(`"a\\b"`);
  });

  it("splits on any run of whitespace and drops the ends", () => {
    expect(basicTextToQuerydown("  foo \n\t bar  ")).toBe("foo bar");
    expect(basicTextToQuerydown("   ")).toBe("");
  });
});

describe("filterQuerydown", () => {
  it("reads Querydown, or an absent strategy, as written", () => {
    expect(filterQuerydown("year:>2000", "querydown")).toBe("year:>2000");
    expect(filterQuerydown("year:>2000", undefined)).toBe("year:>2000");
    expect(filterQuerydown("year:>2000", "basic_text")).toBe(`"year:>2000"`);
  });
});

describe("convertFilterText", () => {
  it("turns basic text into the Querydown it stood for", () => {
    expect(convertFilterText("can't go", "basic_text", "querydown")).toBe(
      `"can't" go`,
    );
  });

  it("keeps Querydown's text as words", () => {
    expect(convertFilterText("year:>2000", "querydown", "basic_text")).toBe(
      "year:>2000",
    );
  });
});
