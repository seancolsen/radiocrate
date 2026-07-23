// The structured, render-ready result of a query. Computed once per run (§6) —
// never per resize or frame — since every row lives in the DOM and the layout is
// derived separately from the visible columns' widths.
//
// A `QueryResult` holds only the *visible* columns (hidden ones dropped), each
// with its resolved `ColumnMetadata`, a list-vs-scalar flag, and its per-row cell
// strings already run through `displayText` (formatter + prefix/suffix baked in).
// The field layout is NOT stored here — it depends on the live container width
// and is memoized in the renderer.

import type { Table } from "apache-arrow";
import type { AnnotationValue } from "querydown-js";
import { isListLikeValue, isListType, stringifyArrowValue } from "../api/query";
import { columnMetadataFromAnnotation, type ColumnMetadata } from "./columns";
import { displayText } from "./format";
import type { ColSize } from "./fieldLayout";

/** One visible result column: its metadata, whether it's a list (pill) column,
 * and its precomputed per-row cell strings. Scalar columns carry `string[]`; list
 * columns carry `string[][]` (the pill texts of each row). */
export interface ResultColumn {
  meta: ColumnMetadata;
  isList: boolean;
  /** Per-row cells: `string` per row for scalars, `string[]` per row for lists. */
  cells: readonly string[] | readonly (readonly string[])[];
}

/** A fully decoded, render-ready query result: the row count and the visible
 * columns (in order). */
export interface QueryResult {
  rowCount: number;
  columns: ResultColumn[];
}

/** The visible columns' width bounds, in order — the input to the field layout.
 * Derived, not stored, so callers memoize on `(colSizes, avail, gap)`. */
export function colSizesOf(result: QueryResult): ColSize[] {
  return result.columns.map((c) => ({
    min: c.meta.min_width,
    max: c.meta.max_width,
  }));
}

/** Builds a {@link QueryResult} from a decoded Arrow table plus the compiler's
 * positional `columnAnnotations`. Resolves each column's metadata, drops hidden
 * columns (reading Arrow by original index, so a hidden id column doesn't shift
 * the others), detects list columns from the Arrow type, and precomputes every
 * cell string once. */
export function buildResultFromArrow(
  table: Table,
  annotations: readonly (AnnotationValue | null)[],
): QueryResult {
  const fields = table.schema.fields;
  const rowCount = table.numRows;
  const columns: ResultColumn[] = [];

  for (let i = 0; i < fields.length; i++) {
    const meta = columnMetadataFromAnnotation(annotations[i] ?? null);
    if (meta.hide) continue;
    const vector = table.getChildAt(i);
    // Detect list columns from the Arrow type; fall back to inspecting the first
    // non-null value, since apache-arrow 18 can't classify some DuckDB list
    // types (see `isListType`). Without this, a list column decodes down the
    // scalar path and renders as bracketed text instead of pills.
    let isList = isListType(fields[i].type);
    if (!isList && vector) {
      for (let r = 0; r < rowCount; r++) {
        const v = vector.get(r);
        if (v != null) {
          isList = isListLikeValue(v);
          break;
        }
      }
    }

    if (isList) {
      const cells: string[][] = new Array<string[]>(rowCount);
      for (let r = 0; r < rowCount; r++) {
        const v = vector?.get(r);
        cells[r] =
          v == null
            ? []
            : Array.from(v as Iterable<unknown>, (e) =>
                displayText(meta, stringifyArrowValue(e)),
              );
      }
      columns.push({ meta, isList, cells });
    } else {
      const cells: string[] = new Array<string>(rowCount);
      for (let r = 0; r < rowCount; r++) {
        cells[r] = displayText(meta, stringifyArrowValue(vector?.get(r)));
      }
      columns.push({ meta, isList, cells });
    }
  }

  return { rowCount, columns };
}

/** One column's raw (pre-`displayText`) cell data for {@link buildResultFromCells}:
 * scalar columns give `string[]`, list columns give `string[][]`. */
export interface RawColumn {
  meta: ColumnMetadata;
  isList: boolean;
  raw: readonly string[] | readonly (readonly string[])[];
}

/** Builds a {@link QueryResult} from plain string cells (no Arrow) — the dev/test
 * seam's fixture path (§6). Applies `displayText` and drops hidden columns just
 * like {@link buildResultFromArrow}, so the seeded grid exercises the real
 * formatter/prefix/suffix logic. */
export function buildResultFromCells(
  rowCount: number,
  cols: readonly RawColumn[],
): QueryResult {
  const columns: ResultColumn[] = [];
  for (const c of cols) {
    if (c.meta.hide) continue;
    if (c.isList) {
      const raw = c.raw as readonly (readonly string[])[];
      columns.push({
        meta: c.meta,
        isList: true,
        cells: raw.map((items) => items.map((it) => displayText(c.meta, it))),
      });
    } else {
      const raw = c.raw as readonly string[];
      columns.push({
        meta: c.meta,
        isList: false,
        cells: raw.map((v) => displayText(c.meta, v)),
      });
    }
  }
  return { rowCount, columns };
}
