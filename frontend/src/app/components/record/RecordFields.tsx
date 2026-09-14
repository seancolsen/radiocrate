import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import EmbeddedRecord from "./EmbeddedRecord";
import ExpansionToggle from "./ExpansionToggle";
import FieldLabel from "./FieldLabel";
import FieldValue, { VariedValue, type EditExit } from "./FieldValue";
import ModifiedStar from "./ModifiedStar";
import {
  fieldItemId,
  isShared,
  listId,
  scalarChildId,
  selectCount,
  selectFieldModified,
  selectHasLinkedRecord,
  selectIsBulkBlocked,
  selectIsExpanded,
  selectIsSelected,
  selectRecordModified,
  selectSharedValue,
  VARIED,
  type FormState,
  type RecordFormModel,
  type SharedValue,
} from "../../stores/recordForm";
import { useFormState } from "../../stores/react";
import { Icons } from "../../icons";
import IconButton from "../ui/IconButton";
import LoadingRegion from "../ui/LoadingRegion";
import type {
  FormField,
  MultiRecordField,
  PrimitiveField,
  ScalarLinkField,
} from "../../../query/recordForm";

// The form's tree, rendered. The components here call each other in a cycle — a
// record's fields, a field's expansion, a multi-record field's children, and
// each of those children's own fields — which is what lets the user recurse into
// the data as deep as it goes, so they live in one file.
//
// Every row is the same three slots in the same order: expansion toggle, field
// label, value. Rows an item can't fill still reserve the space, so toggles and
// labels line up down the whole form regardless of what any one row holds.
//
// Two kinds of row are *items*: a field (its label) and a record within a
// multi-record field (its embedded record). Each registers what it can do with
// the model when it mounts, so a keyboard command — which knows an item only by
// id — can expand, collapse or delete it.
//
// A row renders the same whether the form is on one record or several: what it
// shows is what those records agree on, which is a value like any other. The two
// places the count matters are here in `FieldRow` — a field the records disagree
// on shows "(varied)" in place of its value, and a multi-record field says bulk
// modification of child records isn't supported yet.
//
// Every component subscribes to the form's store through narrow selectors that
// return primitives or references already in state (state management rule 2),
// so a keystroke re-renders the row being edited and the stars above it — not
// the tree. Rows are keyed on what they stand for (a field's key, a child
// record's id), which fixes each row's subject for its life the way Solid's
// `untrack` did.

/** The cells of an embedded record with no preview yet — one shared empty list,
 * so a selector falling back to it returns the same reference every time. */
const NO_CELLS: readonly (string | null)[] = [];

/** All of one record's fields, dimmed under the loading wash while its data is
 * in flight. */
export default function RecordNodeView(props: {
  model: RecordFormModel;
  recordId: string;
}): JSX.Element | null {
  const { model, recordId } = props;
  const fields = useFormState(model, (s) => s.records[recordId]?.fields);
  const status = useFormState(model, (s) => s.records[recordId]?.status);
  const error = useFormState(model, (s) => s.records[recordId]?.error ?? null);
  const isNew = useFormState(model, (s) => s.records[recordId]?.isNew === true);
  if (!fields) return null;
  return (
    <LoadingRegion loading={status === "loading"}>
      {fields.map((field) => (
        <FieldRow
          key={field.key}
          model={model}
          recordId={recordId}
          isNew={isNew}
          field={field}
        />
      ))}
      {status === "error" && (
        <p className="text-danger px-1 py-0.5 text-xs">{error}</p>
      )}
    </LoadingRegion>
  );
}

/** Whether a field's row has anything to expand, given the form's state and
 * whether its collapsed value is cut off. Shared by the row's render and the
 * item handle it registers, which asks later, from `getState()`. */
function fieldExpandable(
  s: FormState,
  recordId: string,
  field: FormField,
  overflowing: boolean,
): boolean {
  if (field.kind === "multiRecord") {
    // A field with no records has nothing to open; one whose table has no
    // record identity at all can be counted but not listed; and one on
    // several records can't be listed yet either.
    if (selectIsBulkBlocked(s, recordId, field.key)) return false;
    const count = selectCount(s, recordId, field.key);
    const shared = isShared(count) ? count : undefined;
    return (shared ?? 0) > 0 && field.keyColumns.length > 0;
  }
  if (field.kind === "scalarLink") {
    return selectHasLinkedRecord(s, recordId, field);
  }
  return field.valueType === "text" && overflowing;
}

/** One field: its row, plus whatever the row expands into. */
function FieldRow(props: {
  model: RecordFormModel;
  recordId: string;
  /** Whether the record this field belongs to is one the form is creating. */
  isNew: boolean;
  field: FormField;
}): JSX.Element {
  const { model, recordId, field } = props;

  // Whether the collapsed value is actually cut off — reported up from the value
  // itself, since only it knows how much room the text needed. Mirrored into a
  // ref for the item handle, which reads it long after this render.
  const [overflowing, setOverflowing] = useState(false);
  const overflowingRef = useRef(overflowing);
  useEffect(() => {
    overflowingRef.current = overflowing;
  }, [overflowing]);

  const itemId = fieldItemId(recordId, field.key);
  const expanded = useFormState(model, (s) => selectIsExpanded(s, itemId));

  /** Whether the form is on several records, which is what a multi-record field
   * has no bulk modification for yet. */
  const bulkBlocked = useFormState(model, (s) =>
    selectIsBulkBlocked(s, recordId, field.key),
  );

  /** The record count behind a multi-record field: the number its records
   * share, `VARIED` when they hold different numbers, `undefined` before it
   * lands (or for any other kind of field). */
  const relatedCount = useFormState(model, (s) =>
    field.kind === "multiRecord"
      ? selectCount(s, recordId, field.key)
      : undefined,
  );
  /** That count when there's a number to put in the badge. */
  const count = isShared(relatedCount) ? relatedCount : undefined;
  const variedCount = relatedCount === VARIED;

  /** The column value behind any other field: `undefined` until loaded,
   * `VARIED` when the records disagree. */
  const value: SharedValue = useFormState(model, (s) =>
    field.kind === "multiRecord"
      ? undefined
      : selectSharedValue(s, recordId, field.column),
  );

  const expandable = useFormState(model, (s) =>
    fieldExpandable(s, recordId, field, overflowing),
  );

  /** Whether a scalar linked record field has a record to show — one it points
   * at, or a new one the user is entering into it. What decides between an
   * embedded record and the pencil that offers to fill the field in. */
  const linked = useFormState(
    model,
    (s) =>
      field.kind === "scalarLink" && selectHasLinkedRecord(s, recordId, field),
  );

  /** Whether this field carries an unsaved change, its own or one anywhere
   * inside it. */
  const modified = useFormState(model, (s) =>
    selectFieldModified(s, recordId, field.key),
  );

  /** Whether the open context menu is this field's own. */
  const menuOpen = useFormState(model, (s) => {
    const target = s.menu?.target;
    return (
      target?.kind === "field" &&
      target.recordId === recordId &&
      target.fieldKey === field.key
    );
  });

  /** The id of both the record behind a scalar linked record field and that
   * field's embedded record. */
  const embedId = scalarChildId(recordId, field.key);
  const embedIsNew = useFormState(model, (s) => s.records[embedId]?.isNew);
  const embedStatus = useFormState(model, (s) => s.embeds[embedId]?.status);
  const embedCells = useFormState(
    model,
    (s) => s.embeds[embedId]?.cells ?? NO_CELLS,
  );

  /** Whether the embedded record's preview is still on its way. A record the
   * form is *creating* has no preview to wait for — it renders as "New". */
  const embedLoading = embedIsNew !== true && embedStatus !== "loaded";

  /** An expanded *text* field moves its value below the label, where it has the
   * width to wrap; an expanded link/record field grows a subtree instead. */
  const textBelow = field.kind === "primitive" && expanded;

  /** Whether the row's value renders as plain text (or a pencil): everything
   * except a record count, an embedded record, and text that has moved below
   * its label. */
  const plainValue = field.kind !== "multiRecord" && !textBelow && !linked;

  // What this row can do to itself, for the keyboard commands. Registered from
  // an effect, so every closure reads the model's current state rather than
  // this render's values (see `ItemHandle`). Only an editable primitive field
  // has an editor to Tab into.
  useEffect(() => {
    model.registerItem(itemId, {
      group: recordId,
      expandable: () =>
        fieldExpandable(
          model.store.getState(),
          recordId,
          field,
          overflowingRef.current,
        ),
      setExpanded: (open) => model.toggleField(recordId, field, open),
      remove: () => model.clearField(recordId, field),
      beginEdit:
        field.kind === "primitive" && !field.readOnly
          ? (selectAll) => model.beginEdit(recordId, field.key, { selectAll })
          : undefined,
    });
    return () => model.unregisterItem(itemId);
  }, [model, itemId, recordId, field]);

  /** Raises the menu for this field — from its label, its value, or the
   * embedded record a scalar linked record field shows. */
  const openMenu = (e: MouseEvent, kind: "field" | "scalarEmbed") => {
    e.preventDefault();
    model.openMenu({
      target: { kind, recordId, fieldKey: field.key },
      x: e.clientX,
      y: e.clientY,
    });
  };

  const toggle = (siblings: boolean) => {
    if (siblings) model.toggleSiblings(itemId, !expanded);
    else model.toggleField(recordId, field);
  };

  /** A field label's double click: a primitive field goes into edit mode, a
   * scalar linked record field opens the record picker (spec: "Modal record
   * picker" — whatever the field currently points at, which is why this isn't
   * the expansion the chevron and the embedded record already offer), and a
   * multi-record field opens or closes. */
  const activate = () => {
    if (field.kind === "primitive") model.beginEdit(recordId, field.key);
    else if (field.kind === "scalarLink") model.openPicker(recordId, field.key);
    else model.toggleField(recordId, field);
  };

  /** Activating an empty field's value — the pencil button, or a click on the
   * value itself. A scalar linked record field holds a foreign key rather than
   * anything a user would type, so its pencil offers the picker instead of a
   * text box. */
  const beginEdit = () => {
    if (field.kind === "scalarLink") model.openPicker(recordId, field.key);
    else model.beginEdit(recordId, field.key);
  };

  /** Enter on a focused label: the field's "do the thing" key, one per kind —
   * a primitive field's input, a scalar linked record field's picker, or (unlike
   * double-click, which only expands) a fresh child of a multi-record field. */
  const onLabelKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (field.kind === "primitive") model.beginEdit(recordId, field.key);
    else if (field.kind === "scalarLink") model.openPicker(recordId, field.key);
    else model.addChild(recordId, field);
  };

  /** Leaving edit mode: the value is kept in the form, and focus goes wherever
   * the key that ended the edit says. Deferred a tick so the input is gone (and
   * the label is back) before it's asked for focus. */
  const commit = (text: string, exit: EditExit) => {
    if (field.kind === "multiRecord") return;
    model.commitEdit(recordId, field.column, text);
    if (exit === "none") return;
    queueMicrotask(() => {
      model.focusItem(itemId);
      if (exit === "self") return;
      // Tab/Shift+Tab: keep moving through editors, not just labels — the
      // item Tabbed onto begins editing itself, if it's a field that has an
      // editor to begin (see `ItemHandle.beginEdit`).
      model.focusAdjacent(exit === "next");
      model.beginEditAtFocused(true);
    });
  };

  return (
    <>
      <div className="flex min-h-[26px] items-center gap-1 py-0.5">
        <ExpansionToggle
          expandable={expandable}
          expanded={expanded}
          label={field.label}
          onToggle={toggle}
        />
        <div className="relative shrink-0">
          <FieldLabel
            field={field}
            itemId={itemId}
            menuOpen={menuOpen}
            onClick={() => model.focusItem(itemId)}
            onDblClick={activate}
            onFocus={() => model.noteFocus(itemId)}
            onKeyDown={onLabelKeyDown}
            onContextMenu={(e) => openMenu(e, "field")}
          />
          {/* A field of a record still being created shows no star of its own:
              there's nothing yet to compare it against. The record's parent
              still wears one, for having gained it. */}
          {!props.isNew && modified && <ModifiedStar label={field.label} />}
        </div>
        {field.kind === "multiRecord" && count !== undefined && (
          <span className="bg-edge/50 text-ink-weak rounded-full px-2 text-xs leading-[18px]">
            {count}
          </span>
        )}
        {/* Records that hold different numbers of related records say so the
            same way a field they disagree on does. */}
        {variedCount && <VariedValue />}

        {/* The one way into a multi-record field that doesn't need a record to
            already be there: add one. Like the expansion toggle beside it, it's
            a control *on* the field rather than an item of its own, so it isn't
            focusable and doesn't take focus when clicked. */}
        {field.kind === "multiRecord" &&
          field.keyColumns.length > 0 &&
          !bulkBlocked && (
            <IconButton
              icon={Icons.Add}
              label={`Add ${field.label}`}
              size="sm"
              tabIndex={-1}
              onClick={() => model.addChild(recordId, field)}
            />
          )}

        {/* What a multi-record field offers while the form is on several
            records: nothing yet. The records under it belong to one record
            each, and editing them together is separate work still to come.
            Smaller than a value, since it's about the form rather than about
            the data — and it has a sidebar's width to fit into. */}
        {field.kind === "multiRecord" && bulkBlocked && (
          <span className="text-ink-weak min-w-0 flex-1 truncate text-xs italic">
            Bulk modification not yet supported
          </span>
        )}

        {/* A scalar linked record field shows the record it points at, rather
            than the id it holds. It isn't focusable — the field's label is what
            the user selects — so clicking it lands there. The button beside it
            clears the field, dropping the record it points at with it — the
            same action, and the same icon, as "Clear" on its context menu. */}
        {linked && (
          <>
            <LoadingRegion
              loading={embedLoading}
              className="flex min-w-0 flex-1"
            >
              <EmbeddedRecord
                cells={embedCells}
                isNew={embedIsNew}
                onClick={() => model.focusItem(itemId)}
                onDblClick={() => model.toggleField(recordId, field)}
                onContextMenu={(e) => openMenu(e, "scalarEmbed")}
              />
            </LoadingRegion>
            <IconButton
              icon={Icons.Clear}
              label={`Clear ${field.label}`}
              size="sm"
              tabIndex={-1}
              onClick={() => model.clearField(recordId, field)}
            />
          </>
        )}

        {plainValue && (
          <FieldValueSlot
            model={model}
            recordId={recordId}
            field={field}
            value={value}
            expanded={false}
            onBeginEdit={beginEdit}
            onCommit={commit}
            onContextMenu={(e) => openMenu(e, "field")}
            onOverflow={setOverflowing}
          />
        )}
      </div>

      {/* Expanded text: the same value, given the full width below the label —
          under the same tree line every other kind of expansion draws. */}
      {textBelow && (
        <Subtree>
          <div className="pr-1 pb-1">
            <FieldValueSlot
              model={model}
              recordId={recordId}
              field={field}
              value={value}
              expanded={true}
              onBeginEdit={beginEdit}
              onCommit={commit}
              onContextMenu={(e) => openMenu(e, "field")}
            />
          </div>
        </Subtree>
      )}

      {/* A linked record expands into its own form. */}
      {expanded && field.kind === "scalarLink" && (
        <Subtree>
          <RecordNodeView model={model} recordId={embedId} />
        </Subtree>
      )}

      {/* A multi-record field expands into the records that reference this one. */}
      {expanded && field.kind === "multiRecord" && (
        <Subtree>
          <ChildList model={model} recordId={recordId} field={field} />
        </Subtree>
      )}
    </>
  );
}

/** Indents a row's children and draws the tree line down their left edge. */
function Subtree(props: { children: ReactNode }): JSX.Element {
  return <div className="border-edge ml-2 border-l pl-2">{props.children}</div>;
}

/** Wires a field value's edit mode to the model. (`multiRecord` fields never
 * reach here — they show a count instead, and the caller narrows them out.)
 * Its own component so that only the row entering or leaving edit mode
 * re-renders when `editing` moves. */
function FieldValueSlot(props: {
  model: RecordFormModel;
  recordId: string;
  field: PrimitiveField | ScalarLinkField;
  value: SharedValue;
  expanded: boolean;
  onBeginEdit: () => void;
  onCommit: (text: string, exit: EditExit) => void;
  onContextMenu: (e: MouseEvent) => void;
  onOverflow?: (overflowing: boolean) => void;
}): JSX.Element {
  const { model, recordId, field } = props;
  const itemId = fieldItemId(recordId, field.key);
  const editing = useFormState(model, (s) => s.editing === itemId);
  const editingSelectAll = useFormState(model, (s) => s.editingSelectAll);
  return (
    <FieldValue
      field={field}
      value={props.value}
      editing={editing}
      editingSelectAll={editingSelectAll}
      expanded={props.expanded}
      onBeginEdit={() => props.onBeginEdit()}
      // Every keystroke goes into the form as it's typed, so what the user
      // sees elsewhere (the modification star, above all) is never a
      // keystroke behind.
      onInput={(text) => model.editValue(recordId, field.column, text)}
      onCommit={props.onCommit}
      onContextMenu={props.onContextMenu}
      onOverflow={props.onOverflow}
    />
  );
}

/** The records behind an expanded multi-record field. While they load, the
 * count the parent already reported is drawn as that many empty embedded
 * records, so the list has its real shape under the loading wash before any of
 * it arrives. */
function ChildList(props: {
  model: RecordFormModel;
  recordId: string;
  field: MultiRecordField;
}): JSX.Element | null {
  const { model } = props;
  const id = listId(props.recordId, props.field.key);
  const exists = useFormState(model, (s) => s.lists[id] !== undefined);
  const status = useFormState(model, (s) => s.lists[id]?.status);
  const expected = useFormState(model, (s) => s.lists[id]?.expected ?? 0);
  const childIds = useFormState(model, (s) => s.lists[id]?.childIds);
  const error = useFormState(model, (s) => s.lists[id]?.error ?? null);
  if (!exists) return null;
  const loading = status === "unloaded" || status === "loading";
  return (
    <LoadingRegion loading={loading}>
      {loading
        ? Array.from({ length: expected }, (_, i) => (
            <div
              key={i}
              className="flex min-h-[26px] items-center gap-1 py-0.5"
              data-testid="record-placeholder"
            >
              <span className="size-4 shrink-0" aria-hidden="true" />
              <EmbeddedRecord cells={NO_CELLS} />
            </div>
          ))
        : childIds?.map((childId) => (
            <ChildRow
              key={childId}
              model={model}
              parentId={props.recordId}
              field={props.field}
              listId={id}
              recordId={childId}
            />
          ))}
      {status === "error" && (
        <p className="text-danger px-1 py-0.5 text-xs">{error}</p>
      )}
    </LoadingRegion>
  );
}

/** One record within a multi-record field: an embedded record previewing it, and
 * — once expanded — that record's own form. This is the form's selectable item:
 * it can be clicked with the same range/toggle modifiers as a result row, so a
 * run of them can be deleted in one go. */
function ChildRow(props: {
  model: RecordFormModel;
  /** The record the multi-record field belongs to. */
  parentId: string;
  field: MultiRecordField;
  listId: string;
  recordId: string;
}): JSX.Element {
  const { model, parentId, field, recordId } = props;
  const expanded = useFormState(model, (s) => selectIsExpanded(s, recordId));
  const cells = useFormState(
    model,
    (s) => s.embeds[recordId]?.cells ?? NO_CELLS,
  );
  /** Whether this record is one the form is creating rather than one it
   * loaded — which is what the widget says, in place of a preview it has no
   * values for yet. */
  const isNew = useFormState(model, (s) => s.records[recordId]?.isNew === true);
  // A record within a multi-record field is always exactly one record.
  const keyText = useFormState(model, (s) => {
    const key = s.records[recordId]?.keys[0];
    return key ? key.map((part) => part.value).join(" ") : "";
  });
  const selected = useFormState(model, (s) => selectIsSelected(s, recordId));
  const recordModified = useFormState(model, (s) =>
    selectRecordModified(s, recordId),
  );

  /** What an expansion toggle's aria-label names this record: the preview it
   * shows, falling back to its key. */
  const label = isNew
    ? "new record"
    : cells.filter(Boolean).join(" ") || keyText;

  /** The records a menu raised on this one acts on: the whole selection when
   * this record is part of it, otherwise just this record. Fixed as the menu
   * opens — read from the model's current state at that moment — so the action
   * isn't at the mercy of what happens to the selection while the menu is up. */
  const menuTargets = (): string[] => {
    const s = model.store.getState();
    if (!selectIsSelected(s, recordId)) return [recordId];
    const siblings = s.lists[props.listId]?.childIds ?? [];
    return s.selection.filter((id) => siblings.includes(id));
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const targets = menuTargets();
    // Right-clicking outside the selection moves it here first, so the menu's
    // target is visible — the same courtesy the result rows extend.
    if (!selectIsSelected(model.store.getState(), recordId)) {
      model.clickEmbedded(recordId, { shift: false, ctrl: false });
    }
    model.openMenu({
      target: {
        kind: "childRecords",
        recordId: parentId,
        fieldKey: field.key,
        ids: targets,
      },
      x: e.clientX,
      y: e.clientY,
    });
  };

  // Like a field row, a child row stands for one record for its whole life
  // (it's keyed on the record's id).
  useEffect(() => {
    model.registerItem(recordId, {
      group: props.listId,
      expandable: () => true,
      setExpanded: (open) => model.toggleChild(recordId, open),
      remove: () => model.removeChild(parentId, field, recordId),
    });
    return () => model.unregisterItem(recordId);
  }, [model, recordId, props.listId, parentId, field]);

  return (
    <>
      <div className="flex min-h-[26px] items-center gap-1 py-0.5">
        <ExpansionToggle
          expandable={true}
          expanded={expanded}
          label={label}
          onToggle={(siblings) =>
            siblings
              ? model.toggleSiblings(recordId, !expanded)
              : model.toggleChild(recordId)
          }
        />
        <EmbeddedRecord
          cells={isNew ? NO_CELLS : cells}
          isNew={isNew}
          itemId={recordId}
          focusable
          selected={selected}
          modifiedLabel={!isNew && recordModified ? label : undefined}
          onContextMenu={onContextMenu}
          onClick={(e) => {
            // Clicking a widget selects it — and puts focus on it, since a
            // selected item is a focused one.
            e.currentTarget.focus();
            model.clickEmbedded(recordId, {
              shift: e.shiftKey,
              ctrl: e.ctrlKey || e.metaKey,
            });
          }}
          onDblClick={() => model.toggleChild(recordId)}
          onFocus={() => model.noteFocus(recordId)}
        />
        <IconButton
          icon={Icons.Delete}
          label={`Delete ${label}`}
          size="sm"
          tabIndex={-1}
          onClick={() => model.removeChild(parentId, field, recordId)}
        />
      </div>
      {expanded && (
        <Subtree>
          <RecordNodeView model={model} recordId={recordId} />
        </Subtree>
      )}
    </>
  );
}
