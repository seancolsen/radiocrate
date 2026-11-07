// What the user has customized about a table's fields in the record editor —
// `metadata.field` in the database — and the arithmetic behind it. Pure, like the
// rest of `query/`: the app store holds this, and the form renders through it.
//
// A field with no row behaves as it does in a database that has never been
// customized: visible, and in its default place. A row can also name a field that
// no longer exists, which nothing here ever asks about.

import type { FieldMetadataRow, FieldOrder, FieldRef } from "api-client";
import { dropPositions } from "./playlistEntries";
import { fieldRef, type FormField } from "./recordForm";

/** What's customized about one field. */
export interface FieldMetadata {
  visible: boolean;
  /** The field's sort key, or null until its table's fields are rearranged. */
  order: number | null;
}

/** A table's customized fields, by {@link fieldRefKey}. */
export type TableMetadata = Readonly<Record<string, FieldMetadata>>;

/** Every table's customized fields, by table name. */
export type MetadataByTable = Readonly<Record<string, TableMetadata>>;

/** The metadata of a table with none — one shared object, so a selector falling
 * back to it returns the same reference every time. */
export const NO_TABLE_METADATA: TableMetadata = {};

/** A field's identity as one string, for looking it up in a {@link TableMetadata}.
 * Two different fields never share one, whatever their columns are named: the
 * length of the array tells a column from a link, and JSON keeps the parts apart. */
export function fieldRefKey(field: FieldRef): string {
  return JSON.stringify(
    "columnName" in field
      ? [field.columnName]
      : [field.multiLink.relatedTableName, field.multiLink.fkColumnName],
  );
}

/** The rows `metadata.field.list` returns, keyed for lookup. */
export function groupFieldMetadata(
  rows: readonly FieldMetadataRow[],
): MetadataByTable {
  const tables: Record<string, Record<string, FieldMetadata>> = {};
  for (const { tableName, field, visible, order } of rows) {
    (tables[tableName] ??= {})[fieldRefKey(field)] = { visible, order };
  }
  return tables;
}

export function isFieldHidden(
  metadata: TableMetadata,
  field: FieldRef,
): boolean {
  return metadata[fieldRefKey(field)]?.visible === false;
}

/** Whether any field of any table is hidden. */
export function anyFieldHidden(metadata: MetadataByTable): boolean {
  return Object.values(metadata).some((table) =>
    Object.values(table).some((field) => !field.visible),
  );
}

/** `items`, given in their default order, in the order the user has arranged them:
 * those with a sort key first, by that key, then those without, as they came. */
function byOrder<T>(
  items: readonly T[],
  refOf: (item: T) => FieldRef,
  metadata: TableMetadata,
): T[] {
  const rank = (item: T) =>
    metadata[fieldRefKey(refOf(item))]?.order ?? Infinity;
  // `sort` is stable, which is what keeps the rest in their default order. Not
  // a subtraction, because two infinities subtract to NaN.
  return [...items].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** `fields`, given in their default order, in the order the user has arranged
 * them. A field the table gained after being arranged lands at the end. */
export function orderFields<F extends FormField>(
  fields: readonly F[],
  metadata: TableMetadata,
): F[] {
  return byOrder(fields, fieldRef, metadata);
}

/** The fields a form shows, in the order it shows them. */
export function arrangeFields<F extends FormField>(
  fields: readonly F[],
  metadata: TableMetadata,
  showHidden: boolean,
): F[] {
  return orderFields(
    showHidden
      ? fields
      : fields.filter((field) => !isFieldHidden(metadata, fieldRef(field))),
    metadata,
  );
}

/** The sort keys that put field `moved` between the fields shown just above and
 * just below where it was dropped, either of which is `undefined` at an edge.
 * `refs` is all of the table's fields in their default order, and empty is what
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
  refs: readonly FieldRef[],
  metadata: TableMetadata,
  moved: FieldRef,
  above: FieldRef | undefined,
  below: FieldRef | undefined,
): FieldOrder[] {
  const current = byOrder(refs, (ref) => ref, metadata);
  const indexOf = (list: readonly FieldRef[], ref: FieldRef) =>
    list.findIndex((other) => fieldRefKey(other) === fieldRefKey(ref));
  const from = indexOf(current, moved);
  if (from < 0) return [];
  const rest = current.filter((_, i) => i !== from);
  const at =
    above !== undefined
      ? indexOf(rest, above) + 1
      : below !== undefined
        ? indexOf(rest, below)
        : -1;
  // A neighbor the table no longer has leaves nothing to go by: the index is -1,
  // or 0 once `above` has added its 1.
  if (at < 0 || (above !== undefined && at === 0)) return [];
  if (at === from) return [];

  const orderOf = (ref: FieldRef | undefined) =>
    ref === undefined
      ? undefined
      : (metadata[fieldRefKey(ref)]?.order ?? undefined);
  if (current.every((ref) => orderOf(ref) !== undefined)) {
    const fit = dropPositions(orderOf(rest[at - 1]), orderOf(rest[at]), 1);
    if (fit) return [{ field: moved, order: fit[0] }];
  }
  const next = [...rest.slice(0, at), moved, ...rest.slice(at)];
  return next.flatMap((field, i) =>
    orderOf(field) === i + 1 ? [] : [{ field, order: i + 1 }],
  );
}
