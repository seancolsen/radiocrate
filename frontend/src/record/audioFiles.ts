// The audio files behind a deletion (`deletePlan.ts`). The planner knows no
// table by name, but one table is special: each record of the scanner's `file`
// table is an audio file in the collection, which the "Delete records" dialog
// can delete from disk along with the record, and the folders it leaves.

import type { DeletePlan, DeleteSummary } from "./deletePlan";

/** The table whose records are the collection's audio files, one to a file. */
export const AUDIO_FILE_TABLE = "file";

/** How many audio files the deletion takes the records of. */
export function audioFileCount(summary: DeleteSummary): number {
  return summary.deletedByTable[AUDIO_FILE_TABLE] ?? 0;
}

/** The ids of the `file` records the deletion takes, sorted, so that two
 * plans taking the same files give the same list. */
export function audioFileIds(plan: DeletePlan): string[] {
  return (plan.deleted.get(AUDIO_FILE_TABLE) ?? [])
    .flatMap((key) => key.find((part) => part.column === "id")?.value ?? [])
    .sort();
}
