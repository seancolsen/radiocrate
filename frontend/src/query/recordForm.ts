// The record editor's *structure*: which fields a record's form has, and the
// Querydown that loads their data. Pure — schema in, field list and query text
// out — so it's unit-testable and holds no reactive or DOM state (the reactive
// model lives in `components/record/formModel.ts`).
//
// Everything here follows from introspection alone, per the spec's "Form
// structure": every column of the edited table becomes a field, and every table
// that references it becomes a field too.

import {
  identifyingColumns,
  inferLinks,
  primaryKey,
  type SchemaTable,
} from "./schema";

/** One column/value pair of a record's identity. A composite key (`credit` is
 * keyed on `(track, artist)`) carries one per column, in constraint order. */
export interface KeyPart {
  column: string;
  value: string;
}

/** The value category a column's data falls into — what picks a field label's
 * icon and color, and whether the value gets the expandable-text treatment.
 * Coarser than the SQL type on purpose: the form only distinguishes what it
 * renders differently. */
export type ValueType =
  "text" | "number" | "uuid" | "timestamp" | "boolean" | "other";

/** Fields common to every kind of form field. `key` identifies the field within
 * one record's form (a column name, or `#table` for a referencing field) and is
 * what expansion/edit state is keyed on. */
interface FieldBase {
  key: string;
  label: string;
}

/** A field backed by an ordinary column — text, number, timestamp, … */
export interface PrimitiveField extends FieldBase {
  kind: "primitive";
  column: string;
  valueType: ValueType;
  nullable: boolean;
}

/** A field backed by a foreign-key column, referencing one record in
 * `table`. Expanding it loads that record's own form (recursively). */
export interface ScalarLinkField extends FieldBase {
  kind: "scalarLink";
  column: string;
  /** The referenced table. */
  table: string;
  /** The column identifying a record there — `id`, by the FK convention. */
  keyColumn: string;
  nullable: boolean;
}

/** A field standing for the set of records in `table` that reference this one
 * through `column`. Expanding it lists them. */
export interface MultiRecordField extends FieldBase {
  kind: "multiRecord";
  /** The referencing table. */
  table: string;
  /** The column *there* that points back at the record being edited. */
  column: string;
  /** The columns identifying one record of `table` (empty when it has no unique
   * constraint at all — such a field can be counted but not listed). */
  keyColumns: readonly string[];
}

export type FormField = PrimitiveField | ScalarLinkField | MultiRecordField;

/** DuckDB type names, uppercased, grouped into {@link ValueType}s. Prefix
 * matching handles the parameterized spellings (`VARCHAR(20)`, `DECIMAL(4,2)`,
 * `TIMESTAMP WITH TIME ZONE`, `TIMESTAMP_S`, …). */
const TYPE_PREFIXES: readonly (readonly [string, ValueType])[] = [
  ["UUID", "uuid"],
  ["VARCHAR", "text"],
  ["CHAR", "text"],
  ["BPCHAR", "text"],
  ["TEXT", "text"],
  ["STRING", "text"],
  ["TIMESTAMP", "timestamp"],
  ["DATE", "timestamp"],
  ["TIME", "timestamp"],
  ["BOOL", "boolean"],
  ["TINYINT", "number"],
  ["SMALLINT", "number"],
  ["INTEGER", "number"],
  ["INT", "number"],
  ["BIGINT", "number"],
  ["HUGEINT", "number"],
  ["UTINYINT", "number"],
  ["USMALLINT", "number"],
  ["UINTEGER", "number"],
  ["UBIGINT", "number"],
  ["DECIMAL", "number"],
  ["NUMERIC", "number"],
  ["REAL", "number"],
  ["FLOAT", "number"],
  ["DOUBLE", "number"],
];

/** The value category of a column type. An unrecognized type (a user-defined
 * ENUM comes through under its own name) reads as "other": displayed as one
 * truncated line, like every non-text value. */
export function valueTypeOf(type: string | undefined): ValueType {
  const upper = (type ?? "").trim().toUpperCase();
  for (const [prefix, value] of TYPE_PREFIXES) {
    if (upper.startsWith(prefix)) return value;
  }
  return "other";
}

/** The fields of `tableName`'s form, in the spec's order: the table's own
 * columns as introspection gives them, then one field per referencing table,
 * alphabetically.
 *
 * `hidden` drops columns from the form — the contextual filter of a record
 * reached *through* a multi-record field (every credit listed under a track has
 * the same `track`, so that field is noise). It only hides the field; the column
 * still identifies the record for loading.
 *
 * Returns `[]` for a table the schema doesn't have. */
export function buildFormFields(
  tables: readonly SchemaTable[],
  tableName: string,
  hidden: readonly string[] = [],
): FormField[] {
  const table = tables.find((t) => t.name === tableName);
  if (!table) return [];
  const links = inferLinks(tables);
  const byName = new Map(tables.map((t) => [t.name, t]));

  const fields: FormField[] = [];
  for (const column of table.columns) {
    if (hidden.includes(column.name)) continue;
    const link = links.find(
      (l) => l.fromTable === tableName && l.fromColumn === column.name,
    );
    const target = link && byName.get(link.toTable);
    if (link && target) {
      fields.push({
        kind: "scalarLink",
        key: column.name,
        label: column.name,
        column: column.name,
        table: link.toTable,
        keyColumn: primaryKey(target) ?? "id",
        nullable: column.nullable,
      });
    } else {
      fields.push({
        kind: "primitive",
        key: column.name,
        label: column.name,
        column: column.name,
        valueType: valueTypeOf(column.type),
        nullable: column.nullable,
      });
    }
  }

  const referencing = links
    .filter((l) => l.toTable === tableName && l.fromTable !== tableName)
    .sort((a, b) => a.fromTable.localeCompare(b.fromTable));
  for (const link of referencing) {
    const child = byName.get(link.fromTable);
    if (!child) continue;
    fields.push({
      kind: "multiRecord",
      key: `#${link.fromTable}`,
      label: link.fromTable,
      table: link.fromTable,
      column: link.fromColumn,
      keyColumns: identifyingColumns(child),
    });
  }
  return fields;
}

/** A Querydown query in the four parts `compile_sections` takes (the record
 * editor writes no `definitions` — it queries real columns only). */
export interface RecordQuery {
  base: string;
  filter: string;
  sort: string;
  display: string;
}

/** A value as a Querydown string literal. Backslashes and quotes are escaped;
 * the compiler emits a properly quoted SQL literal from it. */
export function quoteValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Querydown conditions matching exactly the record `key` identifies. `:=` is
 * the exact-equality operator — plain `:` would compile to a substring match on
 * a text column. */
export function keyConditions(key: readonly KeyPart[]): string {
  return key.map((p) => `${p.column}:=${quoteValue(p.value)}`).join("\n");
}

/** The display expression loading one field: the column's value, or — for a
 * referencing field — the count of related records, which is all the collapsed
 * form shows and all the initial load fetches. */
function displayExpr(field: FormField): string {
  return field.kind === "multiRecord" ? `$#${field.table}` : `$${field.column}`;
}

/** The query loading one record's own data: every intrinsic field's value plus
 * every referencing field's record count, for the single record `key`
 * identifies. Nested data is left to expansion.
 *
 * The result's columns are positional — one per entry of `fields`, in order. */
export function recordDataQuery(
  table: string,
  fields: readonly FormField[],
  key: readonly KeyPart[],
): RecordQuery {
  return {
    base: table,
    filter: keyConditions(key),
    sort: "",
    display: fields.map(displayExpr).join(" "),
  };
}

/** The query listing the records behind a multi-record field: the identifying
 * columns of every record of `field.table` whose `field.column` points at the
 * record `parent` identifies.
 *
 * Only the keys — this session renders a child as its primary key in plain text
 * rather than as an embedded record, and expanding one loads the rest. Ordered
 * by that key, so the list is stable across refreshes.
 *
 * The result's columns are positional — one per entry of `field.keyColumns`. */
export function childRecordsQuery(
  field: MultiRecordField,
  parent: string,
): RecordQuery {
  return {
    base: field.table,
    filter: `${field.column}:=${quoteValue(parent)}`,
    // Two literal backslashes: Querydown's sort marker.
    sort: field.keyColumns.map((c) => `\\\\${c}`).join(" "),
    display: field.keyColumns.map((c) => `$${c}`).join(" "),
  };
}
