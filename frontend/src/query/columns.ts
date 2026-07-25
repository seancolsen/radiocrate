// Per-column display metadata.
//
// Querydown lets the user attach arbitrary metadata to each result column. The
// compiler surfaces this as one `AnnotationValue` (or `null`) per output column
// (already a JS object — no JSON.parse). Here we normalize each blob into a
// resolved {@link ColumnMetadata} with every field concrete, so rendering never
// has to think about defaults.

import type { AnnotationValue } from "querydown-js";
import { parseFormatter, type Formatter } from "./format";

/** Default column min width, in pixels, when none is specified. */
const DEFAULT_MIN_WIDTH = 0;
/** Default column max width, in pixels, when none is specified. */
const DEFAULT_MAX_WIDTH = 500;

/** Whether a column's text uses the normal or a de-emphasized ("light") color. */
export type FontColor = "default" | "light";
/** Column text size. */
export type FontSize = "normal" | "small";
/** Horizontal alignment of a column's text within its cell. */
export type TextAlign = "left" | "right" | "center";

/** Fully-resolved display metadata for a single result column. Every field has a
 * concrete value (defaults already applied), so rendering can use it directly. */
export interface ColumnMetadata {
  hide: boolean;
  min_width: number;
  max_width: number;
  font_color: FontColor;
  font_size: FontSize;
  text_align: TextAlign;
  prefix: string;
  suffix: string;
  formatter: Formatter | undefined;
}

export function defaultColumnMetadata(): ColumnMetadata {
  return {
    hide: false,
    min_width: DEFAULT_MIN_WIDTH,
    max_width: DEFAULT_MAX_WIDTH,
    font_color: "default",
    font_size: "normal",
    text_align: "left",
    prefix: "",
    suffix: "",
    formatter: undefined,
  };
}

/** Recursively converts a raw annotation value into plain JS. `querydown-js`
 * (serde-wasm-bindgen) serializes Rust map-like `AnnotationValue::Object`s as JS
 * **`Map`s**, not plain objects — so reading `raw.width` by property access would
 * always be `undefined` and every column would fall back to defaults. Normalize
 * `Map`s (and nested ones, e.g. the `formatter` blob) to objects here so the rest
 * of the resolution reads them uniformly; plain objects (the fixture/test path)
 * pass through unchanged. */
function normalizeAnnotation(v: unknown): AnnotationValue | null {
  if (v instanceof Map) {
    const obj: Record<string, AnnotationValue> = {};
    for (const [k, val] of v as Map<unknown, unknown>) {
      obj[String(k)] = normalizeAnnotation(val) as AnnotationValue;
    }
    return obj;
  }
  if (Array.isArray(v)) {
    return v.map((x) => normalizeAnnotation(x) as AnnotationValue);
  }
  if (v !== null && typeof v === "object") {
    const obj: Record<string, AnnotationValue> = {};
    for (const [k, val] of Object.entries(v)) {
      obj[k] = normalizeAnnotation(val) as AnnotationValue;
    }
    return obj;
  }
  return (v ?? null) as AnnotationValue | null;
}

/** Reads a field as a string, or `undefined` when it is absent or not a string. */
function asString(v: AnnotationValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Resolves the `width` spec into a `[min, max]` pair: a plain number sets both
 * bounds equal; `[min]` keeps the default max; `[min, max]` sets both (extra
 * elements ignored); an empty list or absent falls back to the defaults. If the
 * resulting min exceeds the max, the two are swapped. */
function resolveWidth(spec: AnnotationValue | undefined): [number, number] {
  let min: number;
  let max: number;
  if (typeof spec === "number") {
    min = spec;
    max = spec;
  } else if (Array.isArray(spec)) {
    const nums = spec.filter((x): x is number => typeof x === "number");
    if (nums.length === 0) {
      min = DEFAULT_MIN_WIDTH;
      max = DEFAULT_MAX_WIDTH;
    } else if (nums.length === 1) {
      min = nums[0];
      max = DEFAULT_MAX_WIDTH;
    } else {
      min = nums[0];
      max = nums[1];
    }
  } else {
    min = DEFAULT_MIN_WIDTH;
    max = DEFAULT_MAX_WIDTH;
  }
  if (min > max) [min, max] = [max, min];
  return [min, max];
}

function resolveFontColor(v: string | undefined): FontColor {
  return v === "light" ? "light" : "default";
}

function resolveFontSize(v: string | undefined): FontSize {
  return v === "small" ? "small" : "normal";
}

function resolveTextAlign(v: string | undefined): TextAlign {
  if (v === "right") return "right";
  if (v === "center") return "center";
  return "left";
}

/** Normalizes one column's annotation blob (or its absence) into resolved
 * settings. A `null` blob, or any blob that isn't a JSON object, yields all
 * defaults. A malformed `formatter` sub-blob yields `undefined` without
 * discarding the rest of the metadata. Ports `ColumnMetadata::from_meta`. */
export function columnMetadataFromAnnotation(
  meta: AnnotationValue | null,
): ColumnMetadata {
  const normalized = normalizeAnnotation(meta);
  if (
    normalized === null ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    return defaultColumnMetadata();
  }
  const raw = normalized;
  const [minWidth, maxWidth] = resolveWidth(raw.width);
  return {
    hide: asString(raw.hide) === "yes",
    min_width: minWidth,
    max_width: maxWidth,
    font_color: resolveFontColor(asString(raw.color)),
    font_size: resolveFontSize(asString(raw.size)),
    text_align: resolveTextAlign(asString(raw.align)),
    prefix: asString(raw.prefix) ?? "",
    suffix: asString(raw.suffix) ?? "",
    formatter: parseFormatter(raw.formatter),
  };
}
