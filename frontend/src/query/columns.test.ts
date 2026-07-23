import { describe, expect, it } from "vitest";
import { columnMetadataFromAnnotation, defaultColumnMetadata } from "./columns";
import type { AnnotationValue } from "querydown-js";

// Mirrors the Rust unit tests in `frontend-old-egui/src/columns.rs`.

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
