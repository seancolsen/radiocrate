// Names for the unsaved query tabs the app opens on the user's behalf — the
// records under a multi-record field, an artist's albums — so the tab bar says
// what the tab is for rather than "new".
//
// Pure functions of table names and field values, so the framework-free modules
// can use them.

import { pluralOrRaw } from "./entityNames";
import { keyConditions, valueTypeOf, type RecordKey } from "./recordForm";
import type { RecordQuery } from "./recordForm";
import type { SchemaTable } from "./schema";

/** The longest text that still reads as a description of a record. */
const MAX_DESCRIPTOR_LENGTH = 100;

/** A text column of a record, with the value it holds there. */
export interface DescriptorField {
  column: string;
  value: string | null;
}

/** Where a column ranks as a description of its record: a column called `name`,
 * then one called `title`, then any other text column. */
function rank(column: string): number {
  const lower = column.toLowerCase();
  return lower === "name" ? 0 : lower === "title" ? 1 : 2;
}

/** A short text that describes a record, taken from `fields` — its text
 * columns, in column order: the first non-empty value shorter than
 * {@link MAX_DESCRIPTOR_LENGTH}, trying `name`, then `title`, then the rest. */
export function recordDescriptor(
  fields: readonly DescriptorField[],
): string | undefined {
  const ranked = fields
    .map((field, i) => ({ field, i }))
    .sort((a, b) => rank(a.field.column) - rank(b.field.column) || a.i - b.i);
  for (const { field } of ranked) {
    const value = field.value?.trim() ?? "";
    if (value !== "" && value.length < MAX_DESCRIPTOR_LENGTH) return value;
  }
  return undefined;
}

/** The names of `table`'s text columns, in column order. */
export function textColumns(table: SchemaTable | undefined): string[] {
  return (
    table?.columns
      .filter((c) => valueTypeOf(c.type) === "text")
      .map((c) => c.name) ?? []
  );
}

/** A query for the text columns of one record, answering rows of
 * `textColumns(table)`'s cells. */
export function descriptorQuery(
  table: string,
  columns: readonly string[],
  key: RecordKey,
): RecordQuery {
  return {
    base: table,
    filter: keyConditions([key]),
    sort: "",
    display: columns.map((c) => `$${c}`).join(" "),
  };
}

/** The name of the tab listing the `childTable` records under a record:
 * "credits: When I'm Sixty Four", or just "credits" without a descriptor. */
export function childRecordsTabName(
  childTable: string,
  descriptor: string | undefined,
): string {
  const noun = pluralOrRaw(childTable);
  return descriptor ? `${noun}: ${descriptor}` : noun;
}

/** The name of the tab listing the `table` records related to a record:
 * "Pink Floyd: albums", or just "albums" without a descriptor. */
export function relatedRecordsTabName(
  table: string,
  descriptor: string | undefined,
): string {
  const noun = pluralOrRaw(table);
  return descriptor ? `${descriptor}: ${noun}` : noun;
}
