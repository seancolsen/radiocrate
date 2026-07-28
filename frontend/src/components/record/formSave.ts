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

import type { DmlOperation, JsonValue } from "api-client";
import type {
  KeyPart,
  PrimitiveField,
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

/** A request to save the form, and what the answer means for it. */
export interface SavePlan {
  operations: DmlOperation[];
  /** Operation id → the record node that operation writes, so the row it
   * returns can be folded back into the right node. */
  saved: ReadonlyMap<string, string>;
  /** The records being created — the ones that become real, with a key and a
   * preview of their own, once the request succeeds. */
  created: readonly string[];
  /** The records being deleted, whose nodes go once the request succeeds. */
  deleted: readonly string[];
}

/** A record's `where` clause: the columns that identify it, as loaded. */
function keyObject(key: readonly KeyPart[]): Record<string, JsonValue> {
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
  const saved = new Map<string, string>();
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
    if (!node || node.isNew || node.key.length === 0) return;
    for (const child of dependents(tree, recordId, node)) planDelete(child);
    deleted.push(recordId);
    operations.push({
      operation: "delete",
      id: nextOpId(),
      table: node.table,
      where: keyObject(node.key),
    });
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

    const values: Record<string, JsonValue> = {};
    for (const field of node.fields) {
      if (field.kind === "multiRecord") continue;
      const value = columnValue(field, node.values[field.column]);
      if (node.isNew) {
        // A new record sends what it has; the database supplies the rest.
        if (value !== null) values[field.column] = value;
      } else if (node.values[field.column] !== node.original[field.column]) {
        values[field.column] = value;
      }
    }
    Object.assign(values, links);
    if (node.isNew && context) values[context.column] = context.value;

    let opId: string | undefined;
    if (node.isNew) {
      opId = nextOpId();
      operations.push({
        operation: "insert",
        id: opId,
        table: node.table,
        values,
      });
      saved.set(opId, recordId);
      created.push(recordId);
    } else if (Object.keys(values).length > 0) {
      const id = nextOpId();
      operations.push({
        operation: "update",
        id,
        table: node.table,
        where: keyObject(node.key),
        values,
      });
      saved.set(id, recordId);
    }

    // The records that point back at this one go after it, so a new child can
    // carry the id this operation is about to produce. Every inferred link
    // points at `<table>.id`, so that — not this record's key, which may be
    // composite — is what a child carries.
    for (const field of node.fields) {
      if (field.kind !== "multiRecord") continue;
      const list = tree.list(listId(recordId, field.key));
      if (!list) continue;
      const parent: JsonValue =
        opId === undefined ? (node.values["id"] ?? null) : { id: opId };
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
