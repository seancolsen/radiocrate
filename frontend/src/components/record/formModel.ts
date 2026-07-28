// The record editor form's reactive state: what's loaded, what's loading, what's
// expanded, what's focused or selected, and which field is being edited.
//
// The form is a tree that grows as the user opens it — a scalar linked record
// field expands into another record's whole form, a multi-record field into a
// list of records that each expand the same way, with no bound on the depth. So
// rather than a nested store (whose paths would have to be walked and spliced at
// every level), nodes live in three **flat, id-keyed maps**: `records` (one
// record's fields and values), `lists` (one multi-record field's children), and
// `embeds` (the preview cells behind one embedded record). Ids encode the path —
// see `scalarChildId` / `listId` / `childId` — which makes every update a single-
// key write and makes a node's identity stable across collapse/expand.
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

import { untrack } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { SchemaTable } from "../../query/schema";
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
  /** Referencing field key (`#credit`) → count of related records. */
  counts: Record<string, number>;
}

/** The children of one expanded multi-record field. */
export interface ListNode {
  status: LoadStatus;
  error: string | null;
  /** The related-record count known from the parent's load — how many
   * placeholders to render while the children themselves are in flight. */
  expected: number;
  childIds: string[];
}

/** One embedded record's preview: the cells the widget lays out. */
export interface EmbedNode {
  status: LoadStatus;
  /** Positionally matching the display columns of the spec it was fetched with. */
  cells: readonly (string | null)[];
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

/** The root record's node id — the record the sidebar was opened on. */
export const ROOT_ID = "r";

/** The node id of the record behind a scalar linked record field. Also the id of
 * that field's embedded record. */
export function scalarChildId(recordId: string, fieldKey: string): string {
  return `${recordId}>${fieldKey}`;
}

/** The node id of a multi-record field's child list. */
export function listId(recordId: string, fieldKey: string): string {
  return `${recordId}#${fieldKey}`;
}

/** The node id of the nth record within a child list. */
function childId(list: string, index: number): string {
  return `${list}[${index}]`;
}

/** The id an expandable/editable *field* is tracked under. Records have their
 * own ids; a field is one of its record's, qualified by field key. */
export function fieldItemId(recordId: string, fieldKey: string): string {
  return `${recordId}:${fieldKey}`;
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
  /** Leave edit mode, keeping `value` as the field's current (in-memory) value.
   * Persisting it is the "Saving the form" work, still to come. */
  commitEdit: (recordId: string, column: string, value: string) => void;

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
  });

  // Per-node load tokens: only the newest load for a node may write its result.
  const tokens = new Map<string, number>();
  let tokenSeq = 0;

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
      counts: {},
    });
  };

  /** Loads the preview behind one embedded record: the columns that identify it
   * at a glance, for the single record `key` identifies. Used for a scalar
   * linked record field, whose id arrives with its parent's data (a multi-record
   * field's children come with their previews already attached).
   *
   * With no preview columns to be had, the key stands in for them rather than
   * leaving the widget blank. */
  const loadEmbed = async (
    id: string,
    table: string,
    key: readonly KeyPart[],
  ) => {
    const keyCells = key.map((p) => p.value);
    const spec = specFor(table);
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
      setState("lists", id, { status: "loaded", childIds });
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
    // key, which may be composite — is the value the children carry.
    const parentValue = node?.values["id"];
    if (parentValue == null || parentValue === "") return;
    setState("lists", id, {
      status: "unloaded",
      error: null,
      expected: node?.counts[field.key] ?? 0,
      childIds: [],
    });
    void loadChildren(id, field, parentValue);
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

    beginEdit: (recordId, fieldKey) =>
      setState("editing", fieldItemId(recordId, fieldKey)),
    commitEdit: (recordId, column, value) => {
      setState("records", recordId, "values", column, value);
      setState("editing", null);
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
        setState("records", recordId, "counts", field.key, 0);
        const children = state.lists[id]?.childIds ?? [];
        if (children.length > 0) {
          setState("lists", id, { expected: 0, childIds: [] });
          deselect(children);
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
    removeChild: (recordId, field, childRecordId) => {
      const id = listId(recordId, field.key);
      const remaining = (state.lists[id]?.childIds ?? []).filter(
        (child) => child !== childRecordId,
      );
      setState("lists", id, {
        expected: remaining.length,
        childIds: remaining,
      });
      setState("records", recordId, "counts", field.key, remaining.length);
      deselect([childRecordId]);
    },
  };

  return model;
}
