// The rows a multi-record field lists, out of the records it loaded.
//
// The record editor is always on a *set* of base records — one, ordinarily, and
// as many as the result-row selection holds. Under a multi-record field that
// means the children of every one of them come back in a single query, and two
// children that say exactly the same thing about different base records are, to
// someone editing both at once, one thing: a credit to "Beyoncé" at order 1 on
// each of two tracks is one row reading `(2) Beyoncé 1`, and editing it writes
// both records.
//
// So a row is a set of records compared on every column *except* the one tying
// each to its own base record — the only column they're allowed to differ on,
// and the one the child's own form hides anyway (spec: "Progressive expansion").
//
// For a single base record the grouping is an identity: two records of one
// parent must differ in some key column, every key column is compared here, and
// so each lands in a row of its own. The bulk case is therefore the same code
// path with more records arriving, not a mode — which is why the model has only
// one way of loading a list.
//
// Pure — rows in, rows out — so it's unit-testable without a store or a backend.

import type { RecordKey } from "../query/recordForm";

/** Where the parts of a `childRecordsQuery` row are, so this module can read one
 * without knowing how it was asked for. */
export interface ChildRowLayout {
  /** The columns identifying one record, which lead the row. */
  keyColumns: readonly string[];
  /** How many preview columns follow them. */
  previewWidth: number;
  /** Every column of the table, which follows the preview — what the records
   * are compared on. */
  columns: readonly string[];
  /** The one of those columns pointing back at the base record: what a row's
   * records may differ on, and the only thing they may differ on. */
  linkColumn: string;
}

/** One row of a multi-record field: the records it stands for, what it shows,
 * and which base record each of those records belongs to. */
export interface ChildGroup {
  /** One key per underlying record — what a save writes, and what a delete
   * deletes (all of them: the row is the record, however many rows carry it). */
  keys: readonly RecordKey[];
  /** The preview its embedded record shows, which every record it stands for
   * agrees on. Empty when the table has no preview columns; the caller falls
   * back to the key, as it does anywhere else a preview is missing. */
  cells: readonly (string | null)[];
  /** The linking column's value in each of those records, index-aligned to
   * {@link ChildGroup.keys}: which base record each one hangs off. What keeps a
   * field's per-record counts honest as rows come and go. */
  links: readonly (string | null)[];
}

/** One row's mutable form while it's being filled in. */
interface Building {
  keys: RecordKey[];
  cells: readonly (string | null)[];
  links: (string | null)[];
}

/** Collapses the records of a multi-record field into the rows the form lists,
 * in the order the query returned them — the sort the field is listed by, with
 * each row taking the place of the first of its records.
 *
 * A row's records are those agreeing on every column but `linkColumn`. NULL is
 * compared as itself throughout: a record with no role is not a record whose
 * role is the empty string. */
export function groupChildRows(
  rows: readonly (readonly (string | null)[])[],
  layout: ChildRowLayout,
): ChildGroup[] {
  const { keyColumns, previewWidth, columns, linkColumn } = layout;
  /** Where `columns` starts: after the keys and the preview. */
  const at = keyColumns.length + previewWidth;
  const comparedAt = columns
    .map((column, i) => (column === linkColumn ? -1 : at + i))
    .filter((i) => i !== -1);
  const linkAt = columns.indexOf(linkColumn);

  const byValues = new Map<string, Building>();
  const groups: Building[] = [];
  for (const row of rows) {
    const signature = JSON.stringify(comparedAt.map((i) => row[i] ?? null));
    let group = byValues.get(signature);
    if (!group) {
      group = {
        keys: [],
        cells: row.slice(keyColumns.length, at),
        links: [],
      };
      byValues.set(signature, group);
      groups.push(group);
    }
    group.keys.push(
      keyColumns.map((column, i) => ({ column, value: row[i] ?? "" })),
    );
    group.links.push(linkAt === -1 ? null : (row[at + linkAt] ?? null));
  }
  return groups;
}
