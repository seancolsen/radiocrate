// The Data structure page's tree: the ids its items go by, and what it lists
// under a table. Pure, like the rest of `query/` — the app store holds which
// items are open, and the page renders through these.
//
// The tree, with each item's id:
//
//   Tables                      tables
//     <table>                   table:<name>
//       Fields                  table:<name>/fields
//         <field>               table:<name>/fields/<fieldRefKey>
//       Query settings          table:<name>/query
//         Filter presets        table:<name>/query/filter
//           <preset>            preset:<id>
//         Sorting presets       table:<name>/query/sort
//         Display presets       table:<name>/query/display
//   Querydown prelude           prelude
//
// An id is only ever compared whole, never taken apart, so a table named with a
// `/` or a `:` in it is as good as any other.

import type { ColumnSummary, FieldRef, TableSummary } from "api-client";
import type { ContextualQuery } from "./contextualQuery";
import { contextFields } from "./contextualQuery";
import type { Section } from "./definition";
import { fieldRefKey, orderFields, type TableMetadata } from "./fieldMetadata";
import { hasQueryEditor } from "./fieldQuery";
import { buildFormFields, type FormField } from "./recordForm";
import type { SchemaTable } from "./schema";

/** The "Tables" item, at the top of the tree. */
export const TABLES_ITEM = "tables";

/** The "Querydown prelude" item, beside it. */
export const PRELUDE_ITEM = "prelude";

export const tableItemId = (table: string): string => `table:${table}`;

export const fieldsItemId = (table: string): string =>
  `${tableItemId(table)}/fields`;

export const structureFieldId = (table: string, field: FieldRef): string =>
  `${fieldsItemId(table)}/${fieldRefKey(field)}`;

export const querySettingsItemId = (table: string): string =>
  `${tableItemId(table)}/query`;

export const presetSectionItemId = (table: string, section: Section): string =>
  `${querySettingsItemId(table)}/${section}`;

export const presetItemId = (presetId: string): string => `preset:${presetId}`;

/** The items to open for `table`'s presets to be on show: all of them down to
 * `section`'s list, or down to "Query settings" without one. */
export function presetSectionPath(table: string, section?: Section): string[] {
  const path = [TABLES_ITEM, tableItemId(table), querySettingsItemId(table)];
  if (section !== undefined) path.push(presetSectionItemId(table, section));
  return path;
}

/** The items open in a tree nobody has opened or closed anything in: the list
 * of tables, each of them closed. */
export const DEFAULT_EXPANDED: readonly string[] = [TABLES_ITEM];

/** What kind of thing a field is, as the tree names it. */
export type StructureFieldKind = "column" | "related" | "query";

/** The small label each kind of field wears. */
export const FIELD_KIND_LABELS: Record<StructureFieldKind, string> = {
  column: "Column",
  related: "Related",
  query: "Query",
};

export function structureFieldKind(field: FormField): StructureFieldKind {
  if (field.kind === "multiRecord") return "related";
  if (field.kind === "contextQuery") return "query";
  return "column";
}

/** Every field of `table`'s record editor form, hidden ones included, in the
 * order the user has arranged them: its columns, the tables referring to it,
 * and its contextual queries. */
export function structureFields(
  tables: readonly SchemaTable[],
  table: string,
  queries: readonly ContextualQuery[],
  metadata: TableMetadata,
): FormField[] {
  const fields: FormField[] = [
    ...buildFormFields(tables, table),
    ...contextFields(tables, table, queries),
  ];
  return orderFields(fields, metadata);
}

/** Whether a field's row opens into anything: its query's editor, for a
 * contextual query or a related-records field. A column has none — a linked
 * one included, whose record's display is the record editor's to write. */
export function isFieldExpandable(field: FormField): boolean {
  return field.kind !== "scalarLink" && hasQueryEditor(field);
}

/** A count of things: "12,509 rows", "1 column". */
export const countLabel = (n: number, one: string, many: string): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A percentage with no more digits than it needs: whole, unless that would
 * round a few NULLs away to "0%" or call "100%" on a column that has values. */
function percent(value: number): string {
  const digits =
    (value > 0 && value < 1) || (value > 99 && value < 100) ? 2 : 0;
  return String(Number(value.toFixed(digits)));
}

/** A column's statistics: "45 distinct, 20% NULL". The distinct count is an
 * estimate, which on a large table can overshoot the rows there are to hold
 * distinct values — so it's held to that. A table with no rows has no share of
 * NULLs to report. */
export function columnStatsLabel(
  column: ColumnSummary,
  rowCount: number,
): string {
  const distinct = Math.min(column.approxUnique, rowCount);
  const parts = [`${distinct.toLocaleString("en-US")} distinct`];
  if (column.nullPercentage !== null) {
    parts.push(`${percent(column.nullPercentage)}% NULL`);
  }
  return parts.join(", ");
}

/** The summary of one table, by name. */
export function tableSummary(
  summaries: readonly TableSummary[],
  table: string,
): TableSummary | undefined {
  return summaries.find((t) => t.name === table);
}
