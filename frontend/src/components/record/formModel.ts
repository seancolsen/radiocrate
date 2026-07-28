// The record editor form's reactive state: what's loaded, what's loading, what's
// expanded, and which field is being edited.
//
// The form is a tree that grows as the user opens it — a scalar linked record
// field expands into another record's whole form, a multi-record field into a
// list of records that each expand the same way, with no bound on the depth. So
// rather than a nested store (whose paths would have to be walked and spliced at
// every level), nodes live in two **flat, id-keyed maps**: `records` (one
// record's fields and values) and `lists` (one multi-record field's children).
// Ids encode the path — see `scalarChildId` / `listId` / `childId` — which makes
// every update a single-key write and makes a node's identity stable across
// collapse/expand.
//
// Loading is lazy and idempotent: expanding an item fetches its data the first
// time only, and collapsing keeps it. Each fetch is guarded by a token so a
// superseded load (expand, collapse, expand again) can't overwrite a newer one.

import { untrack } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { SchemaTable } from "../../query/schema";
import {
  buildFormFields,
  childRecordsQuery,
  recordDataQuery,
  type FormField,
  type KeyPart,
  type MultiRecordField,
  type ScalarLinkField,
} from "../../query/recordForm";
import { runRecordQuery } from "../../query/recordData";

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

interface FormState {
  records: Record<string, RecordNode>;
  lists: Record<string, ListNode>;
  /** Item id → whether it's expanded. Absent reads as collapsed: everything
   * starts closed. */
  expanded: Record<string, boolean>;
  /** The one field in edit mode (`<recordId>:<fieldKey>`), or null. */
  editing: string | null;
}

/** The root record's node id — the record the sidebar was opened on. */
export const ROOT_ID = "r";

/** The node id of the record behind a scalar linked record field. */
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

/** The reactive form for one record. Created per record the sidebar points at
 * (re-pointing it builds a new one), and it starts loading immediately. */
export interface RecordFormModel {
  /** A record node by id — `undefined` before it exists (nothing expanded yet). */
  record: (id: string) => RecordNode | undefined;
  /** A child list by id, likewise. */
  list: (id: string) => ListNode | undefined;
  /** Whether an item (field or child record) is expanded. */
  isExpanded: (itemId: string) => boolean;
  /** The field in edit mode, or null. */
  editing: () => string | null;
  /** Expand/collapse a field, loading its data the first time it opens. */
  toggleField: (recordId: string, field: FormField) => void;
  /** Expand/collapse a child record within a multi-record field, loading its
   * data the first time it opens. */
  toggleChild: (id: string) => void;
  /** Put a field into edit mode (its value becomes an input). */
  beginEdit: (recordId: string, fieldKey: string) => void;
  /** Leave edit mode, keeping `value` as the field's current (in-memory) value.
   * Persisting it is the "Form modification"/"Saving" work, still to come. */
  commitEdit: (recordId: string, column: string, value: string) => void;
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
    expanded: {},
    editing: null,
  });

  // Per-node load tokens: only the newest load for a node may write its result.
  const tokens = new Map<string, number>();
  let tokenSeq = 0;

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
    } catch (err) {
      if (tokens.get(id) !== token) return;
      setState("records", id, { status: "error", error: errorMessage(err) });
    }
  };

  /** Loads the records behind a multi-record field: one query for all of them,
   * yielding a child node per record — keyed, but otherwise unloaded until the
   * user expands it. */
  const loadChildren = async (
    id: string,
    field: MultiRecordField,
    parentValue: string,
  ) => {
    const token = ++tokenSeq;
    tokens.set(id, token);
    setState("lists", id, { status: "loading", error: null });
    try {
      const rows = await runRecordQuery(
        childRecordsQuery(field, parentValue),
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

  // The root record exists from the start — its key is known — and its data is
  // fetched right away, under the loading wash.
  addRecord(ROOT_ID, opts.table, opts.key, [], "unloaded");
  untrack(() => void loadRecord(ROOT_ID));

  return {
    record: (id) => state.records[id],
    list: (id) => state.lists[id],
    isExpanded: (itemId) => state.expanded[itemId] === true,
    editing: () => state.editing,
    toggleField: (recordId, field) => {
      const itemId = fieldItemId(recordId, field.key);
      const open = state.expanded[itemId] !== true;
      setState("expanded", itemId, open);
      if (!open) return;
      if (field.kind === "scalarLink") ensureScalarChild(recordId, field);
      else if (field.kind === "multiRecord") ensureList(recordId, field);
    },
    toggleChild: (id) => {
      const open = state.expanded[id] !== true;
      setState("expanded", id, open);
      if (open && state.records[id]?.status === "unloaded") void loadRecord(id);
    },
    beginEdit: (recordId, fieldKey) =>
      setState("editing", fieldItemId(recordId, fieldKey)),
    commitEdit: (recordId, column, value) => {
      setState("records", recordId, "values", column, value);
      setState("editing", null);
    },
  };
}
