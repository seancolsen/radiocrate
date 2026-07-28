// The record editor's unsaved work, kept per record for as long as its tab is
// open.
//
// The sidebar follows the result-row selection, so a record's form is mounted
// and unmounted constantly — but the changes the user made in it must survive
// that (spec: "Form state within the query page"). So the *model* doesn't belong
// to the mounted component: it's created here on first use, keyed by tab and
// record, and handed back to whichever `RecordForm` next points at that record.
// A tab that closes takes its records' forms with it (`pruneForms`).
//
// The stash is also what the results grid reads to mark rows: `modifiedRecords`
// names the records with unsaved changes, reactively, so a red star can appear
// on a row whose form isn't even open.

import { createSignal } from "solid-js";
import type { KeyPart } from "../../query/recordForm";
import type { RecordFormModel } from "./formModel";

/** One record's form, and the tab it belongs to. */
interface StashEntry {
  tabId: string;
  /** The record's {@link recordIdentity}. */
  identity: string;
  model: RecordFormModel;
}

const [entries, setEntries] = createSignal<readonly StashEntry[]>([]);

/** A record's identity as a string — table plus key — so two references to the
 * same database row compare equal however they were assembled. */
export function recordIdentity(table: string, key: readonly KeyPart[]): string {
  return `${table}(${key.map((p) => `${p.column}=${p.value}`).join(",")})`;
}

/** The form for one record of one tab, created by `build` the first time it's
 * asked for and reused — with everything the user has changed in it — every time
 * after. */
export function stashedForm(
  tabId: string,
  identity: string,
  build: () => RecordFormModel,
): RecordFormModel {
  const existing = entries().find(
    (e) => e.tabId === tabId && e.identity === identity,
  );
  if (existing) return existing.model;
  const model = build();
  setEntries((prev) => [...prev, { tabId, identity, model }]);
  return model;
}

/** The records of `tabId` holding unsaved changes, by identity. Reactive: it
 * reads each stashed form's modification state, so a keystroke in the sidebar
 * moves the marker on the row behind it. */
export function modifiedRecords(tabId: string): string[] {
  return entries()
    .filter((e) => e.tabId === tabId && e.model.isModified())
    .map((e) => e.identity);
}

/** Lets go of one record's form unless it holds unsaved changes — what a form
 * does as it unmounts. Keeping every record the user has merely *looked* at
 * would grow with the number of rows they click through; what has to survive is
 * the changes, and those keep their form. */
export function releaseUnmodified(tabId: string, identity: string): void {
  setEntries((prev) =>
    prev.filter(
      (e) =>
        e.tabId !== tabId || e.identity !== identity || e.model.isModified(),
    ),
  );
}

/** Forgets the forms of every tab not in `liveTabIds` — a closed tab's unsaved
 * changes go with it. */
export function pruneForms(liveTabIds: readonly string[]): void {
  const live = new Set(liveTabIds);
  const kept = entries().filter((e) => live.has(e.tabId));
  if (kept.length !== entries().length) setEntries(kept);
}
