// What the user has customized about a table's fields in the record editor —
// `metadata.column` in the database — and the arithmetic behind it. Pure, like the
// rest of `query/`: the app store holds this, and the form renders through it.
//
// A field with no row behaves as it does in a database that has never been
// customized: visible, and in its default place. A row can also name a column
// that no longer exists, which nothing here ever asks about.

import type { ColumnMetadata, ColumnOrder } from "api-client";
import { dropPositions } from "./playlistEntries";

/** What's customized about one field. */
export interface FieldMetadata {
  visible: boolean;
  /** The field's sort key, or null until its table's fields are rearranged. */
  order: number | null;
}

/** A table's customized fields, by field key: a column name, or `#<table>` for a
 * field listing the records that reference this one. */
export type TableMetadata = Readonly<Record<string, FieldMetadata>>;

/** Every table's customized fields, by table name. */
export type MetadataByTable = Readonly<Record<string, TableMetadata>>;

/** The metadata of a table with none — one shared object, so a selector falling
 * back to it returns the same reference every time. */
export const NO_TABLE_METADATA: TableMetadata = {};

/** The rows `column_metadata.list` returns, keyed for lookup. */
export function groupColumnMetadata(
  rows: readonly ColumnMetadata[],
): MetadataByTable {
  const tables: Record<string, Record<string, FieldMetadata>> = {};
  for (const { table, column, visible, order } of rows) {
    (tables[table] ??= {})[column] = { visible, order };
  }
  return tables;
}

export function isFieldHidden(metadata: TableMetadata, key: string): boolean {
  return metadata[key]?.visible === false;
}

/** Whether any field of any table is hidden. */
export function anyFieldHidden(metadata: MetadataByTable): boolean {
  return Object.values(metadata).some((table) =>
    Object.values(table).some((field) => !field.visible),
  );
}

/** `fields`, given in their default order, in the order the user has arranged
 * them: those with a sort key first, by that key, then those without, as they
 * came. A field the table gained after being arranged lands at the end. */
export function orderFields<F extends { key: string }>(
  fields: readonly F[],
  metadata: TableMetadata,
): F[] {
  const rank = (field: F) => metadata[field.key]?.order ?? Infinity;
  // `sort` is stable, which is what keeps the rest in their default order. Not
  // a subtraction, because two infinities subtract to NaN.
  return [...fields].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** The fields a form shows, in the order it shows them. */
export function arrangeFields<F extends { key: string }>(
  fields: readonly F[],
  metadata: TableMetadata,
  showHidden: boolean,
): F[] {
  return orderFields(
    showHidden
      ? fields
      : fields.filter((field) => !isFieldHidden(metadata, field.key)),
    metadata,
  );
}

/** The sort keys that put field `moved` between the fields shown just above and
 * just below where it was dropped, either of which is `undefined` at an edge.
 * `keys` is all of the table's fields in their default order, and empty is what
 * comes back when `moved` would go nowhere.
 *
 * The form may be showing fewer fields than the table has, since hidden fields
 * and a nested record's contextual filter leave gaps. The field goes right beside
 * the neighbor it was dropped next to, ahead of anything hidden between the two.
 *
 * When every field already has a sort key, only `moved` needs a new one, between
 * those of the fields now on either side of it. Otherwise, or when those two are
 * too close for a value to fit between them, every field is resequenced to 1…n in
 * the new order, leaving out those already holding their new key. */
export function fieldMoveOrders(
  keys: readonly string[],
  metadata: TableMetadata,
  moved: string,
  above: string | undefined,
  below: string | undefined,
): ColumnOrder[] {
  const current = orderFields(
    keys.map((key) => ({ key })),
    metadata,
  ).map((field) => field.key);
  if (!current.includes(moved)) return [];
  const rest = current.filter((key) => key !== moved);
  const at =
    above !== undefined
      ? rest.indexOf(above) + 1
      : below !== undefined
        ? rest.indexOf(below)
        : -1;
  // A neighbor the table no longer has leaves nothing to go by: `indexOf` is -1,
  // or 0 once `above` has added its 1.
  if (at < 0 || (above !== undefined && at === 0)) return [];
  if (at === current.indexOf(moved)) return [];

  const orderOf = (key: string | undefined) =>
    key === undefined ? undefined : (metadata[key]?.order ?? undefined);
  if (current.every((key) => orderOf(key) !== undefined)) {
    const fit = dropPositions(orderOf(rest[at - 1]), orderOf(rest[at]), 1);
    if (fit) return [{ column: moved, order: fit[0] }];
  }
  const next = [...rest.slice(0, at), moved, ...rest.slice(at)];
  return next.flatMap((column, i) =>
    orderOf(column) === i + 1 ? [] : [{ column, order: i + 1 }],
  );
}
