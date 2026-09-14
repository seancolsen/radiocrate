import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { shallow } from "zustand/vanilla/shallow";
import type { RecordKey } from "../../query/recordForm";
import type { RecordFormModel } from "./recordForm";

export type { RecordFormModel } from "./recordForm";

// The record editor's unsaved work, kept per record for as long as its tab is
// open — and which of those forms the keyboard is currently aimed at.
//
// Ported from two Solid modules that this stage folds into one store:
//
// - `components/record/formStash.ts`: a form covers as many records as the
//   selection it was opened on, so what keys it is a *list* of record
//   identities — coming back to the same two rows finds the bulk edit made
//   across them, and coming back to one of them alone is a different form.
//   The sidebar follows the row selection, so a form is mounted and unmounted
//   constantly, but the *model* it wraps doesn't belong to the mounted
//   component: it's created here on first use and handed back to whichever
//   `RecordForm` next points at exactly those records. A tab that closes takes
//   its forms with it (`prune`).
// - `components/record/formRegistry.ts`: which mounted form(s) the keyboard is
//   aimed at, for the selection commands ("Select down", "Expand nested
//   items", "Delete") to route to instead of the result rows.
//
// `mounted` (a count, not a boolean) replaces `formRegistry`'s separate
// registered-forms list: StrictMode mounts a component, cleans it up, and
// mounts it again, and a bare boolean can't tell that apart from a form
// actually leaving the page — but each of those (re)mounts reuses the *same*
// stashed model, and `mount`/`unmount` are called in matching pairs from one
// effect, so the count still nets out to "is at least one instance of this
// form currently on screen".
//
// The store holds the entry mechanics — which model is stashed under which
// (tabId, identities), how many components currently have it mounted, and a
// mirrored `summary` of it. The model itself is `stores/recordForm/`; this
// store and `stores/commands.ts` only reach it through `store`, `getSummary`,
// `dispose` and the three selection commands.

/** The pieces of a mounted form's state that matter *outside* the form
 * itself: whether it holds the keyboard's focus or a selection, whether its
 * modal record picker is open, and whether it has unsaved changes. The forms
 * store mirrors this out of each stashed model so the consumers that sit
 * across forms (the command context, the results grid's ✱ marks) can read
 * plain selectors over *this* store, rather than each subscribing to every
 * mounted form's own store individually. */
export interface RecordFormSummary {
  focused: boolean;
  selecting: boolean;
  pickerOpen: boolean;
  modified: boolean;
}

/** One stashed form: which records of which tab it's on, the model itself,
 * how many mounted components currently hold it, and the mirrored summary. */
export interface FormEntry {
  tabId: string;
  /** The `recordIdentity` of each record the form is on. */
  identities: readonly string[];
  model: RecordFormModel;
  mounted: number;
  summary: RecordFormSummary;
}

export interface FormsState {
  entries: readonly FormEntry[];
}

/** A record's identity as a string — table plus key — so two references to the
 * same database row compare equal however they were assembled.
 *
 * Kept here rather than shared with the Solid `formStash.ts` copy it was ported
 * from: the stash's keys are this store's own encoding, and the Solid module is
 * deleted at the cutover. */
export function recordIdentity(table: string, key: RecordKey): string {
  return `${table}(${key.map((p) => `${p.column}=${p.value}`).join(",")})`;
}

/** The identities of a form's records as one comparable string — same
 * encoding `formStash.ts` used for its key. */
function formKey(identities: readonly string[]): string {
  return identities.join(" ");
}

function findEntry(
  entries: readonly FormEntry[],
  tabId: string,
  identities: readonly string[],
): FormEntry | undefined {
  const key = formKey(identities);
  return entries.find(
    (e) => e.tabId === tabId && formKey(e.identities) === key,
  );
}

function initialFormsState(): FormsState {
  return { entries: [] };
}

function createFormsVanillaStore() {
  return createStore<FormsState>()(subscribeWithSelector(initialFormsState));
}

export type FormsVanillaStore = ReturnType<typeof createFormsVanillaStore>;

// ── Selectors — pure functions of `FormsState` ──────────────────────────────

/** One set of records' form, if it has one. */
export function selectFormFor(
  s: FormsState,
  tabId: string,
  identities: readonly string[],
): RecordFormModel | undefined {
  return findEntry(s.entries, tabId, identities)?.model;
}

/** The form the user is working in, if any: a *mounted* form with a focused
 * item or a non-empty selection. Unmounted entries are skipped — with no
 * component on screen there's nothing for "focused" to mean, same as
 * `formRegistry.ts`'s registry (which only ever held mounted handles). */
export function selectFocusedForm(s: FormsState): RecordFormModel | undefined {
  return s.entries.find(
    (e) => e.mounted > 0 && (e.summary.focused || e.summary.selecting),
  )?.model;
}

/** Whether any mounted form has its modal record picker open — a dialog that
 * owns the keyboard, so the global shortcut pass stands down for it as it
 * does for the app's other modals. */
export function selectRecordPickerOpen(s: FormsState): boolean {
  return s.entries.some((e) => e.mounted > 0 && e.summary.pickerOpen);
}

/** The records of `tabId` holding unsaved changes, by identity — every record
 * of every modified form, mounted or not (a bulk edit still stars its rows
 * once the sidebar has moved on). Builds a fresh array on every call. */
export function selectModifiedRecords(s: FormsState, tabId: string): string[] {
  return s.entries
    .filter((e) => e.tabId === tabId && e.summary.modified)
    .flatMap((e) => e.identities);
}

// ── Actions ──────────────────────────────────────────────────────────────—

export interface FormsActions {
  /** The form for one set of records of one tab, created by `build` the first
   * time it's asked for and reused — with everything the user has changed in
   * it — every time after. Idempotent, so it's safe to call from a
   * `useState(() => …)` initializer that StrictMode may invoke twice. */
  stashedForm: (
    tabId: string,
    identities: readonly string[],
    build: () => RecordFormModel,
  ) => RecordFormModel;
  /** Register one more mounted component pointed at this form — call from an
   * effect; the paired cleanup must call `unmount` with the same arguments. */
  mount: (tabId: string, identities: readonly string[]) => void;
  unmount: (tabId: string, identities: readonly string[]) => void;
  /** Lets go of one form unless it holds unsaved changes — what a form does
   * as it unmounts. Keeping every record the user has merely *looked* at
   * would grow with the number of rows they click through; what has to
   * survive is the changes, and those keep their form. */
  releaseUnmodified: (tabId: string, identities: readonly string[]) => void;
  /** Forgets (and disposes) the forms of every tab not in `liveTabIds` — a
   * closed tab's unsaved changes go with it. */
  prune: (liveTabIds: readonly string[]) => void;
}

function createFormsActions(store: FormsVanillaStore): FormsActions {
  // One unsubscribe per stashed model, keyed the same way as the entries
  // themselves, so a dropped entry stops mirroring its (now-disposed) model.
  const modelUnsubscribes = new Map<string, () => void>();

  function unsubscribeKey(
    tabId: string,
    identities: readonly string[],
  ): string {
    return `${tabId} ${formKey(identities)}`;
  }

  /** Re-reads one entry's model summary and writes it back only if it
   * changed (shallow) — the "mirrors a summary of each model" wiring the
   * plan describes, run from that model's own store subscription. */
  function refreshSummary(tabId: string, identities: readonly string[]) {
    const { entries } = store.getState();
    const idx = entries.findIndex(
      (e) => e.tabId === tabId && formKey(e.identities) === formKey(identities),
    );
    if (idx === -1) return;
    const entry = entries[idx];
    const next = entry.model.getSummary();
    if (shallow(entry.summary, next)) return;
    const nextEntries = entries.slice();
    nextEntries[idx] = { ...entry, summary: next };
    store.setState({ entries: nextEntries });
  }

  function disposeEntry(entry: FormEntry) {
    modelUnsubscribes.get(unsubscribeKey(entry.tabId, entry.identities))?.();
    modelUnsubscribes.delete(unsubscribeKey(entry.tabId, entry.identities));
    entry.model.dispose();
  }

  function updateEntry(
    tabId: string,
    identities: readonly string[],
    mutate: (entry: FormEntry) => FormEntry,
  ) {
    const { entries } = store.getState();
    const key = formKey(identities);
    const idx = entries.findIndex(
      (e) => e.tabId === tabId && formKey(e.identities) === key,
    );
    if (idx === -1) return;
    const nextEntries = entries.slice();
    nextEntries[idx] = mutate(entries[idx]);
    store.setState({ entries: nextEntries });
  }

  return {
    stashedForm(tabId, identities, build) {
      const existing = findEntry(store.getState().entries, tabId, identities);
      if (existing) return existing.model;
      const model = build();
      const entry: FormEntry = {
        tabId,
        identities,
        model,
        mounted: 0,
        summary: model.getSummary(),
      };
      store.setState((s) => ({ entries: [...s.entries, entry] }));
      const unsubscribe = model.store.subscribe(() =>
        refreshSummary(tabId, identities),
      );
      modelUnsubscribes.set(unsubscribeKey(tabId, identities), unsubscribe);
      return model;
    },
    mount(tabId, identities) {
      updateEntry(tabId, identities, (e) => ({ ...e, mounted: e.mounted + 1 }));
    },
    unmount(tabId, identities) {
      updateEntry(tabId, identities, (e) => ({
        ...e,
        mounted: Math.max(0, e.mounted - 1),
      }));
    },
    releaseUnmodified(tabId, identities) {
      const entry = findEntry(store.getState().entries, tabId, identities);
      if (!entry || entry.summary.modified) return;
      disposeEntry(entry);
      store.setState((s) => ({
        entries: s.entries.filter((e) => e !== entry),
      }));
    },
    prune(liveTabIds) {
      const live = new Set(liveTabIds);
      const { entries } = store.getState();
      const dropped = entries.filter((e) => !live.has(e.tabId));
      if (dropped.length === 0) return;
      for (const entry of dropped) disposeEntry(entry);
      store.setState({ entries: entries.filter((e) => live.has(e.tabId)) });
    },
  };
}

/** Builds the forms store: the stash-plus-registry mechanics above, with no
 * model of its own — `RecordForm` (stage 8) supplies one per form through
 * `stashedForm`'s `build`. */
export function createFormsStore(): {
  store: FormsVanillaStore;
  actions: FormsActions;
} {
  const store = createFormsVanillaStore();
  const actions = createFormsActions(store);
  return { store, actions };
}

export type FormsStoreBundle = ReturnType<typeof createFormsStore>;
