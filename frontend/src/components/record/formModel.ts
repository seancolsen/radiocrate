// The record editor form's reactive state: what's loaded, what's loading, what's
// expanded, what's focused or selected, which field is being edited — and, since
// nothing here is written to the database until the user saves, everything the
// user has changed.
//
// The form is a tree that grows as the user opens it — a scalar linked record
// field expands into another record's whole form, a multi-record field into a
// list of records that each expand the same way, with no bound on the depth. So
// rather than a nested store (whose paths would have to be walked and spliced at
// every level), nodes live in three **flat, id-keyed maps**: `records` (one
// record's fields and values), `lists` (one multi-record field's children), and
// `embeds` (the preview cells behind one embedded record). Ids encode the path —
// see `formIds.ts` — which makes every update a single-key write and makes a
// node's identity stable across collapse/expand.
//
// Loading is lazy and idempotent: expanding an item fetches its data the first
// time only, and collapsing keeps it. Each fetch is guarded by a token so a
// superseded load (expand, collapse, expand again) can't overwrite a newer one.
//
// Two things about the form are *not* stored here, because the DOM already holds
// them better: which element has focus (see `formNav.ts` — document order is the
// order the user moves through), and how an item expands or deletes itself
// (`registerItem` — each rendered row hands the model a closure over its own
// props). What the model keeps is the id of the focused item, which is what
// decides where a keyboard command lands.
//
// Saving reverses the whole arrangement: `formSave.ts` reads this tree and
// writes the DML request that puts it in the database, and what comes back
// becomes the new baseline (`applySave`).

import { untrack } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { dml, type DmlResult } from "api-client";
import {
  identifyingColumns,
  primaryKey,
  type SchemaTable,
} from "../../query/schema";
import {
  buildFormFields,
  recordDataQuery,
  type FormField,
  type KeyPart,
  type MultiRecordField,
  type ScalarLinkField,
} from "../../query/recordForm";
import {
  childRecordsQuery,
  embeddedRecordQuery,
  embedSpec,
  type EmbedSpec,
} from "../../query/embeddedRecord";
import { runRecordQuery } from "../../query/recordData";
import { focusAdjacentItem, focusItem, itemElement } from "./formNav";
import {
  childId,
  deletedChildId,
  fieldItemId,
  listId,
  newChildId,
  ROOT_ID,
  scalarChildId,
} from "./formIds";
import { planSave, type SavePlan } from "./formSave";

// The ids are the model's own vocabulary, so callers reach them through it.
export { fieldItemId, listId, ROOT_ID, scalarChildId } from "./formIds";

/** Where a node is in its load cycle. `unloaded` means "known to exist, nothing
 * fetched yet" — a child record listed under a multi-record field before it's
 * been expanded. */
export type LoadStatus = "unloaded" | "loading" | "loaded" | "error";

/** One record's form: its identity, its fields, and whatever has been loaded
 * into them. */
export interface RecordNode {
  table: string;
  /** The column/value pairs identifying this record. */
  key: readonly KeyPart[];
  /** Columns hidden as this record's contextual filter (see `buildFormFields`). */
  hidden: readonly string[];
  fields: readonly FormField[];
  status: LoadStatus;
  error: string | null;
  /** Column → current value. Seeded with the key, which is known before any
   * fetch — the id renders while the rest of the form is still loading. */
  values: Record<string, string | null>;
  /** Column → the value the database last gave us, which is what makes an edit
   * detectable: a column whose `values` entry has drifted from its `original` is
   * modified, and that's what the red star is drawn from. Written only by a load
   * or a save — never by an edit. */
  original: Record<string, string | null>;
  /** Referencing field key (`#credit`) → count of related records. */
  counts: Record<string, number>;
  /** Whether this record is being *created* by the form rather than edited: it
   * has no key, nothing to load, and counts as modified in its entirety. */
  isNew: boolean;
}

/** The children of one expanded multi-record field. */
export interface ListNode {
  status: LoadStatus;
  error: string | null;
  /** The related-record count known from the parent's load — how many
   * placeholders to render while the children themselves are in flight. */
  expected: number;
  childIds: string[];
  /** The records the user has taken out of the list, kept — with their keys —
   * because they're still in the database until the form is saved, and the save
   * has to name them to delete them. Records the form itself created never get
   * here: they had nothing to delete. */
  removed: string[];
  /** Whether the list's *membership* has been edited (a record added or
   * removed). The records themselves report their own edits; this is the change
   * that belongs to no single one of them. */
  dirty: boolean;
}

/** One embedded record's preview: the cells the widget lays out. */
export interface EmbedNode {
  status: LoadStatus;
  /** Positionally matching the display columns of the spec it was fetched with. */
  cells: readonly (string | null)[];
}

/** What a context menu was raised on. A field's own menu ({@link FormMenu}) is
 * the same whether the user came at it through the label or the value; the other
 * two are the menus of the *records* a field holds. */
export type MenuTarget =
  /** A field, of whichever kind — which is what decides the menu's entries. */
  | { kind: "field"; recordId: string; fieldKey: string }
  /** The embedded record previewing a scalar linked record field's target. */
  | { kind: "scalarEmbed"; recordId: string; fieldKey: string }
  /** Records within a multi-record field: the one the menu was raised on, or
   * the whole selection when that record is part of it. */
  | {
      kind: "childRecords";
      recordId: string;
      fieldKey: string;
      ids: readonly string[];
    };

/** An open context menu: what it acts on, and where it was raised. */
export interface FormMenu {
  target: MenuTarget;
  x: number;
  y: number;
}

/** The scalar linked record field the modal record picker is open for. */
export interface PickerTarget {
  recordId: string;
  fieldKey: string;
}

interface FormState {
  records: Record<string, RecordNode>;
  lists: Record<string, ListNode>;
  embeds: Record<string, EmbedNode>;
  /** Item id → whether it's expanded. Absent reads as collapsed: everything
   * starts closed. */
  expanded: Record<string, boolean>;
  /** The one field in edit mode (`<recordId>:<fieldKey>`), or null. */
  editing: string | null;
  /** The item id holding focus within this form, or null when focus is
   * elsewhere. */
  focused: string | null;
  /** The selected embedded records (only ever members of a multi-record field),
   * in click order. */
  selection: string[];
  /** The one open context menu within this form, or null. */
  menu: FormMenu | null;
  /** The field whose modal record picker is open, or null. */
  picker: PickerTarget | null;
  /** Whether a save is in flight. */
  saving: boolean;
  /** Why the last save failed, or null. The form keeps the changes it couldn't
   * write, so the user can fix what the message says and try again. */
  saveError: string | null;
}

/** What a rendered row can do to itself, handed to the model when it mounts so
 * that a keyboard command — which knows only an item id — can act on it. */
export interface ItemHandle {
  /** The id whose items are this one's siblings: its record, for a field; its
   * list, for a record within a multi-record field. */
  group: string;
  /** Whether the item has anything to expand right now. */
  expandable: () => boolean;
  setExpanded: (open: boolean) => void;
  /** The "Selection: Delete" action for this item — ephemeral, like every other
   * form modification. */
  remove: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The value that removes an id-keyed entry from the store: Solid deletes a
 * property assigned `undefined`, which its (non-optional) types can't say. */
function dropped<T>(): T {
  return undefined as unknown as T;
}

/** The reactive form for one record. Created per record the sidebar points at
 * (re-pointing it builds a new one), and it starts loading immediately. */
export interface RecordFormModel {
  /** A record node by id — `undefined` before it exists (nothing expanded yet). */
  record: (id: string) => RecordNode | undefined;
  /** A child list by id, likewise. */
  list: (id: string) => ListNode | undefined;
  /** An embedded record's preview by id, likewise. */
  embed: (id: string) => EmbedNode | undefined;
  /** Whether an item (field or child record) is expanded. */
  isExpanded: (itemId: string) => boolean;
  /** The field in edit mode, or null. */
  editing: () => string | null;
  /** The item holding focus within the form, or null. */
  focused: () => string | null;
  /** The selected embedded records. */
  selection: () => readonly string[];
  isSelected: (itemId: string) => boolean;
  /** The open context menu, or null. */
  menu: () => FormMenu | null;
  /** The field whose modal record picker is open, or null. */
  picker: () => PickerTarget | null;
  /** Whether a save is in flight. */
  saving: () => boolean;
  /** Why the last save failed, or null. */
  saveError: () => string | null;
  /** Dismiss the save-error message, leaving the unsaved changes it was about
   * in place. */
  clearSaveError: () => void;

  /** The preview columns (and their ordering) generated for one table — what the
   * record picker's display and sort builders open pre-filled with. */
  previewSpec: (table: string, contextColumn?: string) => EmbedSpec;

  /** Whether one field carries an unsaved edit — its own, or one anywhere in
   * what it expands into. What the red star is drawn from. */
  isFieldModified: (recordId: string, fieldKey: string) => boolean;
  /** Whether one record carries an unsaved edit, at any depth. */
  isRecordModified: (recordId: string) => boolean;
  /** Whether the form as a whole has unsaved changes. */
  isModified: () => boolean;
  /** Whether a scalar linked record field has a record to show: one it points
   * at, or a new one the user is entering into it. */
  hasLinkedRecord: (recordId: string, field: ScalarLinkField) => boolean;

  /** The form's root element, set once it's rendered — how the model reaches the
   * DOM to move focus. */
  setRoot: (el: HTMLElement) => void;

  /** Expand/collapse a field, loading its data the first time it opens. */
  toggleField: (recordId: string, field: FormField, open?: boolean) => void;
  /** Expand/collapse a child record within a multi-record field, loading its
   * data the first time it opens. */
  toggleChild: (id: string, open?: boolean) => void;
  /** Expand/collapse every item alongside this one — Ctrl+Click on a toggle. */
  toggleSiblings: (itemId: string, open: boolean) => void;

  /** Put a field into edit mode (its value becomes an input). */
  beginEdit: (recordId: string, fieldKey: string) => void;
  /** Take what's in the activated input as the field's value, without leaving
   * edit mode — called on every keystroke, so the form (and its modification
   * stars) track what the user is typing as they type it. */
  editValue: (recordId: string, column: string, value: string) => void;
  /** Leave edit mode, keeping `value` as the field's current (in-memory) value —
   * which stays in memory until {@link RecordFormModel.save}. */
  commitEdit: (recordId: string, column: string, value: string) => void;

  /** Write everything the user has changed to the database, in one DML request:
   * every edited value, every record created, every record removed. On success
   * the form stays open on what it just saved; on failure it keeps the changes
   * and reports why (see {@link RecordFormModel.saveError}). */
  save: () => Promise<void>;

  /** Discard every unsaved change — every edited value, every record created
   * or removed — and reload the record as it stands in the database. The
   * toolbar's "Reset" button, live only while
   * {@link RecordFormModel.isModified} is true. */
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
   * type straight into it. */
  addChild: (recordId: string, field: MultiRecordField) => void;
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

export function createRecordForm(opts: {
  tables: readonly SchemaTable[];
  table: string;
  key: readonly KeyPart[];
  schemaJson: string;
}): RecordFormModel {
  const [state, setState] = createStore<FormState>({
    records: {},
    lists: {},
    embeds: {},
    expanded: {},
    editing: null,
    focused: null,
    selection: [],
    menu: null,
    picker: null,
    saving: false,
    saveError: null,
  });

  // Per-node load tokens: only the newest load for a node may write its result.
  const tokens = new Map<string, number>();
  /** Fetches of records that a *save* has to delete (see
   * `loadRemovedChildren`), which is why a save waits for them. */
  const pendingRemovals = new Set<Promise<void>>();
  let tokenSeq = 0;
  /** Distinguishes the records the form creates, whose ids can't come from a
   * position in a loaded list. */
  let newSeq = 0;

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
    const cacheKey = `${table} ${contextColumn ?? ""}`;
    let spec = specs.get(cacheKey);
    if (!spec) {
      spec = embedSpec(opts.tables, table, contextColumn);
      specs.set(cacheKey, spec);
    }
    return spec;
  };

  /** Seeds `values` with the key columns — the part of a record we know without
   * asking the backend, and the only thing rendered while its load is in
   * flight. */
  const seedValues = (key: readonly KeyPart[]): Record<string, string | null> =>
    Object.fromEntries(key.map((p) => [p.column, p.value]));

  const addRecord = (
    id: string,
    table: string,
    key: readonly KeyPart[],
    hidden: readonly string[],
    status: LoadStatus,
  ) => {
    setState("records", id, {
      table,
      key,
      hidden,
      fields: buildFormFields(opts.tables, table, hidden),
      status,
      error: null,
      values: seedValues(key),
      original: seedValues(key),
      counts: {},
      isNew: false,
    });
  };

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
  ) => {
    const fields = buildFormFields(opts.tables, table, hidden);
    const values: Record<string, string | null> = {};
    const counts: Record<string, number> = {};
    for (const field of fields) {
      if (field.kind === "multiRecord") counts[field.key] = 0;
      else values[field.column] = null;
    }
    setState("records", id, {
      table,
      key: [],
      hidden,
      fields,
      status: "loaded",
      error: null,
      values,
      original: { ...values },
      counts,
      isNew: true,
    });
  };

  /** The first field of a record the user can type into — where the caret goes
   * when a new record is scaffolded. Skips the table's primary key, which the
   * database issues rather than the user. `preferText` picks the first *text*
   * field instead, which is where a seed value goes: prose is the only kind of
   * field a search box's contents are a plausible draft of. */
  const firstEditableField = (
    recordId: string,
    preferText = false,
  ): FormField | undefined => {
    const node = state.records[recordId];
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
      setState("records", recordId, "values", field.column, seed);
    }
    setState("editing", fieldItemId(recordId, field.key));
  };

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
    key: readonly KeyPart[],
    contextColumn?: string,
  ) => {
    const keyCells = key.map((p) => p.value);
    const spec = specFor(table, contextColumn);
    if (spec.display.length === 0) {
      setState("embeds", id, { status: "loaded", cells: keyCells });
      return;
    }
    const token = ++tokenSeq;
    tokens.set(id, token);
    setState("embeds", id, { status: "loading", cells: [] });
    try {
      const rows = await runRecordQuery(
        embeddedRecordQuery(table, key, spec),
        opts.schemaJson,
      );
      if (tokens.get(id) !== token) return;
      setState("embeds", id, { status: "loaded", cells: rows[0] ?? keyCells });
    } catch (err) {
      if (tokens.get(id) !== token) return;
      console.error("embedded record preview failed", errorMessage(err));
      setState("embeds", id, { status: "error", cells: keyCells });
    }
  };

  /** Kicks off the preview of every scalar linked record field of a record whose
   * own data has just landed — the ids they point at are known now, and the spec
   * has these load on their own rather than waiting for an expansion. */
  const loadScalarEmbeds = (recordId: string) => {
    const node = state.records[recordId];
    if (!node) return;
    for (const field of node.fields) {
      if (field.kind !== "scalarLink") continue;
      const value = node.values[field.column];
      if (value == null || value === "") continue;
      const id = scalarChildId(recordId, field.key);
      if (state.embeds[id]) continue;
      void loadEmbed(id, field.table, [{ column: field.keyColumn, value }]);
    }
  };

  /** Loads one record's own data — every field's value, every referencing
   * field's count — and folds it in positionally (the query's display columns
   * are generated from `fields`, in order). */
  const loadRecord = async (id: string) => {
    const node = state.records[id];
    if (!node || node.status === "loading") return;
    if (node.fields.length === 0) {
      setState("records", id, "status", "loaded");
      return;
    }
    const token = ++tokenSeq;
    tokens.set(id, token);
    setState("records", id, { status: "loading", error: null });
    try {
      const rows = await runRecordQuery(
        recordDataQuery(node.table, node.fields, node.key),
        opts.schemaJson,
      );
      if (tokens.get(id) !== token) return;
      const row = rows[0];
      if (!row) {
        setState("records", id, {
          status: "error",
          error: "This record no longer exists.",
        });
        return;
      }
      setState(
        "records",
        id,
        produce((n) => {
          n.fields.forEach((field, i) => {
            const cell = row[i] ?? null;
            if (field.kind === "multiRecord") {
              n.counts[field.key] = Number(cell ?? 0) || 0;
            } else {
              n.values[field.column] = cell;
              n.original[field.column] = cell;
            }
          });
          n.status = "loaded";
        }),
      );
      loadScalarEmbeds(id);
    } catch (err) {
      if (tokens.get(id) !== token) return;
      setState("records", id, { status: "error", error: errorMessage(err) });
    }
  };

  /** Loads the records behind a multi-record field: one query for all of them,
   * carrying both each record's key and the preview its embedded record shows,
   * so the list renders in full from a single request. Each child is otherwise
   * unloaded until the user expands it. */
  const loadChildren = async (
    id: string,
    field: MultiRecordField,
    parentValue: string,
  ) => {
    const token = ++tokenSeq;
    tokens.set(id, token);
    setState("lists", id, { status: "loading", error: null });
    try {
      const spec = specFor(field.table, field.column);
      const rows = await runRecordQuery(
        childRecordsQuery(field, parentValue, spec),
        opts.schemaJson,
      );
      if (tokens.get(id) !== token) return;
      const childIds: string[] = [];
      rows.forEach((row, index) => {
        const key = field.keyColumns.map((column, i) => ({
          column,
          value: row[i] ?? "",
        }));
        const child = childId(id, index);
        // The column tying every child to this parent is the same for all of
        // them — hidden inside the child's own form (spec: "Progressive
        // expansion").
        addRecord(child, field.table, key, [field.column], "unloaded");
        const cells = row.slice(field.keyColumns.length);
        setState("embeds", child, {
          status: "loaded",
          cells: cells.length > 0 ? cells : key.map((p) => p.value),
        });
        childIds.push(child);
      });
      // A record the user began creating before the list arrived belongs to the
      // list too — it keeps its place at the top rather than being overwritten
      // by what came back.
      const created = (state.lists[id]?.childIds ?? []).filter(
        (child) => state.records[child]?.isNew,
      );
      setState("lists", id, {
        status: "loaded",
        childIds: [...created, ...childIds],
      });
    } catch (err) {
      if (tokens.get(id) !== token) return;
      setState("lists", id, { status: "error", error: errorMessage(err) });
    }
  };

  /** Creates and loads the record behind a scalar linked record field, once. */
  const ensureScalarChild = (recordId: string, field: ScalarLinkField) => {
    const id = scalarChildId(recordId, field.key);
    if (state.records[id]) return;
    const value = state.records[recordId]?.values[field.column];
    if (value == null || value === "") return;
    addRecord(
      id,
      field.table,
      [{ column: field.keyColumn, value }],
      [],
      "unloaded",
    );
    void loadRecord(id);
  };

  /** Creates and loads a multi-record field's child list, once. */
  const ensureList = (recordId: string, field: MultiRecordField) => {
    const id = listId(recordId, field.key);
    if (state.lists[id]) return;
    const node = state.records[recordId];
    // Every inferred link points at `<table>.id`, so that — not this record's
    // key, which may be composite — is the value the children carry. A record
    // with no id of its own (one the form is creating) has nothing to fetch, but
    // still gets a list: records can be added to it.
    const parentValue = node?.values["id"] ?? "";
    setState("lists", id, {
      status: parentValue === "" ? "loaded" : "unloaded",
      error: null,
      expected: node?.counts[field.key] ?? 0,
      childIds: [],
      removed: [],
      dirty: false,
    });
    if (parentValue !== "") void loadChildren(id, field, parentValue);
  };

  /** Fetches the records a multi-record field holds *only so they can be
   * deleted*: clearing a field the user never opened still has to name every
   * record it stood for when the form is saved. Nothing here is rendered — the
   * list is already empty on screen — so only the keys matter.
   *
   * Tracked in {@link pendingRemovals} because a save made before this lands
   * would otherwise write a deletion it can't name. */
  const loadRemovedChildren = async (
    id: string,
    field: MultiRecordField,
    parentValue: string,
  ) => {
    try {
      const rows = await runRecordQuery(
        childRecordsQuery(
          field,
          parentValue,
          specFor(field.table, field.column),
        ),
        opts.schemaJson,
      );
      const ids = rows.map((row, index) => {
        const key = field.keyColumns.map((column, i) => ({
          column,
          value: row[i] ?? "",
        }));
        const child = deletedChildId(id, index);
        addRecord(child, field.table, key, [field.column], "unloaded");
        return child;
      });
      setState("lists", id, "removed", (prev) => [...prev, ...ids]);
    } catch (err) {
      setState("lists", id, { status: "error", error: errorMessage(err) });
    }
  };

  /** The records of `childRecordIds` that the database actually holds — the ones
   * a save has to delete. A record the form created and the user then dropped
   * never reached it. */
  const deletable = (childRecordIds: readonly string[]): string[] =>
    childRecordIds.filter((child) => {
      const node = state.records[child];
      return node !== undefined && !node.isNew && node.key.length > 0;
    });

  /** Drops records from a multi-record field — in the form only, until it's
   * saved. The field's count comes down with them, so the badge keeps saying
   * what the form actually holds. */
  const removeChildren = (
    recordId: string,
    field: MultiRecordField,
    childRecordIds: readonly string[],
  ) => {
    const id = listId(recordId, field.key);
    const list = state.lists[id];
    if (!list) return;
    const remaining = list.childIds.filter(
      (child) => !childRecordIds.includes(child),
    );
    if (remaining.length === list.childIds.length) return;
    setState("lists", id, {
      expected: remaining.length,
      childIds: remaining,
      removed: [...list.removed, ...deletable(childRecordIds)],
      dirty: true,
    });
    setState("records", recordId, "counts", field.key, remaining.length);
    deselect(childRecordIds);
  };

  // ── Modification ───────────────────────────────────────────────────────────
  //
  // Nothing is written to the database until the user saves, so "modified" is a
  // question the form answers by comparing what it holds against the baseline it
  // loaded — and by remembering the structural edits that no single value
  // records (a list gaining or losing a record, a record being created).
  //
  // The two functions below recurse into each other, so a field reports the
  // edits made *inside* it as its own: a star on a collapsed field says there's
  // something changed somewhere under it. The recursion only ever visits nodes
  // that exist — what the user has opened — and node ids strictly grow as it
  // descends, so it terminates.
  //
  // A record being *created* counts as modified here — its parent's field (a
  // dirty list, a changed foreign key) is what a star on *that* field means.
  // The record's own star, and its own fields', are a display-layer question:
  // `RecordFields.tsx` suppresses those directly, since a record still being
  // filled in to insert it has nothing of its own to compare against yet.

  const fieldModified = (recordId: string, field: FormField): boolean => {
    const node = state.records[recordId];
    if (!node) return false;
    if (field.kind === "multiRecord") {
      const list = state.lists[listId(recordId, field.key)];
      if (!list) return false;
      return list.dirty || list.childIds.some(recordModified);
    }
    if (node.values[field.column] !== node.original[field.column]) return true;
    if (field.kind !== "scalarLink") return false;
    return recordModified(scalarChildId(recordId, field.key));
  };

  const recordModified = (recordId: string): boolean => {
    const node = state.records[recordId];
    if (!node) return false;
    if (node.isNew) return true;
    return node.fields.some((field) => fieldModified(recordId, field));
  };

  // ── Saving ─────────────────────────────────────────────────────────────────
  //
  // The plan (what to send) is worked out in `formSave.ts`; what's here is what
  // to do with the answer. A successful save makes the database and the form
  // agree, so the form takes what came back as its new baseline: nothing is
  // modified any more, records that were being created are records, and records
  // that were removed are gone.

  /** A returned column as the form holds values — text, or NULL. */
  const cellText = (value: unknown): string | null => {
    if (value == null) return null;
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };

  /** The key of a record the database has just issued one for. */
  const keyOf = (node: RecordNode): KeyPart[] => {
    const table = opts.tables.find((t) => t.name === node.table);
    const columns = table ? identifyingColumns(table) : [];
    return columns.map((column) => ({
      column,
      value: node.values[column] ?? "",
    }));
  };

  /** Folds one saved record's returned row back into its node. What the user
   * typed stays as they typed it: the row is the same value in the database's
   * own spelling (a timestamp as a count of microseconds, say), and swapping
   * that in would read as the save having changed what they wrote. Everything
   * the form *didn't* have — the id of a record just created, a column the
   * database defaulted — is taken from the row. */
  const applyRow = (
    recordId: string,
    row: Record<string, unknown> | undefined,
  ) =>
    setState(
      "records",
      recordId,
      produce((n) => {
        for (const [column, value] of Object.entries(row ?? {})) {
          const current = n.values[column];
          if (current == null || current === "")
            n.values[column] = cellText(value);
        }
        // Saved is the new baseline: nothing in this record is modified now.
        for (const column of Object.keys(n.values)) {
          n.original[column] = n.values[column];
        }
        if (n.isNew) {
          n.isNew = false;
          n.key = keyOf(n);
        }
      }),
    );

  const applySave = (plan: SavePlan, result: DmlResult) => {
    for (const [opId, recordId] of plan.saved) applyRow(recordId, result[opId]);
    // A record that was being created has never had a preview — it rendered as
    // "New". Now that it has a key, it can have one.
    for (const recordId of plan.created) {
      const node = state.records[recordId];
      if (node && node.key.length > 0) {
        void loadEmbed(recordId, node.table, node.key, node.hidden[0]);
      }
    }
    // A deleted record leaves nothing behind — not its node, not the preview
    // that stood for it (which a child record keeps under the same id).
    for (const recordId of plan.deleted) {
      setState("records", recordId, dropped());
      setState("embeds", recordId, dropped());
    }
    // Every list is in step with the database now: nothing pending to delete,
    // no membership change left unwritten.
    for (const id of Object.keys(state.lists)) {
      setState("lists", id, { removed: [], dirty: false });
    }
  };

  // ── Focus and selection ────────────────────────────────────────────────────

  const deselect = (ids: readonly string[]) =>
    setState(
      "selection",
      state.selection.filter((id) => !ids.includes(id)),
    );

  const clearSelection = () => {
    if (state.selection.length > 0) setState("selection", []);
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
      setState("selection", [id]);
      anchor = id;
    } else {
      clearSelection();
    }
  };

  /** After an item collapses, whatever was focused inside it is gone. Move focus
   * to the item the user acted on, so the keyboard doesn't fall out of the
   * form. Deferred a tick, since the subtree unmounts as this returns. */
  const reconcileFocus = (fallbackItemId: string) => {
    queueMicrotask(() =>
      untrack(() => {
        const focused = state.focused;
        if (!root || focused === null) return;
        if (itemElement(root, focused)) return;
        focusItem(root, fallbackItemId);
      }),
    );
  };

  const setExpandedItem = (itemId: string, open: boolean) => {
    setState("expanded", itemId, open);
    if (!open) reconcileFocus(itemId);
  };

  /** The items a keyboard command acts on: the selection, or — with nothing
   * selected — whatever is focused. */
  const actionTargets = (): string[] =>
    state.selection.length > 0
      ? [...state.selection]
      : state.focused !== null
        ? [state.focused]
        : [];

  // The root record exists from the start — its key is known — and its data is
  // fetched right away, under the loading wash.
  addRecord(ROOT_ID, opts.table, opts.key, [], "unloaded");
  untrack(() => void loadRecord(ROOT_ID));

  const model: RecordFormModel = {
    record: (id) => state.records[id],
    list: (id) => state.lists[id],
    embed: (id) => state.embeds[id],
    isExpanded: (itemId) => state.expanded[itemId] === true,
    editing: () => state.editing,
    focused: () => state.focused,
    selection: () => state.selection,
    isSelected: (itemId) => state.selection.includes(itemId),
    menu: () => state.menu,
    picker: () => state.picker,
    saving: () => state.saving,
    saveError: () => state.saveError,
    clearSaveError: () => setState("saveError", null),

    previewSpec: specFor,

    isFieldModified: (recordId, fieldKey) => {
      const field = state.records[recordId]?.fields.find(
        (f) => f.key === fieldKey,
      );
      return field !== undefined && fieldModified(recordId, field);
    },
    isRecordModified: recordModified,
    isModified: () => recordModified(ROOT_ID),
    hasLinkedRecord: (recordId, field) => {
      const value = state.records[recordId]?.values[field.column];
      if (value != null && value !== "") return true;
      return state.records[scalarChildId(recordId, field.key)]?.isNew === true;
    },

    setRoot: (el) => (root = el),

    toggleField: (recordId, field, open) => {
      const itemId = fieldItemId(recordId, field.key);
      const next = open ?? state.expanded[itemId] !== true;
      if (next === (state.expanded[itemId] === true)) return;
      setExpandedItem(itemId, next);
      if (!next) return;
      if (field.kind === "scalarLink") ensureScalarChild(recordId, field);
      else if (field.kind === "multiRecord") ensureList(recordId, field);
    },
    toggleChild: (id, open) => {
      const next = open ?? state.expanded[id] !== true;
      if (next === (state.expanded[id] === true)) return;
      setExpandedItem(id, next);
      if (next && state.records[id]?.status === "unloaded") void loadRecord(id);
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

    beginEdit: (recordId, fieldKey) => {
      // A primary key is issued by the database, never typed by the user —
      // the one field kind this can't open an editor on.
      const field = state.records[recordId]?.fields.find(
        (f) => f.key === fieldKey,
      );
      if (field?.kind === "primitive" && field.readOnly) return;
      setState("editing", fieldItemId(recordId, fieldKey));
    },
    editValue: (recordId, column, value) =>
      setState("records", recordId, "values", column, value),
    commitEdit: (recordId, column, value) => {
      setState("records", recordId, "values", column, value);
      setState("editing", null);
    },

    save: async () => {
      if (untrack(() => state.saving)) return;
      setState({ saving: true, saveError: null });
      try {
        // A field cleared while collapsed is still fetching the records it has
        // to delete; this request is what they're for, so it waits for them.
        if (pendingRemovals.size > 0) await Promise.all([...pendingRemovals]);
        const plan = untrack(() =>
          planSave({
            record: (id) => state.records[id],
            list: (id) => state.lists[id],
          }),
        );
        if (plan.operations.length > 0) {
          applySave(plan, await dml({ operations: plan.operations }));
        }
        setState({ saving: false, saveError: null });
      } catch (err) {
        // The form keeps everything it failed to write, so the user can act on
        // what the message says and save again.
        setState({ saving: false, saveError: errorMessage(err) });
      }
    },

    reset: () => {
      if (untrack(() => state.saving)) return;
      anchor = null;
      setState({
        records: {},
        lists: {},
        embeds: {},
        expanded: {},
        editing: null,
        focused: null,
        selection: [],
        menu: null,
        picker: null,
        saving: false,
        saveError: null,
      });
      addRecord(ROOT_ID, opts.table, opts.key, [], "unloaded");
      void loadRecord(ROOT_ID);
    },

    registerItem: (itemId, handle) => items.set(itemId, handle),
    unregisterItem: (itemId) => items.delete(itemId),

    noteFocus: (itemId) => setState("focused", itemId),
    noteBlur: () => {
      setState("focused", null);
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
      const group = items.get(itemId)?.group;
      const siblings = group ? (state.lists[group]?.childIds ?? []) : [];
      if (mods.shift && anchor !== null && siblings.includes(anchor)) {
        // Grow a range from the anchor, within this one list.
        const from = siblings.indexOf(anchor);
        const to = siblings.indexOf(itemId);
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setState("selection", siblings.slice(lo, hi + 1));
      } else if (mods.ctrl) {
        // Toggle this record in/out of the existing selection.
        setState(
          "selection",
          state.selection.includes(itemId)
            ? state.selection.filter((id) => id !== itemId)
            : [...state.selection, itemId],
        );
        anchor = itemId;
      } else {
        setState("selection", [itemId]);
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
      if (field.kind === "multiRecord") {
        const id = listId(recordId, field.key);
        const list = state.lists[id];
        const children = list?.childIds ?? [];
        const had =
          children.length > 0 ||
          (state.records[recordId]?.counts[field.key] ?? 0) > 0;
        setState("records", recordId, "counts", field.key, 0);
        deselect(children);
        // The deletion is recorded whether or not the list was ever opened: an
        // unopened one is replaced by an empty, *loaded* list, so the records it
        // stood for don't come back when the user expands the field — nor when a
        // load that was already in flight lands (which the new token cancels).
        if (had) {
          tokens.set(id, ++tokenSeq);
          setState("lists", id, {
            status: "loaded",
            error: null,
            expected: 0,
            childIds: [],
            removed: [...(list?.removed ?? []), ...deletable(children)],
            dirty: true,
          });
          // Clearing a field the user never opened deletes records the form has
          // never seen, so it fetches their keys now — the one thing a save
          // can't work out for itself later.
          const parentValue = state.records[recordId]?.values["id"] ?? "";
          if (list?.status !== "loaded" && parentValue !== "") {
            const pending = loadRemovedChildren(id, field, parentValue);
            pendingRemovals.add(pending);
            void pending.finally(() => pendingRemovals.delete(pending));
          }
        }
      } else {
        setState("records", recordId, "values", field.column, null);
        if (field.kind === "scalarLink") {
          // The record it pointed at is no longer this field's: its preview and
          // any sub-form the user opened go with the link.
          const id = scalarChildId(recordId, field.key);
          setState("embeds", id, dropped());
          setState("records", id, dropped());
        }
      }
      setExpandedItem(itemId, false);
    },
    removeChild: (recordId, field, childRecordId) =>
      removeChildren(recordId, field, [childRecordId]),
    removeChildren,

    addChild: (recordId, field) => {
      setState("expanded", fieldItemId(recordId, field.key), true);
      ensureList(recordId, field);
      const id = listId(recordId, field.key);
      const list = state.lists[id];
      if (!list) return;
      const child = newChildId(id, ++newSeq);
      addNewRecord(child, field.table, [field.column]);
      setState("lists", id, {
        childIds: [child, ...list.childIds],
        expected: list.expected + 1,
        dirty: true,
      });
      setState(
        "records",
        recordId,
        "counts",
        field.key,
        (count) => (count ?? 0) + 1,
      );
      setState("expanded", child, true);
      activateNewRecord(child);
    },
    addLinkedRecord: (recordId, field, seed) => {
      const id = scalarChildId(recordId, field.key);
      // Whatever the field pointed at before, it points at this new record now.
      setState("embeds", id, dropped());
      setState("records", id, dropped());
      setState("records", recordId, "values", field.column, null);
      addNewRecord(id, field.table, []);
      setState("expanded", fieldItemId(recordId, field.key), true);
      activateNewRecord(id, seed);
    },

    openMenu: (menu) => setState("menu", menu),
    closeMenu: () => setState("menu", null),

    openPicker: (recordId, fieldKey) => {
      // The picker is often reached *from* the field's context menu, and takes
      // the keyboard from it.
      setState("menu", null);
      setState("picker", { recordId, fieldKey });
    },
    closePicker: () => setState("picker", null),
    pickRecord: (recordId, field, keyValue, cells) => {
      const id = scalarChildId(recordId, field.key);
      // The record the field pointed at before is not this one: its preview and
      // any sub-form the user had opened under it go, and a preview load still
      // in flight for it is cancelled (its token is spent) so it can't land on
      // top of the one the picker just handed over.
      setState("embeds", id, dropped());
      setState("records", id, dropped());
      setState("expanded", fieldItemId(recordId, field.key), false);
      tokens.set(id, ++tokenSeq);
      setState("records", recordId, "values", field.column, keyValue);
      setState("embeds", id, { status: "loaded", cells });
      setState("picker", null);
    },
  };

  return model;
}
