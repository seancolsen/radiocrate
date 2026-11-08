// What the user has customized about a table's fields in the record editor —
// `metadata.field` in the database — and the arithmetic behind it. Pure, like the
// rest of `query/`: the app store holds this, and the form renders through it.
//
// A field with no row behaves as it does in a database that has never been
// customized: visible, in its default place, with its embedded records as the form
// generates them. A row can also name a field that no longer exists, which nothing
// here ever asks about.

import type { FieldMetadataRow, FieldOrder, FieldRef } from "api-client";
import { dropPositions } from "./playlistEntries";
import { fieldRef, type FormField } from "./recordForm";

/** What's customized about one field. */
export interface FieldMetadata {
  visible: boolean;
  /** The field's sort key, or null until its table's fields are rearranged. */
  order: number | null;
  /** Querydown for the display section of the query behind the field's embedded
   * records, or null to go by what the form generates. */
  display: string | null;
  /** Querydown for that query's sorting section, likewise. */
  sorting: string | null;
}

/** The two parts of a field's embedded records the user can write Querydown for. */
export type EmbedSection = "display" | "sorting";

/** A field nothing has been customized about yet. */
export function defaultFieldMetadata(): FieldMetadata {
  return { visible: true, order: null, display: null, sorting: null };
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
 * length of the array tells a column from a link, a contextual query is an object
 * rather than an array, and JSON keeps the parts apart. */
export function fieldRefKey(field: FieldRef): string {
  if ("contextualQuery" in field) {
    return JSON.stringify({ contextualQuery: field.contextualQuery });
  }
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
  for (const { tableName, field, ...metadata } of rows) {
    (tables[tableName] ??= {})[fieldRefKey(field)] = metadata;
  }
  return tables;
}

/** One field whose embedded records no longer say what they said. */
export interface EmbedChange {
  table: string;
  /** The field, by {@link fieldRefKey}. */
  fieldKey: string;
}

/** The fields whose display or sorting differs between `previous` and `next`. A
 * table holding the same reference is passed over, which is nearly all of them,
 * since a write replaces only its own path. */
export function embedChanges(
  previous: MetadataByTable,
  next: MetadataByTable,
): EmbedChange[] {
  const changes: EmbedChange[] = [];
  for (const table of new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ])) {
    const [before, after] = [previous[table], next[table]];
    if (before === after) continue;
    for (const fieldKey of new Set([
      ...Object.keys(before ?? {}),
      ...Object.keys(after ?? {}),
    ])) {
      const [a, b] = [before?.[fieldKey], after?.[fieldKey]];
      if (
        (a?.display ?? null) !== (b?.display ?? null) ||
        (a?.sorting ?? null) !== (b?.sorting ?? null)
      ) {
        changes.push({ table, fieldKey });
      }
    }
  }
  return changes;
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

/** The sort keys that put field `added` at the end of its table's fields, `refs`
 * — where a field the user has just added belongs. It's given a key of its own
 * even where the default order would put it last already: a contextual query's
 * place by default follows its name, which the user can change.
 *
 * When every other field has a sort key, only `added` needs one, after the last
 * of them. Otherwise every field is resequenced to 1…n with `added` last, leaving
 * out those already holding their new key, as {@link fieldMoveOrders} does. */
export function appendFieldOrders(
  refs: readonly FieldRef[],
  metadata: TableMetadata,
  added: FieldRef,
): FieldOrder[] {
  const key = fieldRefKey(added);
  const others = byOrder(
    refs.filter((ref) => fieldRefKey(ref) !== key),
    (ref) => ref,
    metadata,
  );
  const orderOf = (ref: FieldRef) => metadata[fieldRefKey(ref)]?.order ?? null;
  const orders = others.map(orderOf);
  if (orders.every((order) => order !== null)) {
    const last = Math.max(0, ...(orders as number[]));
    const own = orderOf(added);
    return own !== null && own > last
      ? []
      : [{ field: added, order: last + 1 }];
  }
  return [...others, added].flatMap((field, i) =>
    orderOf(field) === i + 1 ? [] : [{ field, order: i + 1 }],
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
