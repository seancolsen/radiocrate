import { describe, expect, it } from "vitest";
import { lineColumn, nextShown, type QueryDiagnostic } from "./diagnostics";
import {
  fromSource,
  joinMapped,
  locate,
  trimMapped,
  type SourceOrigin,
} from "./sourceMap";

const FILTER: SourceOrigin = { kind: "custom", section: "filter" };
const PRESET: SourceOrigin = { kind: "preset", id: "p", section: "filter" };

describe("a mapped text", () => {
  const text = joinMapped(
    [
      "track{",
      trimMapped(fromSource("  a:1 ", FILTER)),
      trimMapped(fromSource("b:2", PRESET)),
      "}",
    ],
    "\n",
  );

  it("joins and trims as strings do", () => {
    expect(text.text).toBe("track{\na:1\nb:2\n}");
  });

  it("maps a position back into the editor's own text", () => {
    const at = locate(text, text.text.indexOf("1"));
    expect(at?.segment.origin).toBe(FILTER);
    expect(at?.offset).toBe(4);
  });

  it("maps the position just past a stretch to that stretch's end", () => {
    const at = locate(text, text.text.indexOf("b:2") + 3);
    expect(at?.segment.origin).toBe(PRESET);
    expect(at?.offset).toBe(3);
  });

  it("puts generated text down to the stretch before it", () => {
    const at = locate(text, text.text.length - 1);
    expect(at?.segment.origin).toBe(PRESET);
    expect(at?.offset).toBe(3);
  });

  it("maps generated text before every stretch nowhere", () => {
    expect(locate(text, 0)).toBeUndefined();
  });
});

describe("nextShown", () => {
  const problem = (
    reason: string,
    kind: QueryDiagnostic["kind"] = "syntax",
  ): QueryDiagnostic => ({
    kind,
    reason,
    hint: null,
    origin: FILTER,
    source: "",
    range: null,
    notes: [],
  });

  it("clears a fixed problem at once", () => {
    expect(nextShown(problem("a"), null)).toEqual({
      show: null,
      settle: false,
    });
  });

  it("keeps the database's refusal through a fix to the text", () => {
    const refused = problem("a", "run");
    expect(nextShown(refused, null)).toEqual({ show: refused, settle: false });
  });

  it("follows the same problem at once", () => {
    const moved = problem("a");
    expect(nextShown(problem("a"), moved)).toEqual({
      show: moved,
      settle: false,
    });
  });

  it("holds a new problem back, keeping what's shown", () => {
    const shown = problem("a");
    expect(nextShown(shown, problem("b"))).toEqual({
      show: shown,
      settle: true,
    });
    expect(nextShown(null, problem("b"))).toEqual({ show: null, settle: true });
  });
});

describe("lineColumn", () => {
  it("counts from 1", () => {
    expect(lineColumn("ab\ncd", 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
    expect(lineColumn("ab\ncd", 5)).toEqual({ line: 2, column: 3 });
  });
});
