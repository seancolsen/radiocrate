// Turning the form's unsaved work into a DML request.
//
// The form holds its changes as a tree of records (`formModel.ts`); the DML API
// takes one flat, ordered list of operations, run in a single transaction. This
// module is the translation — tree in, operations out — and it's pure, so the
// ordering rules that make a request valid are unit-testable without a store, a
// DOM or a backend.
//
// Three rules decide the order:
//
// - **Deletes first, deepest first.** The API never cascades: a delete fails if
//   any row still references the record. So the records hanging off a deleted
//   one go before it, and all the deletes go before the inserts — so that
//   re-entering a record the user just removed can't collide with the row it's
//   replacing on a unique constraint.
// - **A referenced insert comes before the reference to it.** A record the form
//   is creating has no id yet, so whatever points at it carries
//   `{ id: <operation id> }` instead, which the server only resolves backwards.
// - **A record comes before the records that point back at it.** A new child of
//   a multi-record field carries its parent's id, so the parent goes first.
//
// What the planner does *not* do is discover records it was never shown: a
// deleted record whose children were never loaded is sent on its own, and the
// server rejects it as a dangling reference. That error lands in the form like
// any other.
//
// A node standing for several records (the editor on a multi-row selection)
// needs no rule of its own: an operation names one record, so the node yields
// one per record it holds — each with its own `where` and its own changed
// columns, which for an edit made across all of them is the same column with the
// same value. Everything above still holds, record by record.

import type { DmlOperation, JsonValue } from "api-client";
import type {
  PrimitiveField,
  RecordKey,
  ScalarLinkField,
} from "../../query/recordForm";
import { listId, ROOT_ID, scalarChildId } from "./formIds";
import type { ListNode, RecordNode } from "./formModel";

/** The slice of the form's state the planner reads: nodes by id, however they
 * happen to be stored. */
export interface FormTree {
  record: (id: string) => RecordNode | undefined;
  list: (id: string) => ListNode | undefined;
}

/** Where one operation's returned row belongs: the node it was planned from,
 * and which of that node's records it wrote — a node standing for several
 * records produces one operation each. */
export interface SaveTarget {
  recordId: string;
  index: number;
}

/** A request to save the form, and what the answer means for it. */
export interface SavePlan {
  operations: DmlOperation[];
  /** Operation id → the record that operation writes, so the row it returns can
   * be folded back into the right place. */
  saved: ReadonlyMap<string, SaveTarget>;
  /** The records being created — the ones that become real, with a key and a
   * preview of their own, once the request succeeds. */
  created: readonly string[];
  /** The records being deleted, whose nodes go once the request succeeds. */
  deleted: readonly string[];
}

/** A record's `where` clause: the columns that identify it, as loaded. */
function keyObject(key: RecordKey): Record<string, JsonValue> {
  return Object.fromEntries(key.map((part) => [part.column, part.value]));
}

/** One column's value as the API takes it. Everything travels as the string the
 * form holds — the server binds text and lets the database cast it to the
 * column's own type.
 *
 * An empty box means "no value" wherever NULL is allowed; only a NOT NULL text
 * column keeps the empty string, that being the only empty it can hold. */
function columnValue(
  field: PrimitiveField | ScalarLinkField,
  value: string | null | undefined,
): JsonValue {
  if (value == null) return null;
  if (value !== "") return value;
  const isText = field.kind === "primitive" && field.valueType === "text";
  return isText && !field.nullable ? "" : null;
}

/** Every record hanging off `node` that the form has loaded: the children of its
 * multi-record fields, including the ones the user has already removed (still in
 * the database until this request lands). */
function dependents(tree: FormTree, recordId: string, node: RecordNode) {
  const ids: string[] = [];
  for (const field of node.fields) {
    if (field.kind !== "multiRecord") continue;
    const list = tree.list(listId(recordId, field.key));
    if (!list) continue;
    ids.push(...list.childIds, ...list.removed);
  }
  return ids;
}

/** The DML request that saves everything the user has changed in one form, or
 * an empty operation list when they've changed nothing. */
export function planSave(tree: FormTree, rootId: string = ROOT_ID): SavePlan {
  const operations: DmlOperation[] = [];
  const saved = new Map<string, SaveTarget>();
  const created: string[] = [];
  const deleted: string[] = [];
  let seq = 0;
  const nextOpId = () => `op${++seq}`;

  // ── Deletes ────────────────────────────────────────────────────────────────

  /** Deletes one record, preceded by everything the form knows to be hanging off
   * it. A record the form merely invented and then dropped never reached the
   * database, so it needs no operation at all. */
  const planDelete = (recordId: string) => {
    const node = tree.record(recordId);
    if (!node || node.isNew) return;
    const keys = node.keys.filter((key) => key.length > 0);
    if (keys.length === 0) return;
    for (const child of dependents(tree, recordId, node)) planDelete(child);
    deleted.push(recordId);
    for (const key of keys) {
      operations.push({
        operation: "delete",
        id: nextOpId(),
        table: node.table,
        where: keyObject(key),
      });
    }
  };

  /** Walks the live tree for records the user has removed from a multi-record
   * field, at any depth. */
  const planRemovals = (recordId: string) => {
    const node = tree.record(recordId);
    if (!node) return;
    for (const field of node.fields) {
      if (field.kind === "scalarLink") {
        planRemovals(scalarChildId(recordId, field.key));
      } else if (field.kind === "multiRecord") {
        const list = tree.list(listId(recordId, field.key));
        if (!list) continue;
        for (const child of list.removed) planDelete(child);
        for (const child of list.childIds) planRemovals(child);
      }
    }
  };

  // ── Inserts and updates ────────────────────────────────────────────────────

  /** Plans one record and everything under it, returning the id of the operation
   * that *creates* it — which only a record being created has, and which is what
   * anything pointing at it references.
   *
   * `context` is the foreign key tying a new record to the record it's being
   * created under: the column a multi-record field filters on, which the child's
   * own form hides precisely because it isn't the user's to fill in. */
  const planRecord = (
    recordId: string,
    context?: { column: string; value: JsonValue },
  ): string | undefined => {
    const node = tree.record(recordId);
    if (!node) return undefined;

    // The records this one points at go first: a reference only resolves against
    // an operation that has already run.
    const links: Record<string, JsonValue> = {};
    for (const field of node.fields) {
      if (field.kind !== "scalarLink") continue;
      const childId = scalarChildId(recordId, field.key);
      if (!tree.record(childId)) continue;
      const opId = planRecord(childId);
      if (opId !== undefined) links[field.column] = { id: opId };
    }

    // What each record of the node has to write: its own changed columns,
    // against its own baseline. A record being created sends everything it has
    // instead — the database supplies the rest.
    const values = node.keys.map((_, index) => {
      const changed: Record<string, JsonValue> = {};
      for (const field of node.fields) {
        if (field.kind === "multiRecord") continue;
        const current = node.values[field.column]?.[index] ?? null;
        const value = columnValue(field, current);
        if (node.isNew) {
          if (value !== null) changed[field.column] = value;
        } else if (current !== (node.original[field.column]?.[index] ?? null)) {
          changed[field.column] = value;
        }
      }
      // A record the form is creating for a link is created once, and every
      // record of the node comes to point at it.
      Object.assign(changed, links);
      if (node.isNew && context) changed[context.column] = context.value;
      return changed;
    });

    let opId: string | undefined;
    if (node.isNew) {
      // A record is only ever created singly, whatever the form around it holds.
      opId = nextOpId();
      operations.push({
        operation: "insert",
        id: opId,
        table: node.table,
        values: values[0] ?? {},
      });
      saved.set(opId, { recordId, index: 0 });
      created.push(recordId);
    } else {
      node.keys.forEach((key, index) => {
        if (Object.keys(values[index]).length === 0) return;
        const id = nextOpId();
        operations.push({
          operation: "update",
          id,
          table: node.table,
          where: keyObject(key),
          values: values[index],
        });
        saved.set(id, { recordId, index });
      });
    }

    // The records that point back at this one go after it, so a new child can
    // carry the id this operation is about to produce. Every inferred link
    // points at `<table>.id`, so that — not this record's key, which may be
    // composite — is what a child carries. A node holding several records has
    // no children to plan: they can only be opened on one record at a time
    // (`beyondBulk`), which is why one id is the whole story here.
    for (const field of node.fields) {
      if (field.kind !== "multiRecord") continue;
      const list = tree.list(listId(recordId, field.key));
      if (!list) continue;
      const parent: JsonValue =
        opId === undefined ? (node.values["id"]?.[0] ?? null) : { id: opId };
      for (const child of list.childIds) {
        planRecord(child, { column: field.column, value: parent });
      }
    }
    return opId;
  };

  planRemovals(rootId);
  planRecord(rootId);
  return { operations, saved, created, deleted };
}
