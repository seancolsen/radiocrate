import { describe, expect, it } from "vitest";
import * as arrow from "apache-arrow";
import type { AnnotationValue } from "querydown-js";
import { defaultColumnMetadata } from "./columns";
import { hasFormatting, resultToCsv } from "./exportCsv";
import { buildResultFromArrow } from "./result";

function listColumn(rows: (string[] | null)[]): arrow.Vector {
  const type = new arrow.List(
    arrow.Field.new({ name: "item", type: new arrow.Utf8(), nullable: true }),
  );
  const b = arrow.makeBuilder({ type, nullValues: [null] });
  for (const r of rows) b.append(r as unknown as arrow.Vector<arrow.Utf8>);
  return b.finish().toVector();
}

describe("resultToCsv", () => {
  const table = new arrow.Table({
    id: arrow.vectorFromArray(["t1", "t2", "t3"], new arrow.Utf8()),
    title: arrow.vectorFromArray(
      ["Hold Up", 'Say "Hi"\tthere', null],
      new arrow.Utf8(),
    ),
    artists: listColumn([["Beyoncé"], ["Beyoncé", "Jack White"], null]),
    duration: arrow.vectorFromArray(["221", "234", "60"], new arrow.Utf8()),
  });
  const annotations: (AnnotationValue | null)[] = [
    { hide: "yes" },
    null,
    null,
    { formatter: { type: "duration" }, suffix: " min" },
  ];
  const result = buildResultFromArrow(table, annotations);

  it("writes every visible column's display text, tab-separated", () => {
    expect(resultToCsv(result).split("\n")[0]).toBe(
      "Hold Up\tBeyoncé\t3:41 min",
    );
  });

  it("joins a list cell's values with a comma and space, and quotes a field holding a tab or a quote", () => {
    expect(resultToCsv(result, { rows: [1] })).toBe(
      '"Say ""Hi""\tthere"\tBeyoncé, Jack White\t3:54 min',
    );
  });

  it("writes a NULL as an empty field", () => {
    expect(resultToCsv(result, { rows: [2] })).toBe("\t\t1:00 min");
  });

  it("separates records with a bare newline, with none after the last", () => {
    expect(resultToCsv(result).split("\n")).toHaveLength(3);
    expect(resultToCsv(result)).not.toMatch(/\r|\n$/);
  });

  it("writes only the given rows, in display order", () => {
    expect(resultToCsv(result, { rows: [2, 0, 0, 7] })).toBe(
      "Hold Up\tBeyoncé\t3:41 min\n\t\t1:00 min",
    );
  });

  it("writes nothing for no rows", () => {
    expect(resultToCsv(result, { rows: [] })).toBe("");
  });

  it("leaves out the excluded columns", () => {
    expect(resultToCsv(result, { rows: [0], excluded: [2] })).toBe(
      "Hold Up\t3:41 min",
    );
  });

  it("writes a raw column without its formatter, prefix or suffix", () => {
    expect(resultToCsv(result, { rows: [0], raw: [3] })).toBe(
      "Hold Up\tBeyoncé\t221",
    );
  });
});

describe("hasFormatting", () => {
  it("is true of a formatter, a prefix or a suffix, and nothing else", () => {
    const plain = defaultColumnMetadata();
    expect(hasFormatting(plain)).toBe(false);
    expect(hasFormatting({ ...plain, prefix: "#" })).toBe(true);
    expect(hasFormatting({ ...plain, suffix: " min" })).toBe(true);
    expect(hasFormatting({ ...plain, formatter: { type: "duration" } })).toBe(
      true,
    );
  });
});
