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

import type { ColumnMetadata } from "../../query/columns";
import type { Section } from "../../query/definition";
import type { EmbedPreview } from "../../query/embedPreview";
import type { FormField, JoinLink, RecordKey } from "../../query/recordForm";
import type { ColumnValues } from "../../record/formValues";

/** Where a node is in its load cycle. `unloaded` means "known to exist, nothing
 * fetched yet" — a child record listed under a multi-record field before it's
 * been expanded. */
export type LoadStatus = "unloaded" | "loading" | "loaded" | "error";

/** What one computed column came to for the records of a node, read in a query
 * of its own once the node's data has landed (`query/computedColumns.ts`). */
export interface ComputedValues {
  status: LoadStatus;
  /** The value for each record, index-aligned to the node's keys. What was
   * last read stays while it's read again; undefined until it first is. */
  values: ColumnValues | undefined;
  /** Why it couldn't be computed: its expression doesn't compile, or the
   * database refused it. */
  error: string | null;
}

/** One form node: the records it stands for, its fields, and whatever has been
 * loaded into them. Every per-record map below is index-aligned to
 * {@link RecordNode.keys}. */
export interface RecordNode {
  table: string;
  /** The records this node is the form for, by key. The root holds as many as
   * the result-row selection does. A row of a multi-record field holds as many
   * as said the same thing about the base records the form is on — one,
   * ordinarily (see `record/childGroups.ts`). Records the form is *creating*
   * have no keys yet: `[[]]` for one, `[[], []]` for one per base record. */
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
  /** Computed column field key (`=last_play`) → what the column computes for
   * these records. Never the user's to edit, so it's kept apart from `values`,
   * and nothing here is ever saved. */
  computed: Record<string, ComputedValues>;
  /** Whether this record is being *created* by the form rather than edited: it
   * has no key, nothing to load, and counts as modified in its entirety. */
  isNew: boolean;
  /** Columns whose fields the form keeps — loads, edits, saves — without
   * showing them: the `order` of a record in a field whose records are kept in
   * order, which the form numbers itself (`MultiRecordField.ordered`). */
  concealed?: readonly string[];
  /** Set on a record of a join table's field (`MultiRecordField.join`): the
   * link to the record it stands for, which is what opening it shows. */
  join?: JoinLink;
}

/** The children of one expanded multi-record field — or of a contextual query's
 * field, whose list is the records the query found: never added to or taken
 * from, so neither `removed` nor `dirty` ever changes. */
export interface ListNode {
  status: LoadStatus;
  error: string | null;
  /** The related-record count known from the parent's load — how many
   * placeholders to render while the children themselves are in flight. On
   * several base records that's every one of their records, which is an upper
   * bound on the rows: some of them may turn out to be the same row. */
  expected: number;
  childIds: string[];
  /** What a contextual query found when its rows aren't records of its table:
   * a grouped query's (`$artist.name \g $%count`), each row standing for
   * however many records share what it groups by. They're what the query
   * displays, there to read: with no record behind a row, there's nothing to
   * open, select or edit, and {@link ListNode.childIds} stays empty. Absent
   * for a list of records. */
  rows?: readonly EmbedPreview[];
  /** The records the user has taken out of the list, kept — with their keys —
   * because they're still in the database until the form is saved, and the save
   * has to name them to delete them. Records the form itself created never get
   * here: they had nothing to delete. */
  removed: string[];
  /** Whether a record the database holds has been taken out of the list (so
   * it is also in {@link ListNode.removed}). Records the form created report
   * themselves as new, and the records themselves report their own edits; this
   * is the change that belongs to no single one of them. */
  dirty: boolean;
}

/** One embedded record's preview: the cells the widget lays out. */
export interface EmbedNode {
  status: LoadStatus;
  /** Positionally matching the display columns of the spec it was fetched with. */
  cells: readonly (string | null)[];
  /** How each of those cells is shown, by the query's annotations. Absent when
   * nothing has annotated them: a key standing in for a preview, say. */
  columns?: readonly ColumnMetadata[];
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

/** Some records of one table, by key. */
export interface RecordSet {
  table: string;
  keys: readonly RecordKey[];
}

/** The records a menu raised on embedded records can take the user to, worked
 * out as it opens (`RecordFormActions.openMenu`): the ones "Edit" puts at the
 * top of the editor, and the ones the navigation entries ("Show artist
 * tracks", …) lead on from — the same records, except under a join table's
 * field, whose records stand for the records they join to. Either is null when
 * there's none to be had: a record still being created has no key yet. */
export interface MenuRecords {
  edit: RecordSet | null;
  navigate: RecordSet | null;
}

/** An open context menu: what it acts on, and where it was raised. */
export interface FormMenu {
  target: MenuTarget;
  x: number;
  y: number;
  /** For a menu on embedded records, the records it can take the user to. */
  records?: MenuRecords;
}

/** The scalar linked record field the modal record picker is open for. */
export interface PickerTarget {
  recordId: string;
  fieldKey: string;
  /** Set when the pick is for one of the *distinct* values of a field the
   * records disagree on: the records holding `value` are the ones it re-points,
   * and the rest keep what they hold. */
  distinct?: { value: string | null };
}

/** An edit to one of the distinct values of a scalar field the records
 * disagree on, in progress. The records it writes to are fixed as it begins —
 * the ones holding `from` — rather than re-derived from what they hold as the
 * user types, which would gather up other records the moment the typed text
 * happened to pass through their value. */
export interface DistinctEdit {
  /** The {@link FormState.editing} id the edit belongs to — the value's own
   * (`distinctItemId`), as of when the edit began. */
  itemId: string;
  recordId: string;
  fieldKey: string;
  column: string;
  /** The value the edited records held when the edit began. */
  from: string | null;
  /** Those records, by index into the node's keys. */
  indices: readonly number[];
}

/** The find-and-replace panel open on a text field the records disagree on —
 * what's been typed into its two boxes. The toggles beside them are the app's
 * (`AppState.findOptions`), being the same for every form. */
export interface FindReplace {
  /** The field it's open on (`fieldItemId`). */
  itemId: string;
  find: string;
  replace: string;
}

/** A contextual query the user has begun adding, before it is one: a name, and
 * — once they choose it — the table it lists, which is what makes it real (see
 * `RecordFormActions.addProvisional`). */
export interface ProvisionalQuery {
  /** The record whose fields it's shown among: the root, whose table it's for. */
  recordId: string;
  name: string;
  /** Whether its name is being typed. */
  naming: boolean;
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
  /** Which records an edit to a distinct value writes to — set alongside
   * {@link FormState.editing} when that's what is being edited, and only
   * meaningful while it still names the same item (see `selectDistinctEdit`). */
  distinctEdit: DistinctEdit | null;
  /** The one field whose find-and-replace panel is open, or null. */
  findReplace: FindReplace | null;
  /** The {@link FormState.editing} id whose text box is in autocomplete mode —
   * showing the values its column holds, and searching them as the user types.
   * Only meaningful while it still names the same item (see
   * `selectIsAutocompleting`). */
  autocomplete: string | null;
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
  /** The editor just asked for, by field item id, which takes the caret once
   * it's there. Whichever other way one comes back on screen — a tab showing
   * again, the form returned to — leaves the caret where the user has it. */
  queryEditorFocus: string | null;
  /** Field item id → why the database refused the embedded records it was last
   * asked for, while the ones on screen are from before. */
  embedErrors: Record<string, string>;
  /** The open query editors under fields, by field item id, each with the
   * section of the query it's showing: a contextual query's, or the Querydown
   * behind a field's embedded records. Absent reads as closed. */
  queryEditors: Record<string, Section>;
  /** The field item id whose label is being renamed in place, or null. */
  renaming: string | null;
  /** The contextual query being added, or null. */
  provisional: ProvisionalQuery | null;
  /** The contextual query the user has asked to remove, awaiting their
   * confirmation, or null. */
  removing: string | null;
  /** Whether a computed column is being added to the root record's table: a
   * field at the bottom of its fields with its name being typed, which becomes
   * a computed column once the name is settled on. */
  addingComputed: boolean;
  /** The computed column the user has asked to remove, awaiting their
   * confirmation, or null. */
  removingComputed: { table: string; name: string } | null;
  /** Whether a save is in flight. */
  saving: boolean;
  /** Why the last save failed, or null. The form keeps the changes it couldn't
   * write, so the user can fix what the message says and try again. */
  saveError: string | null;
  /** Whether something the form shows was changed on another device since it
   * was read: a contextual query's Querydown, a computed column, how a field's
   * embedded records show. A change from elsewhere reshapes the form but
   * leaves what's in it to the user's next Refresh, and this is what Refresh's
   * dot says. Refreshing clears it. */
  changedElsewhere: boolean;
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
    distinctEdit: null,
    findReplace: null,
    autocomplete: null,
    focused: null,
    selection: [],
    menu: null,
    picker: null,
    queryEditorFocus: null,
    embedErrors: {},
    queryEditors: {},
    renaming: null,
    provisional: null,
    removing: null,
    addingComputed: false,
    removingComputed: null,
    saving: false,
    saveError: null,
    changedElsewhere: false,
  };
}
