// The record editor form's state: what's loaded, what's loading, what's
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
// see `record/formIds.ts` — which makes every update a single-key write and makes
// a node's identity stable across collapse/expand.
//
// Framework-free on purpose (no zustand, no immer): `record/formSave.ts`, a
// framework-free module, reads these node types.

import type { FormField, RecordKey } from "../../../query/recordForm";
import type { ColumnValues } from "../../../record/formValues";

/** Where a node is in its load cycle. `unloaded` means "known to exist, nothing
 * fetched yet" — a child record listed under a multi-record field before it's
 * been expanded. */
export type LoadStatus = "unloaded" | "loading" | "loaded" | "error";

/** One form node: the records it stands for, its fields, and whatever has been
 * loaded into them. Every per-record map below is index-aligned to
 * {@link RecordNode.keys}. */
export interface RecordNode {
  table: string;
  /** The records this node is the form for, by key. The root holds as many as
   * the result-row selection does; every node reached by expanding a field holds
   * exactly one. A record the form is *creating* is one record with no key
   * yet — `[[]]`, not `[]`. */
  keys: readonly RecordKey[];
  /** Columns hidden as this record's contextual filter (see `buildFormFields`). */
  hidden: readonly string[];
  fields: readonly FormField[];
  status: LoadStatus;
  error: string | null;
  /** Column → its current value in each record. Seeded with the key columns,
   * which are known before any fetch — the ids render while the rest of the form
   * is still loading. */
  values: Record<string, ColumnValues>;
  /** Column → the values the database last gave us, which is what makes an edit
   * detectable: a column whose `values` entry has drifted from its `original` is
   * modified, and that's what the red star is drawn from. Written only by a load
   * or a save — never by an edit. */
  original: Record<string, ColumnValues>;
  /** Referencing field key (`#credit`) → count of related records, per record. */
  counts: Record<string, readonly number[]>;
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

export interface FormState {
  records: Record<string, RecordNode>;
  lists: Record<string, ListNode>;
  embeds: Record<string, EmbedNode>;
  /** Item id → whether it's expanded. Absent reads as collapsed: everything
   * starts closed. */
  expanded: Record<string, boolean>;
  /** The one field in edit mode (`<recordId>:<fieldKey>`), or null. */
  editing: string | null;
  /** Whether entering edit mode on {@link FormState.editing} should select its
   * whole value rather than place the caret at the end — set when edit mode was
   * entered by Tabbing in from another field's editor. */
  editingSelectAll: boolean;
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
 * that a keyboard command — which knows only an item id — can act on it.
 *
 * Registered from an effect, so its closures outlive the render that made them:
 * they must read the model's *current* state (`model.store.getState()`) or call
 * its actions by id, never capture values from that render. */
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
  /** Puts this item into edit mode, when it's a field with a value the user can
   * type into — absent for anything else (a scalar linked record field, a
   * multi-record field, a record within one). What Tabbing out of one field's
   * editor into the next item uses to keep moving through editors rather than
   * stopping on a label. */
  beginEdit?: (selectAll: boolean) => void;
}

/** A form with nothing in it: no nodes, nothing open, nothing in flight. The
 * model adds its root record on top (`createRecordForm`). */
export function initialFormState(): FormState {
  return {
    records: {},
    lists: {},
    embeds: {},
    expanded: {},
    editing: null,
    editingSelectAll: false,
    focused: null,
    selection: [],
    menu: null,
    picker: null,
    saving: false,
    saveError: null,
  };
}
