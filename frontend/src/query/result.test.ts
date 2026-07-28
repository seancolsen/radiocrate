import { describe, expect, it } from "vitest";
import * as arrow from "apache-arrow";
import type { AnnotationValue } from "querydown-js";
import { buildResultFromArrow } from "./result";

// Guards the full decode path against the two real-backend regressions: (1)
// annotations arriving as JS `Map`s (serde-wasm-bindgen), and (2) DuckDB list
// columns that apache-arrow can't classify by type. Builds a real Arrow table so
// the test exercises `getChildAt`/`.get()` exactly as production does.

function listColumn(rows: string[][]): arrow.Vector {
  const type = new arrow.List(
    arrow.Field.new({ name: "item", type: new arrow.Utf8(), nullable: true }),
  );
  const b = arrow.makeBuilder({ type, nullValues: [null] });
  // The List builder accepts a plain array at runtime; its typed value is a
  // Vector, so cast to satisfy the overload.
  for (const r of rows) b.append(r as unknown as arrow.Vector<arrow.Utf8>);
  return b.finish().toVector();
}

/** A Map-shaped annotation, mirroring what querydown-js actually returns. */
const mapAnno = (entries: [string, AnnotationValue][]): AnnotationValue =>
  new Map(entries) as unknown as AnnotationValue;

describe("buildResultFromArrow", () => {
  const table = new arrow.Table({
    id: arrow.vectorFromArray(["t1", "t2"], new arrow.Utf8()),
    artists: listColumn([["Beyoncé"], ["Beyoncé", "Jack White"]]),
    duration: arrow.vectorFromArray(["196", "234"], new arrow.Utf8()),
  });

  const annotations: (AnnotationValue | null)[] = [
    mapAnno([["hide", "yes"]]), // id: hidden
    null, // artists: no annotation → list detected from the value
    mapAnno([
      ["align", "right"],
      [
        "formatter",
        new Map([["type", "duration"]]) as unknown as AnnotationValue,
      ],
    ]),
  ];

  it("drops hidden columns and keeps the rest in order", () => {
    const result = buildResultFromArrow(table, annotations);
    expect(result.rowCount).toBe(2);
    // id (hide:"yes") is dropped; artists + duration remain.
    expect(result.columns).toHaveLength(2);
    expect(result.columns[0].isList).toBe(true);
    expect(result.columns[1].isList).toBe(false);
  });

  it("renders a list column as pill arrays (value-level fallback)", () => {
    const result = buildResultFromArrow(table, annotations);
    const artists = result.columns[0];
    expect(artists.isList).toBe(true);
    expect(artists.cells).toEqual([["Beyoncé"], ["Beyoncé", "Jack White"]]);
  });

  it("applies the formatter from a Map-shaped annotation", () => {
    const result = buildResultFromArrow(table, annotations);
    const duration = result.columns[1];
    expect(duration.meta.text_align).toBe("right");
    // 196s → 3:16, 234s → 3:54 (formatter resolved despite the Map annotation).
    expect(duration.cells).toEqual(["3:16", "3:54"]);
  });
});

describe("buildResultFromArrow with a Timestamp column", () => {
  it("feeds the relativeTime formatter a value it parses correctly (not off by 1000x)", () => {
    // Regression: apache-arrow normalizes every Timestamp* unit to epoch ms,
    // and a naive `String(value)` produced a raw ms digit string that
    // `format.ts`'s relative-time parser then misread as epoch *seconds* and
    // multiplied by 1000 again — landing tens of thousands of years off.
    const oneDayAgoMs = Math.floor(Date.now() / 1000) * 1000 - 86_400_000;
    const type = new arrow.TimestampSecond();
    const played = new arrow.Table({
      played_at: arrow.vectorFromArray([oneDayAgoMs], type),
    });
    const annotations: (AnnotationValue | null)[] = [
      mapAnno([
        [
          "formatter",
          new Map<string, unknown>([
            ["type", "relativeTime"],
            ["units", ["days"]],
          ]) as unknown as AnnotationValue,
        ],
      ]),
    ];
    const result = buildResultFromArrow(played, annotations);
    // Exact wording can land on either side of a day boundary depending on
    // the host's local timezone offset — what matters is that it's ~1 day,
    // not (as the bug produced) tens of thousands of years away.
    expect(result.columns[0].cells[0]).toMatch(/^[01] days? ago$/);
  });
});
