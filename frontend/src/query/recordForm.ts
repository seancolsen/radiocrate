// The record editor's *structure*: which fields a record's form has, and the
// Querydown that loads their data. Pure — schema in, field list and query text
// out — so it's unit-testable and holds no reactive or DOM state (the reactive
// model lives in `components/record/formModel.ts`).
//
// Everything here follows from introspection alone, per the spec's "Form
// structure": every column of the edited table becomes a field, and every table
// that references it becomes a field too.

import type { FieldRef } from "api-client";
import { pluralOrRaw } from "./entityNames";
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

/** One record's identity, whole. The form deals in *sets* of these — the record
 * editor is always on some number of records, one being the ordinary case — and
 * every key in such a set names the same columns in the same order, since they
 * are all records of the same table. */
export type RecordKey = readonly KeyPart[];

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
  /** Whether this column is the table's primary key — issued by the database,
   * not the user, so the form never lets it be edited. */
  readOnly: boolean;
  /** Whether a single-column UNIQUE constraint keeps each record's value to
   * itself — which rules out offering it another record's. */
  unique: boolean;
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

/** A field standing for a contextual query (`query/contextualQuery.ts`): the
 * records a query the user wrote finds for this record, through `@id`. Not built
 * from the schema like the others but from the queries written for the record's
 * table, and it has no column behind it — the form adds it to a record's fields
 * (see `contextFields`), and loading the record's own data passes it by. */
export interface ContextQueryField extends FieldBase {
  kind: "contextQuery";
  /** The `contextual_query` row's id. */
  queryId: string;
  /** The table the query lists. */
  table: string;
  /** The columns identifying one of its records. */
  keyColumns: readonly string[];
}

export type FormField =
  PrimitiveField | ScalarLinkField | MultiRecordField | ContextQueryField;

/** The fields holding a record's own data — every one but a contextual query,
 * which the record's load knows nothing about. */
export type DataField = Exclude<FormField, ContextQueryField>;

/** Whether `field` holds the record's own data (see {@link DataField}). */
export function isDataField(field: FormField): field is DataField {
  return field.kind !== "contextQuery";
}

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
 * still identifies the record for loading. The fields the *user* has hidden and
 * rearranged are a matter of how the form renders these, not of which there are
 * (`fieldMetadata.ts`).
 *
 * Returns `[]` for a table the schema doesn't have. */
export function buildFormFields(
  tables: readonly SchemaTable[],
  tableName: string,
  hidden: readonly string[] = [],
): DataField[] {
  const table = tables.find((t) => t.name === tableName);
  if (!table) return [];
  const links = inferLinks(tables);
  const byName = new Map(tables.map((t) => [t.name, t]));
  const pk = primaryKey(table);

  const fields: DataField[] = [];
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
        readOnly: column.name === pk,
        unique: table.uniqueConstraints.some(
          (cols) => cols.length === 1 && cols[0] === column.name,
        ),
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
      label: pluralOrRaw(link.fromTable),
      table: link.fromTable,
      column: link.fromColumn,
      keyColumns: identifyingColumns(child),
    });
  }
  return fields;
}

/** Which field `field` is, in the terms the database stores what's customized about
 * it (`fieldMetadata.ts`). Unlike `key`, which only has to tell a form's fields
 * apart, this says what the field stands for. */
export function fieldRef(field: FormField): FieldRef {
  switch (field.kind) {
    case "multiRecord":
      return {
        multiLink: {
          relatedTableName: field.table,
          fkColumnName: field.column,
        },
      };
    case "contextQuery":
      return { contextualQuery: field.queryId };
    default:
      return { columnName: field.column };
  }
}

/** A Querydown query in the four parts `compile_sections` takes. The record
 * editor's own queries write no `definitions` — they query real columns only — but
 * a contextual query runs under the user's prelude, with `@id` defined. */
export interface RecordQuery {
  base: string;
  filter: string;
  sort: string;
  display: string;
  definitions?: string;
}

/** A value as a Querydown string literal. Backslashes and quotes are escaped;
 * the compiler emits a properly quoted SQL literal from it. */
export function quoteValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Querydown conditions matching exactly the records `keys` identifies. `:=` is
 * the exact-equality operator — plain `:` would compile to a substring match on
 * a text column.
 *
 * The columns of one key are AND-ed, as newline-separated conditions always
 * are. Several keys are OR-ed: `[…]` encloses alternatives, and each key's
 * conditions go in a `{…}` group of their own so that a composite key stays one
 * alternative rather than dissolving into the OR.
 *
 * ```
 * [
 *   {
 *     track:="t1"
 *     artist:="a1"
 *   }
 *   {
 *     track:="t2"
 *     artist:="a2"
 *   }
 * ]
 * ```
 */
export function keyConditions(keys: readonly RecordKey[]): string {
  const conditions = (key: RecordKey) =>
    key.map((p) => `${p.column}:=${quoteValue(p.value)}`);
  // One record needs no alternatives, and reads better without them.
  if (keys.length <= 1) return conditions(keys[0] ?? []).join("\n");
  const groups = keys.map(
    (key) =>
      `  {\n${conditions(key)
        .map((c) => `    ${c}`)
        .join("\n")}\n  }`,
  );
  return `[\n${groups.join("\n")}\n]`;
}

/** Querydown conditions matching every record whose `column` points at one of
 * `values` — the children of all the records the form is on, in one query.
 *
 * Bare conditions inside `[…]` are alternatives, which is exactly what's wanted
 * here: unlike a composite key, one condition is one whole alternative, so no
 * `{…}` groups are needed.
 *
 * ```
 * [
 *   track:="t1"
 *   track:="t2"
 * ]
 * ```
 *
 * One value needs no alternatives, and reads better without them. */
export function linkConditions(
  column: string,
  values: readonly string[],
): string {
  const conditions = values.map((v) => `${column}:=${quoteValue(v)}`);
  if (conditions.length <= 1) return conditions[0] ?? "";
  return `[\n${conditions.map((c) => `  ${c}`).join("\n")}\n]`;
}

/** A record's key values as one string, so a row of {@link recordDataQuery} can
 * be matched back to the record it belongs to. */
export function keySignature(values: readonly (string | null)[]): string {
  return JSON.stringify(values);
}

/** The display expression loading one field: the column's value, or — for a
 * referencing field — the count of related records, which is all the collapsed
 * form shows and all the initial load fetches. */
function displayExpr(field: DataField): string {
  return field.kind === "multiRecord" ? `$#${field.table}` : `$${field.column}`;
}

/** The query loading the data behind one node of the form: every intrinsic
 * field's value plus every referencing field's record count, for each of the
 * records `keys` identifies. Nested data is left to expansion.
 *
 * One query answers for every record — the rows come back in no particular
 * order, so the key columns are displayed ahead of the fields and each row is
 * matched to its record by them ({@link keySignature}). A key column that is a
 * field too is therefore displayed twice, which costs a duplicated column in the
 * SQL and keeps the offsets uniform.
 *
 * The result's columns are positional: the key columns first, then one per entry
 * of `fields`, in order. */
export function recordDataQuery(
  table: string,
  fields: readonly DataField[],
  keys: readonly RecordKey[],
): RecordQuery {
  const keyColumns = keys[0]?.map((p) => `$${p.column}`) ?? [];
  return {
    base: table,
    filter: keyConditions(keys),
    sort: "",
    display: [...keyColumns, ...fields.map(displayExpr)].join(" "),
  };
}

// The query listing the records behind a multi-record field lives in
// `embeddedRecord.ts`: it fetches each child's preview columns alongside its
// key, and which columns those are is that module's business.
