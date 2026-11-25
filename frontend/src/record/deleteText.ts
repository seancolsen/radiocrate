// What the "Delete records" dialog says about a deletion plan
// (`deletePlan.ts`), in English.
//
// Every line is put together from the names of tables and columns, since the
// plan follows relationships the user may have declared between tables of
// their own. A table the app knows gets its noun (`entityNames.ts`); any other
// is called by its name, whatever the count.

import { nounFor } from "../query/entityNames";
import { tableLabel } from "../query/schema";
import type { BlockedItem, DeleteSummary, PlanItem } from "./deletePlan";

const number = (n: number): string => n.toLocaleString("en-US");

/** "track" or "tracks", or the table's own name for one the app has no noun
 * for. */
export function recordNoun(table: string, n: number): string {
  return nounFor(table, n) ?? tableLabel(table);
}

/** "1 track", "3 tracks". */
export function recordCount(table: string, n: number): string {
  return `${number(n)} ${recordNoun(table, n)}`;
}

/** A column's name as prose reads it: `source_folder` is "source folder". */
const columnWords = (column: string): string => column.replaceAll("_", " ");

/** The dialog's title: "Delete track", "Delete 3 tracks". */
export function deleteTitle(table: string, count: number): string {
  return count === 1
    ? `Delete ${recordNoun(table, 1)}`
    : `Delete ${recordCount(table, count)}`;
}

/** What a line's checkbox does: "Delete 6 credits". */
export function itemLabel(item: PlanItem): string {
  return `Delete ${recordCount(item.table, item.count)}`;
}

/** Why a line is there, and what leaving it unchecked means. */
export function itemNote(item: PlanItem): string {
  const { relationship, count } = item;
  const one = count === 1;
  const column = columnWords(relationship.fromColumn);
  if (item.kind === "orphans") {
    const referrers = recordNoun(relationship.fromTable, 2);
    return `${one ? "It" : "They"} would be left with no ${referrers}.`;
  }
  if (item.required) {
    const record = recordNoun(item.table, 1);
    return `${article(record)} ${record} can’t be kept without its ${column}.`;
  }
  return one
    ? `Otherwise it’s kept, with no ${column}.`
    : `Otherwise they’re kept, with no ${column}.`;
}

/** "A" or "An", for the noun that follows. */
function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? "An" : "A";
}

/** The table whose records are the collection's audio files, one to a file:
 * the scanner's. Deleting one of its records can delete the file itself. */
const AUDIO_FILE_TABLE = "file";

/** How many audio files the deletion takes the records of. */
export function audioFileCount(summary: DeleteSummary): number {
  return summary.deletedByTable[AUDIO_FILE_TABLE] ?? 0;
}

/** What the "delete the audio files" checkbox does, for `n` of them. */
export function audioFilesLabel(n: number): string {
  return n === 1
    ? "Delete the audio file from disk"
    : `Delete the ${number(n)} audio files from disk`;
}

/** What leaving it unchecked means. */
export function audioFilesNote(n: number): string {
  return n === 1
    ? "Otherwise it stays, and the next scan adds it back."
    : "Otherwise they stay, and the next scan adds them back.";
}

/** Why the deletion can't go ahead past `item`. */
export function blockedNote(item: BlockedItem): string {
  const { relationship, count } = item;
  const records = recordCount(relationship.fromTable, count);
  const verb = count === 1 ? "refers" : "refer";
  return (
    `${records} ${verb} to what’s being deleted, and can be neither deleted ` +
    `nor changed from here: nothing identifies one record of ` +
    `“${tableLabel(relationship.fromTable)}”.`
  );
}

/** The whole deletion in a line, when it goes beyond the records asked for:
 * "In all, 14 records are deleted and 12 are changed." `undefined` when it
 * doesn't. */
export function totalsNote(summary: DeleteSummary): string | undefined {
  const { deleteCount, updateCount, found } = summary;
  if (deleteCount <= found && updateCount === 0) return undefined;
  const deleted = `${number(deleteCount)} ${
    deleteCount === 1 ? "record is" : "records are"
  } deleted`;
  if (updateCount === 0) return `In all, ${deleted}.`;
  return `In all, ${deleted} and ${number(updateCount)} ${
    updateCount === 1 ? "is" : "are"
  } changed.`;
}

/** What's become of the records asked for, when not all `count` of them are
 * still there to delete. `undefined` when they all are. */
export function missingNote(
  table: string,
  count: number,
  found: number,
): string | undefined {
  if (found >= count) return undefined;
  if (found === 0) {
    return count === 1
      ? `This ${recordNoun(table, 1)} has already been deleted.`
      : `These ${recordNoun(table, count)} have already been deleted.`;
  }
  const gone = count - found;
  return `${number(gone)} of the ${recordCount(table, count)} ${
    gone === 1 ? "has" : "have"
  } already been deleted.`;
}
