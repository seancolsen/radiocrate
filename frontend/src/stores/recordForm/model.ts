// The record editor form's model: one vanilla Zustand+Immer store per edited
// record set (`state.ts` holds its shape, `selectors.ts` its reads), and the
// actions that load into it, edit it and save it.
//
// A node stands for however many records the form is on: one, ordinarily, and
// as many as the result-row selection holds when the user has widened it. That
// number is *not* a branch in the shape of anything here — a node keeps one
// value per field per record and one load covers them all — it only surfaces
// where a field's records turn out to disagree (`formValues.ts`), which is the
// one thing the form won't edit across several records at once
// (`selectBeyondBulk`).
//
// A multi-record field is no exception, and that is what makes it work: the
// records under it are loaded for every base record in one query and collapsed
// into the rows that say the same thing about each of them
// (`record/childGroups.ts`). A row is then simply another node standing for
// several records — editable, deletable and savable by everything above it,
// with no bulk path of its own.
//
// Loading is lazy and idempotent: expanding an item fetches its data the first
// time only, and collapsing keeps it. Each fetch is guarded by a token so a
// superseded load (expand, collapse, expand again) can't overwrite a newer one.
//
// **Construction has no side effects.** The model lives in the forms store's
// stash, and `RecordForm` obtains it from a `useState` initializer that
// StrictMode may run twice — so building one only computes its initial state.
// The root's load starts from `start()`, which a mounted form calls from an
// effect and which runs at most once per model.
//
// Two things about the form are *not* stored here, because the DOM already holds
// them better: which element has focus (see `formNav.ts` — document order is the
// order the user moves through), and how an item expands or deletes itself
// (`registerItem` — each rendered row hands the model a handle). What the model
// keeps is the id of the focused item, which is what decides where a keyboard
// command lands.
//
// Saving reverses the whole arrangement: `formSave.ts` reads this tree and
// writes the DML request that puts it in the database, and what comes back
// becomes the new baseline (`applySave`).

import { castDraft } from "immer";
import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { dml, type DmlOperation, type DmlResult } from "api-client";
import {
  identifyingColumns,
  primaryKey,
  type SchemaTable,
} from "../../query/schema";
import {
  buildFormFields,
  keySignature,
  recordDataQuery,
  type FormField,
  type MultiRecordField,
  type RecordKey,
  type RecordQuery,
  type ScalarLinkField,
} from "../../query/recordForm";
import { isShared, type ColumnValues } from "../../record/formValues";
import {
  childRecordsQuery,
  childRecordsTabQuery,
  embeddedRecordQuery,
  embedSpec,
  type EmbedSpec,
} from "../../query/embeddedRecord";
import { runRecordQuery } from "../../query/recordData";
import { groupChildRows } from "../../record/childGroups";
import {
  focusAdjacentItem,
  focusItem,
  itemElement,
} from "../../record/formNav";
import {
  childId,
  deletedChildId,
  fieldItemId,
  listId,
  newChildId,
  ROOT_ID,
  scalarChildId,
} from "../../record/formIds";
import { planSave, type SavePlan } from "../../record/formSave";
import type { RecordFormSummary } from "../forms";
import {
  selectBeyondBulk,
  selectFieldOf,
  selectFormSummary,
  selectSharedValue,
} from "./selectors";
import {
  initialFormState,
  type EmbedNode,
  type FormMenu,
  type FormState,
  type ItemHandle,
  type ListNode,
  type LoadStatus,
  type RecordNode,
} from "./state";

function createFormVanillaStore(initial: FormState) {
  return createStore<FormState>()(subscribeWithSelector(immer(() => initial)));
}

/** One form's own store: Immer writes, `subscribeWithSelector` subscriptions. */
export type FormStore = ReturnType<typeof createFormVanillaStore>;

export interface RecordFormOptions {
  tables: readonly SchemaTable[];
  table: string;
  /** The records being edited — one, ordinarily; as many as the result-row
   * selection holds when the user has widened it. */
  keys: readonly RecordKey[];
  schemaJson: string;
  /** How the save reaches the database. The plain DML call by default; the query
   * page passes one that carries the result row the record is being edited from,
   * so the row is re-read once the save lands (see `query/rowDml.ts`). Either way
   * what comes back is the API's own answer, which is all this model reads. */
  runDml?: (operations: DmlOperation[]) => Promise<DmlResult>;
  /** Shows the records `query` finds somewhere other than the form — the query
   * page opens them in a new query tab. Without it, a multi-record field has
   * nowhere to open its records. */
  openRecords?: (query: RecordQuery) => void;
}

/** Everything the form can be told to do. Stable for the model's life, so a
 * component can call them from any handler or effect without re-subscribing.
 * Reads are selectors (`selectors.ts`). */
export interface RecordFormActions {
  /** Dismiss the save-error message, leaving the unsaved changes it was about
   * in place. */
  clearSaveError: () => void;

  /** The preview columns (and their ordering) generated for one table — what the
   * record picker's display and sort builders open pre-filled with. */
  previewSpec: (table: string, contextColumn?: string) => EmbedSpec;

  /** The form's root element, set once it's rendered — how the model reaches the
   * DOM to move focus. */
  setRoot: (el: HTMLElement | undefined) => void;

  /** Expand/collapse a field, loading its data the first time it opens. */
  toggleField: (recordId: string, field: FormField, open?: boolean) => void;
  /** Expand/collapse a child record within a multi-record field, loading its
   * data the first time it opens. */
  toggleChild: (id: string, open?: boolean) => void;
  /** Expand/collapse every item alongside this one — Ctrl+Click on a toggle. */
  toggleSiblings: (itemId: string, open: boolean) => void;

  /** Put a field into edit mode (its value becomes an input). `selectAll` marks
   * that value to be selected whole once the input mounts, rather than have the
   * caret placed at its end — set when Tabbing in from another field's editor. */
  beginEdit: (
    recordId: string,
    fieldKey: string,
    opts?: { selectAll?: boolean },
  ) => void;
  /** Puts whichever item currently holds focus into edit mode, when it's a
   * field with one to enter — the rest of the Tab-out-of-an-editor flow, once
   * {@link RecordFormActions.focusAdjacent} has moved focus to it. A no-op for
   * any other kind of item (nothing to do), or when nothing is focused. */
  beginEditAtFocused: (selectAll: boolean) => void;
  /** Take what's in the activated input as the field's value, without leaving
   * edit mode — called on every keystroke, so the form (and its modification
   * stars) track what the user is typing as they type it. */
  editValue: (recordId: string, column: string, value: string) => void;
  /** Leave edit mode, keeping `value` as the field's current (in-memory) value —
   * which stays in memory until {@link RecordFormActions.save}. An empty string
   * is stored as NULL, unless the column is non-nullable text — the one kind of
   * field an empty string is itself a legitimate value for. */
  commitEdit: (recordId: string, column: string, value: string) => void;

  /** Write everything the user has changed to the database, in one DML request:
   * every edited value, every record created, every record removed. On success
   * the form stays open on what it just saved; on failure it keeps the changes
   * and reports why (see `FormState.saveError`). */
  save: () => Promise<void>;

  /** Discard every unsaved change — every edited value, every record created
   * or removed — and reload the record as it stands in the database. The
   * toolbar's "Reset" button, live only while `selectFormModified` is true. */
  reset: () => void;

  /** Register a rendered row's capabilities (call `unregisterItem` on cleanup). */
  registerItem: (itemId: string, handle: ItemHandle) => void;
  unregisterItem: (itemId: string) => void;

  /** Record that an item took focus (called from its `focus` event). */
  noteFocus: (itemId: string) => void;
  /** Record that focus left the form entirely. */
  noteBlur: () => void;
  /** Move focus to one item, or one item along. */
  focusItem: (itemId: string) => void;
  focusAdjacent: (forward: boolean) => boolean;

  /** Click an embedded record, with the modifiers that make it a range or a
   * toggle — the result-row selection gestures, within one list. */
  clickEmbedded: (
    itemId: string,
    mods: { shift: boolean; ctrl: boolean },
  ) => void;
  clearSelection: () => void;

  /** "Selection: Expand/Collapse nested items" over the selection, or over the
   * focused item when nothing is selected. */
  expandSelection: (open: boolean) => void;
  /** "Selection: Delete", likewise. */
  deleteSelection: () => void;

  /** Clear a field — in the form only, until it's saved. A primitive or scalar
   * link goes to NULL (a scalar link dropping the record it pointed at with it);
   * a multi-record field drops every record under it. */
  clearField: (recordId: string, field: FormField) => void;
  /** Drop one record from a multi-record field, likewise ephemerally. */
  removeChild: (
    recordId: string,
    field: MultiRecordField,
    childRecordId: string,
  ) => void;
  /** Drop several at once — what a context menu raised on a selection does. */
  removeChildren: (
    recordId: string,
    field: MultiRecordField,
    childRecordIds: readonly string[],
  ) => void;

  /** Scaffold a new record within a multi-record field: it goes in at the top of
   * the list, expanded, with its first editable field activated so the user can
   * type straight into it. A record can only be filed under one parent, so on
   * several base records this scaffolds one apiece — a single row saying the
   * same thing about each of them. */
  addChild: (recordId: string, field: MultiRecordField) => void;
  /** Hand the records under a multi-record field to `openRecords`, as a query
   * with the same filter, sort and preview columns the field lists them with —
   * the records of every base record the form is on, as the rows they are
   * rather than the rows the form collapses them into. The records as the
   * database holds them, not as the form has them: a query can't see unsaved
   * changes. A no-op for records with no id of their own yet. */
  openChildRecords: (recordId: string, field: MultiRecordField) => void;
  /** Scaffold a new record for a scalar linked record field to point at, in
   * place of whatever it pointed at before. `seed` fills in its first text
   * field — the record picker hands over what the user had searched for, on the
   * grounds that a record they looked for and didn't find is a fair first draft
   * of the one they're about to write. */
  addLinkedRecord: (
    recordId: string,
    field: ScalarLinkField,
    seed?: string,
  ) => void;

  /** Open a context menu on part of the form (one at a time), and close it. */
  openMenu: (menu: FormMenu) => void;
  closeMenu: () => void;

  /** Open the modal record picker on a scalar linked record field, and close it
   * (leaving the field as it was). */
  openPicker: (recordId: string, fieldKey: string) => void;
  closePicker: () => void;
  /** Point a scalar linked record field at an existing record the user chose in
   * the picker, closing it. `cells` is the preview the picker already loaded, so
   * the embedded record renders without a further request. */
  pickRecord: (
    recordId: string,
    field: ScalarLinkField,
    keyValue: string,
    cells: readonly (string | null)[],
  ) => void;
}

/** The form for the records the sidebar points at (re-pointing it builds a new
 * one): its store, its actions, and the lifecycle the forms store drives. */
export interface RecordFormModel extends RecordFormActions {
  /** The form's own store — what `useFormState` reads and the forms store
   * subscribes to for its summary. */
  store: FormStore;
  /** Kicks off the root record's load. Idempotent: only the first call does
   * anything, so every mount of a stashed model can call it. */
  start: () => void;
  /** A fresh {@link RecordFormSummary} of the current state. */
  getSummary: () => RecordFormSummary;
  /** Called once, when the forms store drops the model: loads still in flight
   * find their tokens spent and write nothing, and the DOM registries let go. */
  dispose: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The current moment, in the naive `YYYY-MM-DD HH:MM:SS` spelling a timestamp
 * column's text form takes — read off the local wall clock (unlike
 * `stringifyArrowValue`'s UTC-as-civil reading of a *stored* value, "now" is
 * civil time here from the start). What a timestamp field is pre-filled with
 * when the user starts adding one. */
function formatCurrentTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Seeds `values` with the key columns — the part of a record we know without
 * asking the backend, and the only thing rendered while its load is in
 * flight. Every key names the same columns in the same order (they identify
 * records of one table), so the first one gives the column list. */
function seedValues(keys: readonly RecordKey[]): Record<string, ColumnValues> {
  return Object.fromEntries(
    (keys[0] ?? []).map((part, at) => [
      part.column,
      keys.map((key) => key[at]?.value ?? null),
    ]),
  );
}

/** A returned column as the form holds values — text, or NULL. */
function cellText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function createRecordForm(opts: RecordFormOptions): RecordFormModel {
  /** A record node the form knows exists, before anything is loaded into it. */
  const recordNode = (
    table: string,
    keys: readonly RecordKey[],
    hidden: readonly string[],
    status: LoadStatus,
  ): RecordNode => ({
    table,
    keys,
    hidden,
    fields: buildFormFields(opts.tables, table, hidden),
    status,
    error: null,
    values: seedValues(keys),
    original: seedValues(keys),
    counts: {},
    isNew: false,
  });

  // The root exists from the start — the keys of the records it's on are
  // known — and its data is fetched by `start()`, under the loading wash.
  const rootState = (): FormState => ({
    ...initialFormState(),
    records: {
      [ROOT_ID]: recordNode(opts.table, opts.keys, [], "unloaded"),
    },
  });

  const store = createFormVanillaStore(rootState());
  const get = store.getState;
  const set = store.setState;

  // Per-node load tokens: only the newest load for a node may write its result.
  const tokens = new Map<string, number>();
  /** Fetches of records that a *save* has to delete (see
   * `loadRemovedChildren`), which is why a save waits for them. */
  const pendingRemovals = new Set<Promise<void>>();
  let tokenSeq = 0;
  /** Distinguishes the records the form creates, whose ids can't come from a
   * position in a loaded list. */
  let newSeq = 0;
  let started = false;

  // What each rendered row can do to itself, and the form's root element — the
  // two non-reactive registries the keyboard commands go through.
  const items = new Map<string, ItemHandle>();
  let root: HTMLElement | undefined;
  /** Where a Shift+Click range starts. */
  let anchor: string | null = null;

  /** The preview columns for a table are the same every time, so the (pure)
   * generation runs once per table + contextual filter. */
  const specs = new Map<string, EmbedSpec>();
  const specFor = (table: string, contextColumn?: string): EmbedSpec => {
    const cacheKey = `${table} ${contextColumn ?? ""}`;
    let spec = specs.get(cacheKey);
    if (!spec) {
      spec = embedSpec(opts.tables, table, contextColumn);
      specs.set(cacheKey, spec);
    }
    return spec;
  };

  // ── Writes ─────────────────────────────────────────────────────────────────
  //
  // These merge into an existing node only, and skip an absent one: a load that
  // lands after `reset()` must not conjure a partial node, which `planSave`
  // would then trip over. Every caller writes a node it created first.

  const patchRecord = (id: string, patch: Partial<RecordNode>) =>
    set((s) => {
      const node = s.records[id];
      if (node) Object.assign(node, castDraft(patch));
    });

  const patchList = (id: string, patch: Partial<ListNode>) =>
    set((s) => {
      const list = s.lists[id];
      if (list) Object.assign(list, patch);
    });

  const setEmbed = (id: string, embed: EmbedNode) =>
    set((s) => {
      s.embeds[id] = castDraft(embed);
    });

  const addRecord = (
    id: string,
    table: string,
    keys: readonly RecordKey[],
    hidden: readonly string[],
    status: LoadStatus,
  ) =>
    set((s) => {
      s.records[id] = castDraft(recordNode(table, keys, hidden, status));
    });

  /** Creates a record the form is *inventing*: no key, nothing to fetch, every
   * field empty and editable from the start. `hidden` carries the contextual
   * filter of the field it's being created under, exactly as a loaded child of
   * that field would (the column tying it to its parent isn't the user's to
   * fill in).
   *
   * Its values are seeded NULL rather than left absent so the fields render as
   * *known to be empty* — pencils and all — instead of as still loading. */
  const addNewRecord = (
    id: string,
    table: string,
    hidden: readonly string[],
    records = 1,
  ) => {
    const fields = buildFormFields(opts.tables, table, hidden);
    const values: Record<string, ColumnValues> = {};
    const counts: Record<string, readonly number[]> = {};
    // One entry per record being created: one, ordinarily, and one per base
    // record when a multi-record field is being added to across several.
    const each = Array.from({ length: records }, () => null);
    for (const field of fields) {
      if (field.kind === "multiRecord") counts[field.key] = each.map(() => 0);
      else values[field.column] = [...each];
    }
    set((s) => {
      s.records[id] = castDraft({
        table,
        keys: each.map(() => []),
        hidden,
        fields,
        status: "loaded",
        error: null,
        values,
        original: { ...values },
        counts,
        isNew: true,
      });
    });
  };

  // ── Values, across the records a node stands for ───────────────────────────

  /** Writes one value into a column of *every* record a node stands for — which
   * is what every edit does, the form only ever offering to edit a column whose
   * records already agree. */
  const setColumn = (recordId: string, column: string, value: string | null) =>
    set((s) => {
      const n = s.records[recordId];
      if (n) n.values[column] = n.keys.map(() => value);
    });

  /** Likewise for a multi-record field's related-record count, which the form
   * keeps in step with the records it holds under that field. */
  const setCount = (recordId: string, fieldKey: string, count: number) =>
    set((s) => {
      const n = s.records[recordId];
      if (n) n.counts[fieldKey] = n.keys.map(() => count);
    });

  /** Likewise, when the records hold *different* numbers of related records —
   * which is what the field's badge reads as a range. */
  const setCounts = (
    recordId: string,
    fieldKey: string,
    counts: readonly number[],
  ) =>
    set((s) => {
      const n = s.records[recordId];
      if (n) n.counts[fieldKey] = [...counts];
    });

  /** The ids of the records a node stands for — what the records under its
   * multi-record fields point back at. Every inferred link points at
   * `<table>.id`, so that, not the node's key (which may be composite), is the
   * value. A record with no id of its own (one the form is creating) has no
   * children to find, and drops out. */
  const parentValues = (recordId: string): string[] =>
    (get().records[recordId]?.values["id"] ?? []).filter(
      (value): value is string => (value ?? "") !== "",
    );

  /** Every column of a table, as introspection gives them — what a child list's
   * query carries so its records can be compared with each other. */
  const columnsOf = (table: string): string[] =>
    opts.tables.find((t) => t.name === table)?.columns.map((c) => c.name) ?? [];

  /** Brings a multi-record field's counts back in line with the rows its list
   * holds — one count per record the node stands for, which is what the field's
   * badge reads. Every row knows which base record each of its records hangs
   * off (the link column it was loaded with), so this is a tally rather than
   * another query.
   *
   * A row the form is *creating* has no link value yet: it was scaffolded with
   * one record per base record, in that order, so its records are counted by
   * position instead. */
  /** Moves a multi-record field's count by `delta` for every record the node
   * stands for — what adding to a list that hasn't arrived yet does, there
   * being nothing to tally until it has. */
  const bumpCounts = (recordId: string, fieldKey: string, delta: number) => {
    const node = get().records[recordId];
    if (!node) return;
    setCounts(
      recordId,
      fieldKey,
      node.keys.map((_, i) =>
        Math.max(0, (node.counts[fieldKey]?.[i] ?? 0) + delta),
      ),
    );
  };

  const recountField = (recordId: string, field: MultiRecordField) => {
    const s = get();
    const node = s.records[recordId];
    const list = s.lists[listId(recordId, field.key)];
    // A list still on its way holds none of the rows it is about to: what the
    // field's own load reported is all there is to go on until it lands (which
    // is what `bumpCounts` is for).
    if (!node || list?.status !== "loaded") return;
    const parents = node.keys.map((_, i) => node.values["id"]?.[i] ?? null);
    const counts = node.keys.map(() => 0);
    for (const child of list.childIds) {
      const row = s.records[child];
      if (!row) continue;
      if (row.isNew) {
        row.keys.forEach((_, i) => {
          if (i < counts.length) counts[i] += 1;
        });
      } else {
        for (const link of row.values[field.column] ?? []) {
          const i = parents.indexOf(link);
          if (i !== -1) counts[i] += 1;
        }
      }
    }
    setCounts(recordId, field.key, counts);
  };

  const beyondBulk = (recordId: string, field: FormField): boolean =>
    selectBeyondBulk(get(), recordId, field);

  /** The first field of a record the user can type into — where the caret goes
   * when a new record is scaffolded. Skips the table's primary key, which the
   * database issues rather than the user. `preferText` picks the first *text*
   * field instead, which is where a seed value goes: prose is the only kind of
   * field a search box's contents are a plausible draft of. */
  const firstEditableField = (
    recordId: string,
    preferText = false,
  ): FormField | undefined => {
    const node = get().records[recordId];
    if (!node) return undefined;
    const table = opts.tables.find((t) => t.name === node.table);
    const pk = table ? primaryKey(table) : undefined;
    const editable = node.fields.filter(
      (field) => field.kind === "primitive" && field.column !== pk,
    );
    const text = editable.find(
      (field) => field.kind === "primitive" && field.valueType === "text",
    );
    return (preferText ? text : undefined) ?? editable[0];
  };

  /** Puts the caret in a newly scaffolded record's first editable field, so the
   * user can begin typing immediately, optionally with `seed` already in it. The
   * input focuses itself as it mounts, so this holds whether or not the row is
   * on screen yet (a list still loading shows its placeholders first). */
  const activateNewRecord = (recordId: string, seed?: string) => {
    const field = firstEditableField(recordId, seed !== undefined);
    if (!field) return;
    if (seed !== undefined && field.kind === "primitive") {
      setColumn(recordId, field.column, seed);
    }
    set((s) => {
      s.editing = fieldItemId(recordId, field.key);
    });
  };

  // ── Loading ────────────────────────────────────────────────────────────────

  /** Loads the preview behind one embedded record: the columns that identify it
   * at a glance, for the single record `key` identifies. Used for a scalar
   * linked record field, whose id arrives with its parent's data (a multi-record
   * field's children come with their previews already attached), and for a
   * record that has just been saved into either.
   *
   * `contextColumn` is the column a multi-record field filters its children on,
   * which the preview leaves out — passing it keeps a freshly saved record
   * looking like the siblings it sits among.
   *
   * With no preview columns to be had, the key stands in for them rather than
   * leaving the widget blank. */
  const loadEmbed = async (
    id: string,
    table: string,
    key: RecordKey,
    contextColumn?: string,
  ) => {
    const keyCells = key.map((p) => p.value);
    const spec = specFor(table, contextColumn);
    if (spec.display.length === 0) {
      setEmbed(id, { status: "loaded", cells: keyCells });
      return;
    }
    const token = ++tokenSeq;
    tokens.set(id, token);
    setEmbed(id, { status: "loading", cells: [] });
    try {
      const rows = await runRecordQuery(
        embeddedRecordQuery(table, key, spec),
        opts.schemaJson,
      );
      if (tokens.get(id) !== token) return;
      setEmbed(id, { status: "loaded", cells: rows[0] ?? keyCells });
    } catch (err) {
      if (tokens.get(id) !== token) return;
      console.error("embedded record preview failed", errorMessage(err));
      setEmbed(id, { status: "error", cells: keyCells });
    }
  };

  /** Kicks off the preview of every scalar linked record field of a record whose
   * own data has just landed — the ids they point at are known now, and the spec
   * has these load on their own rather than waiting for an expansion. A field
   * whose records point at *different* records has no one preview to show. */
  const loadScalarEmbeds = (recordId: string) => {
    const s = get();
    const node = s.records[recordId];
    if (!node) return;
    for (const field of node.fields) {
      if (field.kind !== "scalarLink") continue;
      const value = selectSharedValue(s, recordId, field.column);
      if (!isShared(value) || value == null || value === "") continue;
      const id = scalarChildId(recordId, field.key);
      if (s.embeds[id]) continue;
      void loadEmbed(id, field.table, [{ column: field.keyColumn, value }]);
    }
  };

  /** Loads a node's own data — every field's value, every referencing field's
   * count, for every record it stands for — in one query, and folds it in
   * positionally (the query's display columns are the node's key columns, then
   * one per field, in order).
   *
   * The rows come back in the database's own order, so each is matched to its
   * record by the key columns the query carries for exactly that purpose. A
   * record with no row is one that isn't in the database any more, which is a
   * form that can't be trusted to edit anything — so it's reported rather than
   * quietly left out. */
  const loadRecord = async (id: string) => {
    const node = get().records[id];
    if (!node || node.status === "loading") return;
    if (node.fields.length === 0) {
      patchRecord(id, { status: "loaded" });
      return;
    }
    const keys = node.keys;
    const keyWidth = keys[0]?.length ?? 0;
    const token = ++tokenSeq;
    tokens.set(id, token);
    patchRecord(id, { status: "loading", error: null });
    try {
      const rows = await runRecordQuery(
        recordDataQuery(node.table, node.fields, keys),
        opts.schemaJson,
      );
      if (tokens.get(id) !== token) return;
      const byKey = new Map(
        rows.map((row) => [keySignature(row.slice(0, keyWidth)), row]),
      );
      const matched = keys.map((key) =>
        byKey.get(keySignature(key.map((part) => part.value))),
      );
      if (matched.some((row) => row === undefined)) {
        patchRecord(id, {
          status: "error",
          error:
            keys.length === 1
              ? "This record no longer exists."
              : "Some of these records no longer exist.",
        });
        return;
      }
      set((s) => {
        const n = s.records[id];
        if (!n) return;
        n.fields.forEach((field, i) => {
          const cells = matched.map((row) => row?.[keyWidth + i] ?? null);
          if (field.kind === "multiRecord") {
            n.counts[field.key] = cells.map((c) => Number(c ?? 0) || 0);
          } else {
            n.values[field.column] = cells;
            n.original[field.column] = [...cells];
          }
        });
        n.status = "loaded";
      });
      loadScalarEmbeds(id);
    } catch (err) {
      if (tokens.get(id) !== token) return;
      patchRecord(id, { status: "error", error: errorMessage(err) });
    }
  };

  /** Loads the records behind a multi-record field: one query for all of them,
   * across every base record the form is on, carrying each record's key, the
   * preview its embedded record shows and every column of its table — so the
   * list renders in full from a single request.
   *
   * Those records become the field's *rows* by grouping (`childGroups.ts`): one
   * row per thing said, however many of the base records say it. Each row is
   * otherwise unloaded until the user expands it. */
  const loadChildren = async (
    recordId: string,
    field: MultiRecordField,
    parents: readonly string[],
  ) => {
    const id = listId(recordId, field.key);
    const token = ++tokenSeq;
    tokens.set(id, token);
    patchList(id, { status: "loading", error: null });
    try {
      const spec = specFor(field.table, field.column);
      const columns = columnsOf(field.table);
      const rows = await runRecordQuery(
        childRecordsQuery(field, parents, spec, columns),
        opts.schemaJson,
      );
      if (tokens.get(id) !== token) return;
      const groups = groupChildRows(rows, {
        keyColumns: field.keyColumns,
        previewWidth: spec.display.length,
        columns,
        linkColumn: field.column,
      });
      // One write for the whole list, rather than one per row.
      set((s) => {
        const childIds: string[] = [];
        groups.forEach((group, index) => {
          const child = childId(id, index);
          // The column tying each of a row's records to its own base record is
          // hidden inside the child's own form (spec: "Progressive expansion"),
          // so nothing will ever load it — and the row needs it, to say how many
          // records each base record has. It's seeded from the load instead.
          const node = recordNode(
            field.table,
            group.keys,
            [field.column],
            "unloaded",
          );
          node.values[field.column] = [...group.links];
          node.original[field.column] = [...group.links];
          s.records[child] = castDraft(node);
          s.embeds[child] = castDraft({
            status: "loaded",
            cells:
              group.cells.length > 0
                ? group.cells
                : (group.keys[0] ?? []).map((p) => p.value),
          });
          childIds.push(child);
        });
        const list = s.lists[id];
        if (!list) return;
        // A record the user began creating before the list arrived belongs to
        // the list too — it keeps its place at the top rather than being
        // overwritten by what came back.
        const created = list.childIds.filter(
          (child) => s.records[child]?.isNew,
        );
        list.status = "loaded";
        list.childIds = [...created, ...childIds];
      });
      // What came back may be fewer records than the counts said (a base record
      // the field is empty for), or more rows than one apiece.
      recountField(recordId, field);
    } catch (err) {
      if (tokens.get(id) !== token) return;
      patchList(id, { status: "error", error: errorMessage(err) });
    }
  };

  /** Creates and loads the record behind a scalar linked record field, once. The
   * records the form is on have to agree on which one that is, which is what
   * `beyondBulk` guards at every way in. */
  const ensureScalarChild = (recordId: string, field: ScalarLinkField) => {
    const id = scalarChildId(recordId, field.key);
    if (get().records[id]) return;
    const value = selectSharedValue(get(), recordId, field.column);
    if (!isShared(value) || value == null || value === "") return;
    addRecord(
      id,
      field.table,
      [[{ column: field.keyColumn, value }]],
      [],
      "unloaded",
    );
    void loadRecord(id);
  };

  /** Creates and loads a multi-record field's child list, once. Records with no
   * id of their own (ones the form is creating) have nothing to fetch, but the
   * list is made all the same: records can be added to it. */
  const ensureList = (recordId: string, field: MultiRecordField) => {
    const id = listId(recordId, field.key);
    const s = get();
    if (s.lists[id]) return;
    const parents = parentValues(recordId);
    // Every base record brings its own records, and the counts say how many are
    // coming — an upper bound on the rows, some of which may turn out to be the
    // same row.
    const expected = (s.records[recordId]?.counts[field.key] ?? []).reduce(
      (total, count) => total + count,
      0,
    );
    set((draft) => {
      draft.lists[id] = {
        status: parents.length === 0 ? "loaded" : "unloaded",
        error: null,
        expected,
        childIds: [],
        removed: [],
        dirty: false,
      };
    });
    if (parents.length > 0) void loadChildren(recordId, field, parents);
  };

  /** Fetches the records a multi-record field holds *only so they can be
   * deleted*: clearing a field the user never opened still has to name every
   * record it stood for when the form is saved. Nothing here is rendered — the
   * list is already empty on screen — so only the keys matter.
   *
   * Tracked in {@link pendingRemovals} because a save made before this lands
   * would otherwise write a deletion it can't name. */
  const loadRemovedChildren = async (
    recordId: string,
    field: MultiRecordField,
    parents: readonly string[],
  ) => {
    const id = listId(recordId, field.key);
    try {
      const spec = specFor(field.table, field.column);
      const columns = columnsOf(field.table);
      const rows = await runRecordQuery(
        childRecordsQuery(field, parents, spec, columns),
        opts.schemaJson,
      );
      set((s) => {
        const groups = groupChildRows(rows, {
          keyColumns: field.keyColumns,
          previewWidth: spec.display.length,
          columns,
          linkColumn: field.column,
        });
        const ids = groups.map((group, index) => {
          const child = deletedChildId(id, index);
          s.records[child] = castDraft(
            recordNode(field.table, group.keys, [field.column], "unloaded"),
          );
          return child;
        });
        const list = s.lists[id];
        if (list) list.removed = [...list.removed, ...ids];
      });
    } catch (err) {
      patchList(id, { status: "error", error: errorMessage(err) });
    }
  };

  /** The records of `childRecordIds` that the database actually holds — the ones
   * a save has to delete. A record the form created and the user then dropped
   * never reached it. */
  const deletable = (childRecordIds: readonly string[]): string[] => {
    const { records } = get();
    return childRecordIds.filter((child) => {
      const node = records[child];
      return (
        node !== undefined &&
        !node.isNew &&
        node.keys.some((key) => key.length > 0)
      );
    });
  };

  /** Drops records from a multi-record field — in the form only, until it's
   * saved. The field's count comes down with them, so the badge keeps saying
   * what the form actually holds. */
  const removeChildren = (
    recordId: string,
    field: MultiRecordField,
    childRecordIds: readonly string[],
  ) => {
    const id = listId(recordId, field.key);
    const list = get().lists[id];
    if (!list) return;
    const remaining = list.childIds.filter(
      (child) => !childRecordIds.includes(child),
    );
    if (remaining.length === list.childIds.length) return;
    patchList(id, {
      expected: remaining.length,
      childIds: remaining,
      removed: [...list.removed, ...deletable(childRecordIds)],
      dirty: true,
    });
    // A row taken out takes every record it stood for with it, so the counts
    // come down by that much — one base record's by more than another's, when
    // the row was not the same size for both.
    recountField(recordId, field);
    deselect(childRecordIds);
  };

  // ── Saving ─────────────────────────────────────────────────────────────────
  //
  // The plan (what to send) is worked out in `formSave.ts`; what's here is what
  // to do with the answer. A successful save makes the database and the form
  // agree, so the form takes what came back as its new baseline: nothing is
  // modified any more, records that were being created are records, and records
  // that were removed are gone.

  /** The key of a record the database has just issued one for: the `index`th of
   * however many records the node stands for. */
  const keyOf = (node: RecordNode, index: number): RecordKey => {
    const table = opts.tables.find((t) => t.name === node.table);
    const columns = table ? identifyingColumns(table) : [];
    return columns.map((column) => ({
      column,
      value: node.values[column]?.[index] ?? "",
    }));
  };

  /** Folds one saved record's returned row back into its node, at the record the
   * operation was for. What the user typed stays as they typed it: the row is
   * the same value in the database's own spelling (a timestamp as a count of
   * microseconds, say), and swapping that in would read as the save having
   * changed what they wrote. Everything the form *didn't* have — the id of a
   * record just created, a column the database defaulted — is taken from the
   * row. */
  const applyRow = (
    recordId: string,
    index: number,
    row: Record<string, unknown> | undefined,
  ) =>
    set((s) => {
      const n = s.records[recordId];
      if (!n) return;
      for (const [column, value] of Object.entries(row ?? {})) {
        const current = n.values[column]?.[index];
        if (current == null || current === "") {
          const values = [...(n.values[column] ?? n.keys.map(() => null))];
          values[index] = cellText(value);
          n.values[column] = values;
        }
      }
      // Saved is the new baseline: nothing in this record is modified now.
      for (const column of Object.keys(n.values)) {
        n.original[column] = [...n.values[column]];
      }
    });

  const applySave = (plan: SavePlan, result: DmlResult) => {
    for (const [opId, target] of plan.saved) {
      applyRow(target.recordId, target.index, result[opId]);
    }
    // The records that were being created are records now, each keyed by what
    // the database issued for it — which is why this waits until every returned
    // row above has been folded in.
    //
    // They have never had a preview either, having rendered as "New" until now.
    // A row standing for several records gets one preview, all of them saying
    // the same thing.
    for (const recordId of plan.created) {
      set((s) => {
        const n = s.records[recordId];
        if (!n) return;
        n.isNew = false;
        n.keys = castDraft(n.keys.map((_, index) => keyOf(n, index)));
      });
      const node = get().records[recordId];
      const key = node?.keys[0];
      if (node && key && key.length > 0) {
        void loadEmbed(recordId, node.table, key, node.hidden[0]);
      }
    }
    set((s) => {
      // A deleted record leaves nothing behind — not its node, not the preview
      // that stood for it (which a child record keeps under the same id).
      for (const recordId of plan.deleted) {
        delete s.records[recordId];
        delete s.embeds[recordId];
      }
      // Every list is in step with the database now: nothing pending to delete,
      // no membership change left unwritten.
      for (const list of Object.values(s.lists)) {
        list.removed = [];
        list.dirty = false;
      }
    });
  };

  // ── Focus and selection ────────────────────────────────────────────────────

  const deselect = (ids: readonly string[]) =>
    set((s) => {
      const next = s.selection.filter((id) => !ids.includes(id));
      if (next.length !== s.selection.length) s.selection = next;
    });

  const clearSelection = () => {
    if (get().selection.length > 0) {
      set((s) => {
        s.selection = [];
      });
    }
    anchor = null;
  };

  /** Brings the selection in line with wherever focus has just been *moved* —
   * an embedded record becomes the selection, anything else clears it.
   *
   * Only programmatic moves (the keyboard) go through here. A click doesn't:
   * its modifiers decide the selection, in `clickEmbedded`, which runs after the
   * mousedown that focused the widget — so a Ctrl+Click has to find the existing
   * selection intact to add to it. */
  const syncSelectionToFocus = () => {
    const active = document.activeElement;
    const item =
      active instanceof HTMLElement
        ? active.closest<HTMLElement>("[data-form-item]")
        : null;
    const id = item?.dataset.itemId;
    if (item && id !== undefined && item.dataset.selectable !== undefined) {
      set((s) => {
        s.selection = [id];
      });
      anchor = id;
    } else {
      clearSelection();
    }
  };

  /** After an item collapses, whatever was focused inside it is gone. Move focus
   * to the item the user acted on, so the keyboard doesn't fall out of the
   * form. Deferred a tick, since the subtree unmounts as this returns. */
  const reconcileFocus = (fallbackItemId: string) => {
    queueMicrotask(() => {
      const { focused } = get();
      if (!root || focused === null) return;
      if (itemElement(root, focused)) return;
      focusItem(root, fallbackItemId);
    });
  };

  const setExpandedItem = (itemId: string, open: boolean) => {
    set((s) => {
      s.expanded[itemId] = open;
    });
    if (!open) reconcileFocus(itemId);
  };

  /** The items a keyboard command acts on: the selection, or — with nothing
   * selected — whatever is focused. */
  const actionTargets = (): string[] => {
    const { selection, focused } = get();
    return selection.length > 0
      ? [...selection]
      : focused !== null
        ? [focused]
        : [];
  };

  const model: RecordFormModel = {
    store,
    start: () => {
      if (started) return;
      started = true;
      void loadRecord(ROOT_ID);
    },
    getSummary: () => selectFormSummary(get()),
    dispose: () => {
      tokens.clear();
      items.clear();
      root = undefined;
    },

    clearSaveError: () =>
      set((s) => {
        s.saveError = null;
      }),

    previewSpec: specFor,

    setRoot: (el) => {
      root = el;
    },

    toggleField: (recordId, field, open) => {
      const itemId = fieldItemId(recordId, field.key);
      const expanded = get().expanded[itemId] === true;
      const next = open ?? !expanded;
      if (next === expanded) return;
      // There's nothing under a field the form can't reach across the records
      // it's on — no one linked record, no one list of children — so it doesn't
      // open. (Closing one always works, whatever it holds.)
      if (next && beyondBulk(recordId, field)) return;
      setExpandedItem(itemId, next);
      if (!next) return;
      if (field.kind === "scalarLink") ensureScalarChild(recordId, field);
      else if (field.kind === "multiRecord") ensureList(recordId, field);
    },
    toggleChild: (id, open) => {
      const expanded = get().expanded[id] === true;
      const next = open ?? !expanded;
      if (next === expanded) return;
      setExpandedItem(id, next);
      if (next && get().records[id]?.status === "unloaded") void loadRecord(id);
    },
    toggleSiblings: (itemId, open) => {
      const group = items.get(itemId)?.group;
      if (group === undefined) return;
      for (const [, handle] of items) {
        // Opening reaches only the siblings that have something to open;
        // closing reaches all of them.
        if (handle.group !== group) continue;
        if (open && !handle.expandable()) continue;
        handle.setExpanded(open);
      }
    },

    beginEdit: (recordId, fieldKey, options) => {
      // A primary key is issued by the database, never typed by the user —
      // the one field kind this can't open an editor on.
      const field = selectFieldOf(get(), recordId, fieldKey);
      if (field?.kind === "primitive" && field.readOnly) return;
      // A field the records disagree on has no value to start the edit from;
      // it shows "(varied)" and stays as it is.
      if (field && beyondBulk(recordId, field)) return;
      // Adding a timestamp starts from now, rather than blank — a blank one is
      // no more likely to be right than the moment the user opened it, and is
      // more keystrokes away from it.
      if (
        field?.kind === "primitive" &&
        field.valueType === "timestamp" &&
        (selectSharedValue(get(), recordId, field.column) ?? null) === null
      ) {
        setColumn(recordId, field.column, formatCurrentTimestamp());
      }
      set((s) => {
        s.editing = fieldItemId(recordId, fieldKey);
        s.editingSelectAll = options?.selectAll ?? false;
      });
    },
    beginEditAtFocused: (selectAll) => {
      const id = get().focused;
      if (id === null) return;
      items.get(id)?.beginEdit?.(selectAll);
    },
    editValue: (recordId, column, value) => setColumn(recordId, column, value),
    commitEdit: (recordId, column, value) => {
      const field = get().records[recordId]?.fields.find(
        (f) => f.kind !== "multiRecord" && f.column === column,
      );
      const nonNullableText =
        field?.kind === "primitive" &&
        field.valueType === "text" &&
        !field.nullable;
      setColumn(
        recordId,
        column,
        value === "" && !nonNullableText ? null : value,
      );
      set((s) => {
        s.editing = null;
      });
    },

    save: async () => {
      if (get().saving) return;
      set({ saving: true, saveError: null });
      try {
        // A field cleared while collapsed is still fetching the records it has
        // to delete; this request is what they're for, so it waits for them.
        if (pendingRemovals.size > 0) await Promise.all([...pendingRemovals]);
        const s = get();
        const plan = planSave({
          record: (id) => s.records[id],
          list: (id) => s.lists[id],
        });
        if (plan.operations.length > 0) {
          const runDml = opts.runDml ?? ((operations) => dml({ operations }));
          applySave(plan, await runDml(plan.operations));
        }
        set({ saving: false, saveError: null });
      } catch (err) {
        // The form keeps everything it failed to write, so the user can act on
        // what the message says and save again.
        set({ saving: false, saveError: errorMessage(err) });
      }
    },

    reset: () => {
      if (get().saving) return;
      anchor = null;
      set(rootState());
      started = true;
      void loadRecord(ROOT_ID);
    },

    registerItem: (itemId, handle) => {
      items.set(itemId, handle);
    },
    unregisterItem: (itemId) => {
      items.delete(itemId);
    },

    noteFocus: (itemId) =>
      set((s) => {
        s.focused = itemId;
      }),
    noteBlur: () => {
      set((s) => {
        s.focused = null;
      });
      clearSelection();
    },
    focusItem: (itemId) => {
      if (!root) return;
      focusItem(root, itemId);
      syncSelectionToFocus();
    },
    focusAdjacent: (forward) => {
      if (!root || !focusAdjacentItem(root, forward)) return false;
      syncSelectionToFocus();
      return true;
    },

    clickEmbedded: (itemId, mods) => {
      const s = get();
      const group = items.get(itemId)?.group;
      const siblings = group ? (s.lists[group]?.childIds ?? []) : [];
      if (mods.shift && anchor !== null && siblings.includes(anchor)) {
        // Grow a range from the anchor, within this one list.
        const from = siblings.indexOf(anchor);
        const to = siblings.indexOf(itemId);
        const [lo, hi] = from < to ? [from, to] : [to, from];
        set((draft) => {
          draft.selection = siblings.slice(lo, hi + 1);
        });
      } else if (mods.ctrl) {
        // Toggle this record in/out of the existing selection.
        set((draft) => {
          draft.selection = s.selection.includes(itemId)
            ? s.selection.filter((id) => id !== itemId)
            : [...s.selection, itemId];
        });
        anchor = itemId;
      } else {
        set((draft) => {
          draft.selection = [itemId];
        });
        anchor = itemId;
      }
    },
    clearSelection,

    expandSelection: (open) => {
      for (const itemId of actionTargets()) {
        const handle = items.get(itemId);
        if (!handle) continue;
        if (open && !handle.expandable()) continue;
        handle.setExpanded(open);
      }
    },
    deleteSelection: () => {
      const targets = actionTargets();
      for (const itemId of targets) items.get(itemId)?.remove();
      deselect(targets);
    },

    clearField: (recordId, field) => {
      const itemId = fieldItemId(recordId, field.key);
      // Clearing is a modification like any other, so a field the form can't
      // reach across the records it's on isn't cleared either.
      if (beyondBulk(recordId, field)) return;
      if (field.kind === "multiRecord") {
        const id = listId(recordId, field.key);
        const s = get();
        const list = s.lists[id];
        const children = list?.childIds ?? [];
        const counts = s.records[recordId]?.counts[field.key] ?? [];
        const had = children.length > 0 || counts.some((count) => count > 0);
        setCount(recordId, field.key, 0);
        deselect(children);
        // The deletion is recorded whether or not the list was ever opened: an
        // unopened one is replaced by an empty, *loaded* list, so the records it
        // stood for don't come back when the user expands the field — nor when a
        // load that was already in flight lands (which the new token cancels).
        if (had) {
          tokens.set(id, ++tokenSeq);
          const removed = [...(list?.removed ?? []), ...deletable(children)];
          set((draft) => {
            draft.lists[id] = {
              status: "loaded",
              error: null,
              expected: 0,
              childIds: [],
              removed,
              dirty: true,
            };
          });
          // Clearing a field the user never opened deletes records the form has
          // never seen, so it fetches their keys now — the one thing a save
          // can't work out for itself later. Every base record's, at that: the
          // field was cleared on all of them.
          const parents = parentValues(recordId);
          if (list?.status !== "loaded" && parents.length > 0) {
            const pending = loadRemovedChildren(recordId, field, parents);
            pendingRemovals.add(pending);
            void pending.finally(() => pendingRemovals.delete(pending));
          }
        }
      } else {
        setColumn(recordId, field.column, null);
        if (field.kind === "scalarLink") {
          // The record it pointed at is no longer this field's: its preview and
          // any sub-form the user opened go with the link.
          const id = scalarChildId(recordId, field.key);
          set((s) => {
            delete s.embeds[id];
            delete s.records[id];
          });
        }
      }
      setExpandedItem(itemId, false);
    },
    removeChild: (recordId, field, childRecordId) =>
      removeChildren(recordId, field, [childRecordId]),
    removeChildren,

    openChildRecords: (recordId, field) => {
      // The values the children point back at, exactly as `ensureList` finds
      // them.
      const parents = parentValues(recordId);
      if (parents.length === 0) return;
      opts.openRecords?.(
        childRecordsTabQuery(
          field,
          parents,
          specFor(field.table, field.column),
        ),
      );
    },

    addChild: (recordId, field) => {
      set((s) => {
        s.expanded[fieldItemId(recordId, field.key)] = true;
      });
      ensureList(recordId, field);
      const id = listId(recordId, field.key);
      const list = get().lists[id];
      if (!list) return;
      const child = newChildId(id, ++newSeq);
      // A record can only be filed under one parent, so adding one to a field
      // on several base records adds one to each — a single row saying the same
      // thing about all of them, which is what every other row here is.
      const records = get().records[recordId]?.keys.length ?? 1;
      addNewRecord(child, field.table, [field.column], records);
      patchList(id, {
        childIds: [child, ...list.childIds],
        expected: list.expected + records,
        dirty: true,
      });
      // Adding to a field the user never opened leaves nothing to tally — the
      // counts its own load reported still stand, plus the record just filed
      // under each. The load that is on its way will count the lot.
      if (get().lists[id]?.status === "loaded") recountField(recordId, field);
      else bumpCounts(recordId, field.key, 1);
      set((s) => {
        s.expanded[child] = true;
      });
      activateNewRecord(child);
    },
    addLinkedRecord: (recordId, field, seed) => {
      if (beyondBulk(recordId, field)) return;
      const id = scalarChildId(recordId, field.key);
      // Whatever the field pointed at before, it points at this new record now.
      set((s) => {
        delete s.embeds[id];
        delete s.records[id];
      });
      setColumn(recordId, field.column, null);
      addNewRecord(id, field.table, []);
      set((s) => {
        s.expanded[fieldItemId(recordId, field.key)] = true;
      });
      activateNewRecord(id, seed);
    },

    openMenu: (menu) =>
      set((s) => {
        s.menu = castDraft(menu);
      }),
    closeMenu: () =>
      set((s) => {
        s.menu = null;
      }),

    openPicker: (recordId, fieldKey) => {
      const field = selectFieldOf(get(), recordId, fieldKey);
      if (field && beyondBulk(recordId, field)) return;
      // The picker is often reached *from* the field's context menu, and takes
      // the keyboard from it.
      set((s) => {
        s.menu = null;
        s.picker = { recordId, fieldKey };
      });
    },
    closePicker: () =>
      set((s) => {
        s.picker = null;
      }),
    pickRecord: (recordId, field, keyValue, cells) => {
      const id = scalarChildId(recordId, field.key);
      // The record the field pointed at before is not this one: its preview and
      // any sub-form the user had opened under it go, and a preview load still
      // in flight for it is cancelled (its token is spent) so it can't land on
      // top of the one the picker just handed over.
      set((s) => {
        delete s.embeds[id];
        delete s.records[id];
        s.expanded[fieldItemId(recordId, field.key)] = false;
      });
      tokens.set(id, ++tokenSeq);
      // Every record the form is on comes to point at the picked one.
      setColumn(recordId, field.column, keyValue);
      set((s) => {
        s.embeds[id] = castDraft({ status: "loaded", cells });
        s.picker = null;
      });
    },
  };

  return model;
}
