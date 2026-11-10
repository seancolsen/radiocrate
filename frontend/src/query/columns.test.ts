import { describe, expect, it } from "vitest";
import { annotationOptions } from "querydown-codemirror";
import {
  ANNOTATION_SCHEMA,
  columnMetadataFromAnnotation,
  defaultColumnMetadata,
} from "./columns";
import { parseFormatter, RELATIVE_UNITS } from "./format";
import type { AnnotationValue } from "querydown-js";

const DEFAULT_MAX_WIDTH = 500;
const DEFAULT_MIN_WIDTH = 0;

const obj = (entries: Record<string, AnnotationValue>): AnnotationValue =>
  entries;

describe("columnMetadataFromAnnotation", () => {
  it("null yields defaults", () => {
    expect(columnMetadataFromAnnotation(null)).toEqual(defaultColumnMetadata());
  });

  it("non-object yields defaults", () => {
    expect(columnMetadataFromAnnotation("nonsense")).toEqual(
      defaultColumnMetadata(),
    );
  });

  it("parses all fields", () => {
    const m = columnMetadataFromAnnotation(
      obj({
        hide: "yes",
        color: "light",
        size: "small",
        align: "center",
        prefix: "$",
        suffix: " kg",
      }),
    );
    expect(m.hide).toBe(true);
    expect(m.font_color).toBe("light");
    expect(m.font_size).toBe("small");
    expect(m.text_align).toBe("center");
    expect(m.prefix).toBe("$");
    expect(m.suffix).toBe(" kg");
  });

  it("truncates at the end unless asked to at the start", () => {
    expect(defaultColumnMetadata().truncate).toBe("end");
    expect(
      columnMetadataFromAnnotation(obj({ truncate: "start" })).truncate,
    ).toBe("start");
    expect(
      columnMetadataFromAnnotation(obj({ truncate: "middle" })).truncate,
    ).toBe("end");
  });

  it("suffix can be a singular and a plural", () => {
    expect(
      columnMetadataFromAnnotation(obj({ suffix: [" play", " plays"] })).suffix,
    ).toEqual([" play", " plays"]);
    // As the compiler hands it over: inside a `Map`.
    expect(
      columnMetadataFromAnnotation(
        new Map([
          ["suffix", [" play", " plays"]],
        ]) as unknown as AnnotationValue,
      ).suffix,
    ).toEqual([" play", " plays"]);
  });

  it("any other suffix is none", () => {
    for (const suffix of [[" play"], ["a", "b", "c"], ["a", 1], 3]) {
      expect(columnMetadataFromAnnotation(obj({ suffix })).suffix).toBe("");
    }
  });

  it("hide only 'yes' hides", () => {
    expect(columnMetadataFromAnnotation(obj({ hide: "no" })).hide).toBe(false);
  });

  it("unknown enum values fall back to defaults", () => {
    const m = columnMetadataFromAnnotation(
      obj({ color: "rainbow", align: "justify" }),
    );
    expect(m.font_color).toBe("default");
    expect(m.text_align).toBe("left");
  });

  it("width plain number sets both bounds", () => {
    const m = columnMetadataFromAnnotation(obj({ width: 120 }));
    expect([m.min_width, m.max_width]).toEqual([120, 120]);
  });

  it("width single-element list keeps default max", () => {
    const m = columnMetadataFromAnnotation(obj({ width: [80] }));
    expect([m.min_width, m.max_width]).toEqual([80, DEFAULT_MAX_WIDTH]);
  });

  it("width two-element list sets both", () => {
    const m = columnMetadataFromAnnotation(obj({ width: [50, 300] }));
    expect([m.min_width, m.max_width]).toEqual([50, 300]);
  });

  it("width swaps when min exceeds max", () => {
    const m = columnMetadataFromAnnotation(obj({ width: [300, 50] }));
    expect([m.min_width, m.max_width]).toEqual([50, 300]);
  });

  it("width empty list uses defaults", () => {
    const m = columnMetadataFromAnnotation(obj({ width: [] }));
    expect([m.min_width, m.max_width]).toEqual([
      DEFAULT_MIN_WIDTH,
      DEFAULT_MAX_WIDTH,
    ]);
  });

  it("parses a formatter blob", () => {
    const m = columnMetadataFromAnnotation(
      obj({ formatter: obj({ type: "duration" }) }),
    );
    expect(m.formatter).toEqual({ type: "duration" });
  });

  it("unknown formatter type is ignored without disturbing other fields", () => {
    const m = columnMetadataFromAnnotation(
      obj({ align: "right", formatter: obj({ type: "bogus" }) }),
    );
    expect(m.formatter).toBeUndefined();
    expect(m.text_align).toBe("right");
  });

  // querydown-js (serde-wasm-bindgen) hands back objects as JS `Map`s, not plain
  // objects. Reading them by property access silently yields all-defaults — the
  // bug that made every real column render the same. Resolution must normalize
  // `Map`s (including the nested `formatter` blob).
  it("resolves Map-shaped annotations (serde-wasm-bindgen)", () => {
    const meta = new Map<string, AnnotationValue>([
      ["hide", "yes"],
      ["align", "right"],
      ["size", "small"],
      ["width", [40, 60]],
      ["prefix", "#"],
      [
        "formatter",
        new Map([["type", "duration"]]) as unknown as AnnotationValue,
      ],
    ]) as unknown as AnnotationValue;
    const m = columnMetadataFromAnnotation(meta);
    expect(m.hide).toBe(true);
    expect(m.text_align).toBe("right");
    expect(m.font_size).toBe("small");
    expect([m.min_width, m.max_width]).toEqual([40, 60]);
    expect(m.prefix).toBe("#");
    expect(m.formatter).toEqual({ type: "duration" });
  });
});

describe("ANNOTATION_SCHEMA", () => {
  /** What the editor offers at `path`, for a key or a value. */
  const offered = (path: (string | number)[], slot: "key" | "value") =>
    annotationOptions(ANNOTATION_SCHEMA, { path, slot, keys: [] }).map(
      (option) => option.label,
    );

  it("offers every key the metadata reads", () => {
    expect(offered([], "key").sort()).toEqual(
      [
        "align",
        "color",
        "formatter",
        "hide",
        "prefix",
        "size",
        "suffix",
        "truncate",
        "width",
      ].sort(),
    );
    expect(offered(["formatter"], "key").sort()).toEqual(
      ["decimalPlaces", "format", "type", "units"].sort(),
    );
  });

  it("offers only values the metadata takes", () => {
    const meta = (key: string, value: string) =>
      columnMetadataFromAnnotation(obj({ [key]: value }));
    expect(offered(["align"], "value")).toEqual(["left", "center", "right"]);
    for (const v of offered(["align"], "value")) {
      expect(meta("align", v).text_align).toBe(v);
    }
    expect(offered(["color"], "value")).toEqual(["default", "light"]);
    for (const v of offered(["color"], "value")) {
      expect(meta("color", v).font_color).toBe(v);
    }
    expect(offered(["size"], "value")).toEqual(["normal", "small"]);
    for (const v of offered(["size"], "value")) {
      expect(meta("size", v).font_size).toBe(v);
    }
    expect(offered(["truncate"], "value")).toEqual(["end", "start"]);
    for (const v of offered(["truncate"], "value")) {
      expect(meta("truncate", v).truncate).toBe(v);
    }
    expect(offered(["hide"], "value")).toEqual(["yes"]);
    expect(meta("hide", "yes").hide).toBe(true);
  });

  it("offers every formatter type, each of which parses", () => {
    const types = offered(["formatter", "type"], "value");
    expect(types).toEqual(["number", "duration", "timestamp", "relativeTime"]);
    for (const type of types) {
      expect(parseFormatter(obj({ type, format: "%Y" }))?.type).toBe(type);
    }
  });

  it("offers the relative-time units", () => {
    expect(offered(["formatter", "units", 0], "value")).toEqual([
      ...RELATIVE_UNITS,
    ]);
  });
});
