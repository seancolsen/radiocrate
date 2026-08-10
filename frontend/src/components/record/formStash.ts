// The record editor's unsaved work, kept per record for as long as its tab is
// open.
//
// The sidebar follows the result-row selection, so a form is mounted and
// unmounted constantly — but the changes the user made in it must survive that
// (spec: "Form state within the query page"). So the *model* doesn't belong to
// the mounted component: it's created here on first use, keyed by tab and by the
// records it's on, and handed back to whichever `RecordForm` next points at
// exactly those records. A tab that closes takes its forms with it
// (`pruneForms`).
//
// A form covers as many records as the selection it was opened on, so what keys
// it is a *list* of record identities: coming back to the same two rows finds
// the bulk edit made across them, and coming back to one of them alone is a
// different form.
//
// The stash is also what the results grid reads to mark rows: `modifiedRecords`
// names the records with unsaved changes — every record of every modified form,
// so a bulk edit stars every row it covers — reactively, so a red star can
// appear on a row whose form isn't even open.

import { createSignal } from "solid-js";
import type { RecordKey } from "../../query/recordForm";
import type { RecordFormModel } from "./formModel";

/** One form, and the tab it belongs to. */
interface StashEntry {
  tabId: string;
  /** The {@link recordIdentity} of each record the form is on. */
  identities: readonly string[];
  model: RecordFormModel;
}

const [entries, setEntries] = createSignal<readonly StashEntry[]>([]);

/** A record's identity as a string — table plus key — so two references to the
 * same database row compare equal however they were assembled. */
export function recordIdentity(table: string, key: RecordKey): string {
  return `${table}(${key.map((p) => `${p.column}=${p.value}`).join(",")})`;
}

/** The identities of a form's records as one comparable string. */
function formKey(identities: readonly string[]): string {
  return identities.join(" ");
}

/** The form for one set of records of one tab, created by `build` the first time
 * it's asked for and reused — with everything the user has changed in it — every
 * time after. */
export function stashedForm(
  tabId: string,
  identities: readonly string[],
  build: () => RecordFormModel,
): RecordFormModel {
  const existing = entries().find(
    (e) => e.tabId === tabId && formKey(e.identities) === formKey(identities),
  );
  if (existing) return existing.model;
  const model = build();
  setEntries((prev) => [...prev, { tabId, identities, model }]);
  return model;
}

/** One set of records' form, if it has one — reactive, so a caller that asks
 * before the form is mounted (the panel's toolbar renders alongside it) gets it
 * as soon as it exists. */
export function formFor(
  tabId: string,
  identities: readonly string[],
): RecordFormModel | undefined {
  return entries().find(
    (e) => e.tabId === tabId && formKey(e.identities) === formKey(identities),
  )?.model;
}

/** The records of `tabId` holding unsaved changes, by identity — every record of
 * every modified form. Reactive: it reads each stashed form's modification
 * state, so a keystroke in the sidebar moves the markers on the rows behind
 * it. */
export function modifiedRecords(tabId: string): string[] {
  return entries()
    .filter((e) => e.tabId === tabId && e.model.isModified())
    .flatMap((e) => e.identities);
}

/** Lets go of one form unless it holds unsaved changes — what a form does as it
 * unmounts. Keeping every record the user has merely *looked* at would grow with
 * the number of rows they click through; what has to survive is the changes, and
 * those keep their form. */
export function releaseUnmodified(
  tabId: string,
  identities: readonly string[],
): void {
  setEntries((prev) =>
    prev.filter(
      (e) =>
        e.tabId !== tabId ||
        formKey(e.identities) !== formKey(identities) ||
        e.model.isModified(),
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
