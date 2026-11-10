import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ContextQueryEditor from "./ContextQueryEditor";
import EmbedQuerydownEditor from "./EmbedQuerydownEditor";
import Pager from "../ui/Pager";
import EmbeddedRecord from "./EmbeddedRecord";
import ExpansionToggle from "./ExpansionToggle";
import FieldLabel, {
  fieldAppearance,
  LabelNameInput,
  type RenameEnd,
} from "./FieldLabel";
import FieldValue, {
  OneLineValue,
  ValueInput,
  type EditExit,
} from "./FieldValue";
import ModifiedStar from "./ModifiedStar";
import type { ValueAutocomplete } from "./ValueSuggestions";
import {
  distinctItemId,
  distinctValues,
  fieldItemId,
  listedValues,
  listId,
  scalarChildId,
  selectContextCount,
  selectCountMax,
  selectCountMin,
  selectDistinctCount,
  selectDistinctEdit,
  selectDistinctText,
  selectEmbedEditorOpen,
  selectFieldExpandable,
  selectFieldModified,
  selectHasLinkedRecord,
  selectCanAutocomplete,
  selectIsAutocompleting,
  selectIsExpanded,
  selectIsSelected,
  selectListsDistinct,
  selectQueryEditor,
  selectRecordCount,
  selectRecordModified,
  selectRunsContextQuery,
  selectSharedValue,
  VARIED,
  variedChildId,
  type DistinctValue,
  type RecordFormModel,
  type SharedValue,
} from "../../stores/recordForm";
import { selectContextualQuery, selectTableMetadata } from "../../stores/app";
import { useApp, useAppActions, useFormState } from "../../stores/react";
import { useChildDrag } from "../../gestures/useChildDrag";
import { useFieldDrag } from "../../gestures/useFieldDrag";
import { Icons } from "../../icons";
import { embedText } from "../../query/embedPreview";
import { arrangeFields, isFieldHidden } from "../../query/fieldMetadata";
import { nounFor } from "../../query/entityNames";
import {
  contextKeyColumn,
  isRunnable,
  listableTables,
} from "../../query/contextualQuery";
import DragChip, { dragChipTransform } from "../ui/DragChip";
import IconButton from "../ui/IconButton";
import { useTooltip } from "../ui/Tooltip";
import { cx } from "../ui/cx";
import LoadingRegion from "../ui/LoadingRegion";
import {
  fieldRef,
  type ContextQueryField,
  type DataField,
  type FormField,
  type MultiRecordField,
  type PrimitiveField,
  type ScalarLinkField,
} from "../../query/recordForm";

// The form's tree, rendered. The components here call each other in a cycle — a
// record's fields, a field's expansion, a multi-record field's children, and
// each of those children's own fields — which is what lets the user recurse into
// the data as deep as it goes, so they live in one file.
//
// The order a record's fields show in, and which of them show at all, is the
// user's to customize for the whole table (`query/fieldMetadata.ts`). That's
// applied here as they render rather than held in the form: a node's `fields`
// stay as the schema gives them, and every form on the table follows along.
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
// places the count shows are here in `FieldRow` — a field the records disagree
// on shows its distinct values in place of one value, and a multi-record field
// whose records hold different numbers of related records shows the range —
// and on a `ChildRow`, which says how many records its one row stands for.
//
// Every component subscribes to the form's store through narrow selectors that
// return primitives or references already in state (state management rule 2),
// so a keystroke re-renders the row being edited and the stars above it — not
// the tree. Rows are keyed on what they stand for (a field's key, a child
// record's id), which fixes each row's subject for its life.

/** The cells of an embedded record with no preview yet — one shared empty list,
 * so a selector falling back to it returns the same reference every time. */
const NO_CELLS: readonly (string | null)[] = [];

/** The bubble a count is drawn in — a field's related-record count, or the
 * number of records one row of such a field stands for. */
const BUBBLE =
  "bg-edge/50 text-ink-weak shrink-0 rounded-full px-2 text-xs leading-[18px]";

/** How many records a multi-record field holds. On several base records that's
 * a *range* — the fewest any one of them has, and the most — drawn as two
 * bubbles with the dash between rather than inside them, so each number still
 * reads as a count of its own rather than the pair reading as one odd value. */
function CountBadge(props: { min: number; max: number }): JSX.Element {
  if (props.min === props.max) {
    return <span className={BUBBLE}>{props.min}</span>;
  }
  return (
    <span className="text-ink-weak flex shrink-0 items-center gap-0.5 text-xs">
      <span className={BUBBLE}>{props.min}</span>–
      <span className={BUBBLE}>{props.max}</span>
    </span>
  );
}

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
  const table = useFormState(model, (s) => s.records[recordId]?.table);
  const concealed = useFormState(model, (s) => s.records[recordId]?.concealed);
  // A field the form keeps for itself (an ordered list's `order`) isn't shown.
  const shown = useMemo(
    () =>
      concealed && fields
        ? fields.filter(
            (field) =>
              !(
                (field.kind === "primitive" || field.kind === "scalarLink") &&
                concealed.includes(field.column)
              ),
          )
        : fields,
    [fields, concealed],
  );
  if (!shown || table === undefined) return null;
  return (
    <LoadingRegion loading={status === "loading"}>
      <FieldList
        model={model}
        recordId={recordId}
        table={table}
        isNew={isNew}
        fields={shown}
      />
      {status === "error" && (
        <p className="text-danger px-1 py-0.5 text-xs">{error}</p>
      )}
    </LoadingRegion>
  );
}

/** A record's fields as the user has arranged them for its table, and the drag
 * that rearranges them. A nested record's fields are a list of their own, within
 * one of the rows of this one, and a field can only be dropped in its own list:
 * rearranging is for one table at a time. */
function FieldList(props: {
  model: RecordFormModel;
  recordId: string;
  table: string;
  isNew: boolean;
  fields: readonly FormField[];
}): JSX.Element {
  const { model, recordId, table, fields } = props;
  const metadata = useApp((s) => selectTableMetadata(s, table));
  const showHidden = useApp((s) => s.showHiddenFields);
  const { moveField } = useAppActions();
  const shown = useMemo(
    () => arrangeFields(fields, metadata, showHidden),
    [fields, metadata, showHidden],
  );

  const listRef = useRef<HTMLDivElement>(null);
  const dnd = useFieldDrag({
    listRef,
    keys: shown.map((field) => field.key),
    onDrop: (key, target) => {
      const refOf = (shownKey: string | undefined) => {
        const field = shown.find((f) => f.key === shownKey);
        return field && fieldRef(field);
      };
      const moved = refOf(key);
      return (
        moved !== undefined &&
        moveField(table, moved, refOf(target.above), refOf(target.below))
      );
    },
    onHold: (key, x, y) =>
      model.openMenu({
        target: { kind: "field", recordId, fieldKey: key },
        x,
        y,
      }),
  });
  const drag = dnd.drag;
  const dragged = shown.find((field) => field.key === drag?.item);
  const provisional = useFormState(
    model,
    (s) => s.provisional?.recordId === recordId,
  );

  return (
    <div ref={listRef} className="relative">
      {shown.map((field) => (
        <div
          key={field.key}
          data-field-row
          className={cx({ "opacity-50": field.key === drag?.item })}
        >
          {field.kind === "contextQuery" ? (
            <ContextQueryRow
              model={model}
              recordId={recordId}
              table={table}
              field={field}
              hiddenField={isFieldHidden(metadata, fieldRef(field))}
              onLabelPointerDown={(e) => dnd.onPointerDown(e, field.key)}
              labelPressed={dnd.pressing}
            />
          ) : (
            <FieldRow
              model={model}
              recordId={recordId}
              table={table}
              isNew={props.isNew}
              field={field}
              hiddenField={isFieldHidden(metadata, fieldRef(field))}
              onLabelPointerDown={(e) => dnd.onPointerDown(e, field.key)}
              labelPressed={dnd.pressing}
            />
          )}
        </div>
      ))}
      {provisional && <ProvisionalRow model={model} table={table} />}
      {drag?.target && (
        <div
          aria-hidden="true"
          className="bg-accent pointer-events-none absolute right-1 left-5 h-0.5 -translate-y-1/2 rounded-full"
          style={{ top: drag.lineTop }}
        />
      )}
      {drag &&
        dragged &&
        createPortal(
          <DragChip
            icon={fieldAppearance(dragged).icon}
            label={dragged.label}
            style={{ transform: dragChipTransform(drag.x, drag.y) }}
          />,
          document.body,
        )}
    </div>
  );
}

/** One field: its row, plus whatever the row expands into. (A contextual query's
 * field has a row of its own, `ContextQueryRow`.) */
function FieldRow(props: {
  model: RecordFormModel;
  recordId: string;
  /** The table of the record this field belongs to. */
  table: string;
  /** Whether the record this field belongs to is one the form is creating. */
  isNew: boolean;
  field: DataField;
  /** Whether the user has hidden this field, and it's on show regardless. */
  hiddenField: boolean;
  /** A press on the field's label, which may be the start of a drag. */
  onLabelPointerDown: (e: PointerEvent<HTMLElement>) => void;
  /** Whether a touch is resting on a label, on its way to picking it up. */
  labelPressed: () => boolean;
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

  /** The record count behind a multi-record field: the fewest and the most its
   * records hold, which are the same number unless the form is on several that
   * disagree. `undefined` before they land (or for any other kind of field). */
  const countMin = useFormState(model, (s) =>
    field.kind === "multiRecord"
      ? selectCountMin(s, recordId, field.key)
      : undefined,
  );
  const countMax = useFormState(model, (s) =>
    field.kind === "multiRecord"
      ? selectCountMax(s, recordId, field.key)
      : undefined,
  );

  /** The column value behind any other field: `undefined` until loaded,
   * `VARIED` when the records disagree. */
  const value: SharedValue = useFormState(model, (s) =>
    field.kind === "multiRecord"
      ? undefined
      : selectSharedValue(s, recordId, field.column),
  );

  const expandable = useFormState(model, (s) =>
    selectFieldExpandable(s, recordId, field, overflowing),
  );

  // A text field only has anything to expand once its value is measured and
  // turns out to be cut off, so that's when a remembered expansion can land.
  useLayoutEffect(() => {
    if (field.kind === "primitive" && expandable) {
      model.restoreTextField(recordId, field.key);
    }
  }, [model, recordId, field, expandable]);

  /** Whether the records the form is on disagree about this field — the state
   * with no value of its own to show, which expands into the values they hold
   * instead (`DistinctValues`). Never true on one record, which cannot disagree
   * with itself. Still true while one of those values is being edited, though
   * the edit may have brought the records into agreement for now: the list
   * stays up under the editor until the edit is done. */
  const varied = useFormState(
    model,
    (s) =>
      field.kind !== "multiRecord" &&
      selectListsDistinct(s, recordId, field.column),
  );
  /** How many different values that is — what the row shows in place of one. */
  const distinct = useFormState(model, (s) =>
    varied ? selectDistinctCount(s, recordId, field.column) : 0,
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

  /** Whether the Querydown behind this field's embedded records is being edited,
   * for the parts of it a field can have any. */
  const displayOpen = useFormState(model, (s) =>
    selectEmbedEditorOpen(s, recordId, field.key, "display"),
  );
  const sortingOpen = useFormState(model, (s) =>
    selectEmbedEditorOpen(s, recordId, field.key, "sorting"),
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
  const embedColumns = useFormState(model, (s) => s.embeds[embedId]?.columns);

  /** Whether the embedded record's preview is still on its way. A record the
   * form is *creating* has no preview to wait for — it renders as "New" — and one
   * that failed to load has stopped waiting, its key standing in. */
  const embedLoading =
    embedIsNew !== true && embedStatus !== "loaded" && embedStatus !== "error";

  /** An expanded *text* field moves its value below the label, where it has the
   * width to wrap; an expanded link/record field grows a subtree instead. A
   * field the records disagree on has no value to move: what's below it is the
   * list of values they do hold. */
  const textBelow = field.kind === "primitive" && expanded && !varied;

  /** Whether the row's value renders as plain text (or a pencil, or the count
   * of what the records disagree about): everything except a record count, an
   * embedded record, and text that has moved below its label. */
  const plainValue = field.kind !== "multiRecord" && !textBelow && !linked;

  // What this row can do to itself, for the keyboard commands. Registered from
  // an effect, so every closure reads the model's current state rather than
  // this render's values (see `ItemHandle`). Only an editable primitive field
  // has an editor to Tab into.
  useEffect(() => {
    model.registerItem(itemId, {
      group: recordId,
      expandable: () =>
        selectFieldExpandable(
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
   * multi-record field opens or closes.
   *
   * A scalar field the records *disagree* on has neither an edit to begin nor
   * one record to re-point, so it opens or closes too — onto the values they
   * hold, which is where both of those become possible again. */
  const activate = () => {
    if (varied || field.kind === "multiRecord") {
      model.toggleField(recordId, field);
    } else if (field.kind === "primitive") {
      model.beginEdit(recordId, field.key);
    } else {
      model.openPicker(recordId, field.key);
    }
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
      <div className="flex min-h-[30px] items-center gap-1 py-0.5">
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
            hiddenField={props.hiddenField}
            onClick={() => model.focusItem(itemId)}
            onDblClick={activate}
            onFocus={() => model.noteFocus(itemId)}
            onKeyDown={onLabelKeyDown}
            onContextMenu={(e) => {
              e.preventDefault();
              // A touch resting on the label is picking it up; its menu comes
              // with the release, if the field isn't moved.
              if (!props.labelPressed()) openMenu(e, "field");
            }}
            onPointerDown={props.onLabelPointerDown}
          />
          {/* A field of a record still being created shows no star of its own:
              there's nothing yet to compare it against. The record's parent
              still wears one, for having gained it. */}
          {!props.isNew && modified && <ModifiedStar label={field.label} />}
        </div>
        {countMin !== undefined && countMax !== undefined && (
          <CountBadge min={countMin} max={countMax} />
        )}

        {/* The one way into a multi-record field that doesn't need a record to
            already be there: add one. Like the expansion toggle beside it, it's
            a control *on* the field rather than an item of its own, so it isn't
            focusable and doesn't take focus when clicked. */}
        {field.kind === "multiRecord" && field.keyColumns.length > 0 && (
          <IconButton
            icon={Icons.Add}
            label={`Add ${nounFor(field.table, 1) ?? field.label}`}
            size="sm"
            tabIndex={-1}
            onClick={() => model.addChild(recordId, field)}
          />
        )}

        {/* The same records, as rows of a query tab of their own. A record the
            form is still creating has none to open, so it gets no button. */}
        {field.kind === "multiRecord" && !props.isNew && (
          <IconButton
            icon={Icons.OpenInTab}
            label={`Open ${field.label} in new tab`}
            size="sm"
            tabIndex={-1}
            onClick={() => model.openChildRecords(recordId, field)}
          />
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
                columns={embedColumns}
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
            value={varied ? VARIED : value}
            distinct={distinct}
            expanded={false}
            onBeginEdit={beginEdit}
            onCommit={commit}
            onContextMenu={(e) => openMenu(e, "field")}
            onOverflow={setOverflowing}
          />
        )}

        {field.kind === "multiRecord" && field.ordered && <OrderedNote />}
      </div>

      {/* Between the row and what it expands into, so the records being changed
          are right below the text changing them. */}
      {field.kind !== "primitive" && displayOpen && (
        <EmbedQuerydownEditor
          model={model}
          recordId={recordId}
          table={props.table}
          field={field}
          section="display"
        />
      )}
      {field.kind !== "primitive" && sortingOpen && (
        <EmbedQuerydownEditor
          model={model}
          recordId={recordId}
          table={props.table}
          field={field}
          section="sorting"
        />
      )}

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
              distinct={distinct}
              expanded={true}
              onBeginEdit={beginEdit}
              onCommit={commit}
              onContextMenu={(e) => openMenu(e, "field")}
            />
          </div>
        </Subtree>
      )}

      {/* A field the records disagree on expands into the values they hold. */}
      {expanded && varied && field.kind !== "multiRecord" && (
        <Subtree>
          <DistinctValues model={model} recordId={recordId} field={field} />
        </Subtree>
      )}

      {/* A linked record expands into its own form. */}
      {expanded && !varied && field.kind === "scalarLink" && (
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

/** "(ordered)": a multi-record field's records are kept in an order of the
 * user's own, which hovering it explains. */
function OrderedNote(): JSX.Element {
  const { triggerProps, tooltip } = useTooltip({
    label: "Ordered",
    description:
      "These records are kept in the order shown, by their order column. New ones go at the end, and dragging records — or a selection of them — moves them. The new order is written when you save.",
    align: "end",
  });
  return (
    <>
      <span
        {...triggerProps}
        className="text-ink-weak ml-auto shrink-0 cursor-default pr-1 text-xs select-none"
      >
        (ordered)
      </span>
      {tooltip}
    </>
  );
}

/** The classes of a `<select>`, as every one in the app has them. */
const SELECT =
  "control bg-panel border-edge text-ink focus:border-accent h-[26px] rounded-md py-0 outline-none";

/** Where focus goes once a label's rename ends: back to the label, and on along
 * the fields for a Tab. A rename ended by focus going elsewhere leaves it there. */
function focusAfterRename(
  model: RecordFormModel,
  itemId: string,
  end: RenameEnd | null,
): void {
  if (end === "blur") return;
  queueMicrotask(() => {
    model.focusItem(itemId);
    if (end === "tab" || end === "backTab") model.focusAdjacent(end === "tab");
  });
}

/** A contextual query's field: its label, the number of records the query found
 * once it has run, and the way to open them in a query tab of their own — then,
 * below, the query's editor while it's open, and once expanded, the records. A
 * query doesn't run until the field is expanded, nor without a filter.
 *
 * Only a single record the database holds runs one: `@id` has no one value on
 * several records, nor any on a record still being created, so on those the
 * field shows, to be arranged and edited like any other, with nothing to open. */
function ContextQueryRow(props: {
  model: RecordFormModel;
  recordId: string;
  /** The table of the record this field belongs to. */
  table: string;
  field: ContextQueryField;
  /** Whether the user has hidden this field, and it's on show regardless. */
  hiddenField: boolean;
  /** A press on the field's label, which may be the start of a drag. */
  onLabelPointerDown: (e: PointerEvent<HTMLElement>) => void;
  /** Whether a touch is resting on a label, on its way to picking it up. */
  labelPressed: () => boolean;
}): JSX.Element {
  const { model, recordId, field } = props;
  const itemId = fieldItemId(recordId, field.key);
  const expanded = useFormState(model, (s) => selectIsExpanded(s, itemId));
  const runs = useFormState(model, (s) => selectRunsContextQuery(s, recordId));
  const count = useFormState(model, (s) =>
    selectContextCount(s, recordId, field.key),
  );
  const modified = useFormState(model, (s) =>
    selectFieldModified(s, recordId, field.key),
  );
  const menuOpen = useFormState(model, (s) => {
    const target = s.menu?.target;
    return (
      target?.kind === "field" &&
      target.recordId === recordId &&
      target.fieldKey === field.key
    );
  });
  const renaming = useFormState(model, (s) => s.renaming === itemId);
  const section = useFormState(model, (s) =>
    selectQueryEditor(s, recordId, field.key),
  );
  const runnable = useApp((s) => {
    const query = selectContextualQuery(s, field.queryId);
    return query !== undefined && isRunnable(query.definition);
  });
  const keyColumn = useApp((s) =>
    contextKeyColumn(s.schema.tables, props.table),
  );
  /** What `@id` stands for here: the record's key. */
  const idValue = useFormState(model, (s) =>
    keyColumn === undefined
      ? null
      : (s.records[recordId]?.values[keyColumn]?.[0] ?? null),
  );
  const { renameContextualQuery } = useAppActions();

  useEffect(() => {
    model.registerItem(itemId, {
      group: recordId,
      expandable: () =>
        selectRunsContextQuery(model.store.getState(), recordId),
      setExpanded: (open) => model.toggleField(recordId, field, open),
      // What a query found isn't the record's to delete.
      remove: () => {},
    });
    return () => model.unregisterItem(itemId);
  }, [model, itemId, recordId, field]);

  const toggle = () => model.toggleField(recordId, field);

  return (
    <>
      <div className="flex min-h-[30px] items-center gap-1 py-0.5">
        <ExpansionToggle
          expandable={runs}
          expanded={expanded}
          label={field.label}
          onToggle={(siblings) =>
            siblings ? model.toggleSiblings(itemId, !expanded) : toggle()
          }
        />
        <div className="relative shrink-0">
          <FieldLabel
            field={field}
            itemId={itemId}
            menuOpen={menuOpen}
            hiddenField={props.hiddenField}
            onClick={() => model.focusItem(itemId)}
            onDblClick={toggle}
            onFocus={() => model.noteFocus(itemId)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              toggle();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (props.labelPressed()) return;
              model.openMenu({
                target: { kind: "field", recordId, fieldKey: field.key },
                x: e.clientX,
                y: e.clientY,
              });
            }}
            onPointerDown={props.onLabelPointerDown}
            rename={
              renaming
                ? {
                    onCommit: (name, end) => {
                      renameContextualQuery(field.queryId, name);
                      model.endRename();
                      focusAfterRename(model, itemId, end);
                    },
                    onCancel: () => {
                      model.endRename();
                      focusAfterRename(model, itemId, null);
                    },
                  }
                : undefined
            }
          />
          {modified && <ModifiedStar label={field.label} />}
        </div>
        {count !== undefined && <CountBadge min={count} max={count} />}
        {/* Off until the query has a filter: without one, the tab would list
            every record of its table. */}
        {runs && (
          <IconButton
            icon={Icons.OpenInTab}
            label={`Open ${field.label} in new tab`}
            size="sm"
            tabIndex={-1}
            disabled={!runnable}
            onClick={() => model.openContextRecords(recordId, field)}
          />
        )}
      </div>

      {section !== null && (
        <ContextQueryEditor
          model={model}
          recordId={recordId}
          field={field}
          section={section}
          idValue={idValue}
        />
      )}

      {expanded && runs && (
        <Subtree>
          {runnable ? (
            <ChildList model={model} recordId={recordId} field={field} />
          ) : (
            <p className="text-ink-weak px-1 py-0.5 text-xs italic">
              Write a filter to run this query.
            </p>
          )}
        </Subtree>
      )}
    </>
  );
}

/** A contextual query being added (`RecordFormActions.addProvisional`) — not a
 * field yet, but what makes one: a name, being typed as it appears, and the table
 * the query is to list, chosen from the Base selector beside it, which turns this
 * into the query's field. Escape while it's being named, or the ×, drops it. */
function ProvisionalRow(props: {
  model: RecordFormModel;
  /** The table of the record whose fields it's among. */
  table: string;
}): JSX.Element {
  const { model } = props;
  const name = useFormState(model, (s) => s.provisional?.name ?? "");
  const naming = useFormState(model, (s) => s.provisional?.naming === true);
  const tables = useApp((s) => s.schema.tables);
  const { addContextualQuery } = useAppActions();
  const selectRef = useRef<HTMLSelectElement>(null);
  const selectId = useId();

  const choose = (base: string) => {
    if (base === "") return;
    model.finishProvisional(addContextualQuery(props.table, name, base));
  };

  return (
    <div
      className="flex min-h-[30px] items-center gap-1 py-0.5"
      data-testid="provisional-query"
    >
      <span className="size-4 shrink-0" aria-hidden="true" />
      <span
        className="text-ink bg-field-query flex shrink-0 cursor-default items-center gap-1 rounded-md border-2 border-transparent px-1.5 py-px text-xs/5 select-none"
        onDoubleClick={() => model.setProvisionalNaming(true)}
      >
        <Icons.FieldQuery className="size-3.5 shrink-0 opacity-70" />
        {naming ? (
          <LabelNameInput
            label="Name of the new query"
            name={name}
            rename={{
              onCommit: (next, end) => {
                model.setProvisionalName(next.trim() || name);
                model.setProvisionalNaming(false);
                // Named, it wants a table to list next.
                if (end === "enter" || end === "tab") {
                  queueMicrotask(() => selectRef.current?.focus());
                }
              },
              onCancel: () => model.discardProvisional(),
            }}
          />
        ) : (
          <span className="max-w-40 truncate">{name}</span>
        )}
      </span>
      <label
        htmlFor={selectId}
        className="text-ink-weak flex shrink-0 items-center gap-0.5 pl-1 text-xs"
      >
        <Icons.Base className="size-4" />
        Base
      </label>
      <select
        ref={selectRef}
        id={selectId}
        className={cx(SELECT, "min-w-0 flex-1")}
        value=""
        onChange={(e) => choose(e.currentTarget.value)}
      >
        <option value="" disabled>
          Choose a table…
        </option>
        {listableTables(tables).map((table) => (
          <option key={table.name} value={table.name}>
            {table.name}
          </option>
        ))}
      </select>
      <IconButton
        icon={Icons.Close}
        label="Discard new query"
        size="sm"
        onClick={() => model.discardProvisional()}
      />
    </div>
  );
}

/** Indents a row's children and draws the tree line down their left edge. */
function Subtree(props: { children: ReactNode }): JSX.Element {
  return <div className="border-edge ml-2 border-l pl-2">{props.children}</div>;
}

/** What a value's text box offers as it's edited: its column's values, for a box
 * in edit mode whose field can have them. */
function useAutocomplete(
  model: RecordFormModel,
  recordId: string,
  field: PrimitiveField | ScalarLinkField,
  itemId: string,
): ValueAutocomplete | undefined {
  const available = useFormState(
    model,
    (s) => s.editing === itemId && selectCanAutocomplete(s),
  );
  const active = useFormState(model, (s) => selectIsAutocompleting(s, itemId));
  if (!available || field.kind !== "primitive") return undefined;
  return {
    active,
    toggle: () => model.toggleAutocomplete(),
    close: () => model.closeAutocomplete(),
    search: (text) => model.searchValues(recordId, field, text),
  };
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
  /** How many different values the records hold, when they disagree. */
  distinct: number;
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
  const autocomplete = useAutocomplete(model, recordId, field, itemId);
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
      distinct={props.distinct}
      autocomplete={autocomplete}
    />
  );
}

/** A distinct value's key within its list — `null` and the string `"null"` are
 * two different values, and both can be in it. */
const valueKey = (value: string | null): string =>
  value === null ? "\u0000null" : `=${value}`;

/** What a scalar field the records the form is on disagree about expands into:
 * every value they hold, the commonest first, each with how many of them hold
 * it and a button that takes it for all of them — which is how such a field
 * gets one value to be the form's, there being nothing to type into a row that
 * shows no value.
 *
 * A linked record field shows each value as the record it points at, expandable
 * into that record's own form exactly as the single record of a field they
 * agree on is — so the user can look at what they're choosing between before
 * choosing. */
function DistinctValues(props: {
  model: RecordFormModel;
  recordId: string;
  field: PrimitiveField | ScalarLinkField;
}): JSX.Element {
  const { model, recordId, field } = props;
  // The column as the node holds it — a reference already in state, so the list
  // below is rebuilt when that column is written and at no other time.
  const column = useFormState(
    model,
    (s) => s.records[recordId]?.values[field.column],
  );
  // An edit to one of the values holds the list still while it's typed (see
  // `listedValues`).
  const edit = useFormState(model, (s) =>
    selectDistinctEdit(s, recordId, field.column),
  );
  const values = useMemo(
    () => distinctValues(listedValues(column, edit)),
    [column, edit],
  );
  return (
    <>
      {values.map((distinct) => (
        <DistinctValueRow
          key={valueKey(distinct.value)}
          model={model}
          recordId={recordId}
          field={field}
          distinct={distinct}
        />
      ))}
    </>
  );
}

/** One of those values: how many records hold it, the value itself, and the
 * paint roller that gives it to the rest of them. Its own component so that a
 * preview landing — or the record behind it being opened — re-renders one row
 * rather than the list.
 *
 * The value is editable where it stands, and the edit is to *it*: whatever the
 * user types goes into every record holding it, the rest keeping theirs. A
 * primitive value opens an editor, exactly as a field's value does; a linked
 * record opens the record picker. A text value cut off on its one line expands,
 * like a field's, into the whole of it below its row. */
function DistinctValueRow(props: {
  model: RecordFormModel;
  recordId: string;
  field: PrimitiveField | ScalarLinkField;
  distinct: DistinctValue;
}): JSX.Element {
  const { model, recordId, field } = props;
  const { value, count } = props.distinct;
  const readOnly = field.kind === "primitive" && field.readOnly;

  /** The record this value points at, when it names one: a linked record field
   * whose value is neither NULL nor blank. Everything else is a value to read,
   * edit and take, with nothing to open. */
  const childId =
    field.kind === "scalarLink" && value != null && value !== ""
      ? variedChildId(recordId, field.key, value)
      : undefined;
  /** The id the value itself is edited — and, when it's text with no record to
   * open, expanded — under. */
  const itemId = distinctItemId(recordId, field.key, value);
  const expandId = childId ?? itemId;
  const expanded = useFormState(model, (s) => selectIsExpanded(s, expandId));
  const editing = useFormState(model, (s) => s.editing === itemId);
  const autocomplete = useAutocomplete(model, recordId, field, itemId);
  /** What its text box holds: the value, or what it's been edited to so far. */
  const inputText = useFormState(model, (s) =>
    selectDistinctText(s, itemId, value),
  );
  const cells = useFormState(
    model,
    (s) => (childId && s.embeds[childId]?.cells) || NO_CELLS,
  );
  const columns = useFormState(model, (s) =>
    childId ? s.embeds[childId]?.columns : undefined,
  );
  const loading = useFormState(
    model,
    (s) =>
      childId !== undefined &&
      s.embeds[childId]?.status !== "loaded" &&
      s.embeds[childId]?.status !== "error",
  );

  // Whether the value is cut off on its one line — reported up from the line
  // itself, as a field's is (see `FieldRow`).
  const [overflowing, setOverflowing] = useState(false);
  /** Text with something in it: what can wrap, below the row. */
  const text =
    field.kind === "primitive" &&
    field.valueType === "text" &&
    value != null &&
    value !== "";
  /** Whether that text is what the row expands into. An expanded value has no
   * line left to overflow, so having been expanded is reason enough to keep the
   * toggle that closes it. */
  const textBelow = text && expanded;
  const expandable =
    childId !== undefined || (text && (overflowing || expanded));

  /** What the expansion toggle's aria-label names: the preview, while it has
   * one, falling back to the id it was loaded from. */
  const label = embedText({ cells, columns }) || (value ?? "");
  const records = `${count} ${count === 1 ? "record" : "records"}`;

  const beginEdit = () => {
    if (readOnly) return;
    if (field.kind === "scalarLink") {
      model.openPicker(recordId, field.key, { value });
    } else {
      model.beginEditDistinct(recordId, field, value);
    }
  };

  /** Leaving edit mode, as a field's editor does (see `FieldRow`) — except
   * that focus goes back to the field's label, the value itself not being an
   * item the keyboard moves between. */
  const commit = (input: string, exit: EditExit) => {
    model.commitDistinct(input);
    if (exit === "none") return;
    const fieldId = fieldItemId(recordId, field.key);
    queueMicrotask(() => {
      model.focusItem(fieldId);
      if (exit === "self") return;
      model.focusAdjacent(exit === "next");
      model.beginEditAtFocused(true);
    });
  };

  /** Whether the value sits in its text box: always, if it has any text to
   * select and it's the user's to edit. A value with no text says what it is
   * instead, until it's clicked. */
  const inBox = editing || (!readOnly && value != null && value !== "");
  const input = (
    <ValueInput
      text={inputText}
      label={field.label}
      editing={editing}
      expanded={textBelow}
      multiline={field.kind === "primitive" && field.valueType === "text"}
      numeric={field.kind === "primitive" && field.valueType === "number"}
      selectAll={false}
      autocomplete={autocomplete}
      onBeginEdit={beginEdit}
      onInput={(input) => model.editDistinct(input)}
      onCommit={commit}
      onOverflow={setOverflowing}
    />
  );

  return (
    <>
      <div className="flex min-h-[30px] items-center gap-1 py-0.5">
        <ExpansionToggle
          expandable={expandable}
          expanded={expanded}
          label={label}
          onToggle={() => model.toggleChild(expandId)}
        />
        <span className={BUBBLE} aria-label={records}>
          {count}
        </span>
        {childId !== undefined ? (
          <LoadingRegion loading={loading} className="flex min-w-0 flex-1">
            <EmbeddedRecord
              cells={cells}
              columns={columns}
              onDblClick={() => model.toggleChild(childId)}
            />
          </LoadingRegion>
        ) : textBelow ? (
          <span className="flex-1" />
        ) : inBox ? (
          input
        ) : (
          <DistinctText
            value={value}
            editable={!readOnly}
            onClick={beginEdit}
            onOverflow={setOverflowing}
          />
        )}
        {/* A linked record has no text to click into: re-pointing the records
            that hold it is a button of its own. */}
        {childId !== undefined && (
          <IconButton
            icon={Icons.Edit}
            label={`Pick another record for ${records}`}
            size="sm"
            tabIndex={-1}
            onClick={beginEdit}
          />
        )}
        {/* A primary key is issued by the database, not the user: its values
            are worth reading side by side, but none of them is one to hand to
            the other records. */}
        {!readOnly && (
          <IconButton
            icon={Icons.PaintRoller}
            label="Use this value for all records"
            size="sm"
            tabIndex={-1}
            onClick={() => model.useValueForAll(recordId, field, value)}
          />
        )}
      </div>
      {/* Expanded text: the whole value, given the full width below the row,
          the way a field's expanded text is. */}
      {textBelow && (
        <Subtree>
          <div className="pr-1 pb-1">
            {inBox ? (
              input
            ) : (
              <span className="control text-ink block w-full cursor-default break-words whitespace-pre-wrap">
                {value}
              </span>
            )}
          </div>
        </Subtree>
      )}
      {expanded && childId !== undefined && (
        <Subtree>
          <RecordNodeView model={model} recordId={childId} />
        </Subtree>
      )}
    </>
  );
}

/** One distinct value out of its text box, on one line: a primary key's text,
 * or what it is when it says nothing — the two empties a column can hold are
 * named rather than drawn as a blank line, since a list of values has to
 * distinguish them. */
function DistinctText(props: {
  value: string | null;
  editable: boolean;
  onClick: () => void;
  onOverflow: (overflowing: boolean) => void;
}): JSX.Element {
  if (props.value === null || props.value === "") {
    return (
      <span
        className={cx(
          "control text-ink-weak min-w-0 flex-1 truncate italic",
          props.editable ? "cursor-text" : "cursor-default",
        )}
        onClick={() => props.onClick()}
      >
        {props.value === null ? "NULL" : "(empty string)"}
      </span>
    );
  }
  return (
    <OneLineValue
      text={props.value}
      className="control text-ink block min-w-0 flex-1 cursor-default truncate"
      onOverflow={props.onOverflow}
    />
  );
}

/** How many of a multi-record field's records are drawn at once. */
const CHILDREN_PER_PAGE = 30;

const pageCount = (total: number): number =>
  Math.ceil(total / CHILDREN_PER_PAGE);

/** The records behind an expanded multi-record field. While they load, the
 * count the parent already reported is drawn as that many empty embedded
 * records, so the list has its real shape under the loading wash before any of
 * it arrives.
 *
 * Or the records a contextual query found, which have no count to go by until
 * they've arrived: one placeholder stands in for them the first time, and as many
 * as there were the next. */
function ChildList(props: {
  model: RecordFormModel;
  recordId: string;
  field: MultiRecordField | ContextQueryField;
}): JSX.Element | null {
  const { model, field } = props;
  const id = listId(props.recordId, field.key);
  const exists = useFormState(model, (s) => s.lists[id] !== undefined);
  const status = useFormState(model, (s) => s.lists[id]?.status);
  const expected = useFormState(model, (s) => s.lists[id]?.expected ?? 0);
  const childIds = useFormState(model, (s) => s.lists[id]?.childIds);
  const error = useFormState(model, (s) => s.lists[id]?.error ?? null);
  const selection = useFormState(model, (s) => s.selection);
  const [requested, setPage] = useState(0);
  const total = childIds?.length ?? 0;
  // Records can leave the list under the page being shown: stay on the last.
  const page = Math.min(requested, Math.max(0, pageCount(total) - 1));
  const shown = useMemo(
    () =>
      childIds?.slice(page * CHILDREN_PER_PAGE, (page + 1) * CHILDREN_PER_PAGE),
    [childIds, page],
  );
  const loading = status === "unloaded" || status === "loading";

  /** Whether the user can drag these records into an order: a field whose
   * records are kept in one, on a single record — on several, each has its own
   * order, which no one list could rearrange. */
  const single = useFormState(
    model,
    (s) => (s.records[props.recordId]?.keys.length ?? 0) <= 1,
  );
  const draggable =
    field.kind === "multiRecord" && field.ordered && single && !loading;

  /** What picking up `child` takes along: the selection, when it's part of
   * it, in the order the list has them. */
  const moving = (child: string): string[] => {
    const s = model.store.getState();
    if (!s.selection.includes(child)) return [child];
    return (s.lists[id]?.childIds ?? []).filter((c) => s.selection.includes(c));
  };

  const listRef = useRef<HTMLDivElement>(null);
  const dnd = useChildDrag({
    listRef,
    ids: shown ?? [],
    moving,
    onDrop: (child, gap) =>
      field.kind === "multiRecord" &&
      model.reorderChildren(
        props.recordId,
        field,
        moving(child),
        page * CHILDREN_PER_PAGE + gap,
      ),
    onHold: (child, x, y) =>
      openChildMenu(model, props.recordId, field, child, x, y),
  });
  const drag = dnd.drag;
  /** The records in hand, grayed out where they are. */
  const inHand = drag
    ? selection.includes(drag.item)
      ? (childIds ?? []).filter((c) => selection.includes(c))
      : [drag.item]
    : [];

  if (!exists) return null;
  const noun =
    nounFor(field.table, inHand.length) ??
    (inHand.length === 1 ? "record" : "records");
  return (
    <LoadingRegion loading={loading}>
      {loading ? (
        Array.from({ length: expected }, (_, i) => (
          <div
            key={i}
            className="flex min-h-[30px] items-center gap-1 py-0.5"
            data-testid="record-placeholder"
          >
            <span className="size-4 shrink-0" aria-hidden="true" />
            <EmbeddedRecord cells={NO_CELLS} />
          </div>
        ))
      ) : (
        <div ref={listRef} className="relative">
          {shown?.map((childId) => (
            <div
              key={childId}
              data-child-row
              className={cx({ "opacity-50": inHand.includes(childId) })}
            >
              <ChildRow
                model={model}
                parentId={props.recordId}
                field={field}
                listId={id}
                recordId={childId}
                onPointerDown={
                  draggable ? (e) => dnd.onPointerDown(e, childId) : undefined
                }
                pressing={dnd.pressing}
              />
            </div>
          ))}
          {drag?.target != null && (
            <div
              aria-hidden="true"
              className="bg-accent pointer-events-none absolute right-1 left-5 h-0.5 -translate-y-1/2 rounded-full"
              style={{ top: drag.lineTop }}
            />
          )}
        </div>
      )}
      {drag &&
        createPortal(
          <DragChip
            icon={Icons.Record}
            label={`${inHand.length} ${noun}`}
            style={{ transform: dragChipTransform(drag.x, drag.y) }}
          />,
          document.body,
        )}
      {!loading && (
        <Pager
          page={page}
          pageSize={CHILDREN_PER_PAGE}
          total={total}
          onPage={setPage}
        />
      )}
      {status === "error" && (
        <p className="text-danger px-1 py-0.5 text-xs">{error}</p>
      )}
    </LoadingRegion>
  );
}

/** The records a menu raised on `child` acts on: the whole selection when it's
 * part of it, otherwise just it. Read from the model's current state as the
 * menu opens, so the action isn't at the mercy of what happens to the
 * selection while the menu is up. */
function menuTargets(model: RecordFormModel, list: string, child: string) {
  const s = model.store.getState();
  if (!selectIsSelected(s, child)) return [child];
  const siblings = s.lists[list]?.childIds ?? [];
  return s.selection.filter((id) => siblings.includes(id));
}

/** Raises the menu on record `child` of a multi-record field at viewport point
 * (x, y) — moving the selection to it first when it's outside it, so the
 * menu's target is visible: the same courtesy the result rows extend. */
function openChildMenu(
  model: RecordFormModel,
  parentId: string,
  field: MultiRecordField | ContextQueryField,
  child: string,
  x: number,
  y: number,
): void {
  const ids = menuTargets(model, listId(parentId, field.key), child);
  if (!selectIsSelected(model.store.getState(), child)) {
    model.clickEmbedded(child, { shift: false, ctrl: false });
  }
  model.openMenu({
    target: {
      kind: "childRecords",
      recordId: parentId,
      fieldKey: field.key,
      ids,
    },
    x,
    y,
  });
}

/** One record within a multi-record field: an embedded record previewing it, and
 * — once expanded — that record's own form. This is the form's selectable item:
 * it can be clicked with the same range/toggle modifiers as a result row, so a
 * run of them can be deleted in one go.
 *
 * Within a contextual query's field, the same row for a record the query found —
 * selectable and editable all the same, but with nothing to delete it from. */
function ChildRow(props: {
  model: RecordFormModel;
  /** The record the field belongs to. */
  parentId: string;
  field: MultiRecordField | ContextQueryField;
  listId: string;
  recordId: string;
  /** A press on the record, which may be the start of dragging it to a new
   * place — absent where the records can't be rearranged. */
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  /** Whether a touch is resting on a record, on its way to picking it up. */
  pressing: () => boolean;
}): JSX.Element {
  const { model, parentId, field, recordId } = props;
  const expanded = useFormState(model, (s) => selectIsExpanded(s, recordId));
  /** Under a join table's field, the record this one stands for: what it
   * shows once it's open, in place of its own fields — once there is one. */
  const joinId =
    field.kind === "multiRecord" && field.join
      ? scalarChildId(recordId, field.join.column)
      : undefined;
  const joined = useFormState(
    model,
    (s) => joinId !== undefined && s.records[joinId] !== undefined,
  );
  // A new record of a join table shows the record it was pointed at as soon
  // as it is, having no preview of its own until it's saved.
  const cells = useFormState(model, (s) =>
    s.records[recordId]?.isNew && joinId !== undefined
      ? (s.embeds[joinId]?.cells ?? NO_CELLS)
      : (s.embeds[recordId]?.cells ?? NO_CELLS),
  );
  const columns = useFormState(model, (s) =>
    s.records[recordId]?.isNew && joinId !== undefined
      ? s.embeds[joinId]?.columns
      : s.embeds[recordId]?.columns,
  );
  /** Whether this record is one the form is creating rather than one it
   * loaded — which is what the widget says, in place of a preview it has no
   * values for yet. */
  const isNew = useFormState(model, (s) => s.records[recordId]?.isNew === true);
  /** Whether it's a new one that has a preview all the same: the record it
   * joins to. */
  const previewed = isNew && cells.length > 0;
  // A record within a multi-record field is always exactly one record.
  const keyText = useFormState(model, (s) => {
    const key = s.records[recordId]?.keys[0];
    return key ? key.map((part) => part.value).join(" ") : "";
  });
  const selected = useFormState(model, (s) => selectIsSelected(s, recordId));
  const recordModified = useFormState(model, (s) =>
    selectRecordModified(s, recordId),
  );

  /** How many database records this row stands for: one, ordinarily; more when
   * the form is on several base records and each of them has a record saying
   * exactly this (`record/childGroups.ts`). */
  const records = useFormState(model, (s) => selectRecordCount(s, recordId));
  /** Whether the form is on several base records at all — which is when that
   * number is worth showing. Every row carries one then, including the rows
   * standing for a single record, so they read as a column of counts rather
   * than as annotations on the odd row. */
  const counted = useFormState(
    model,
    (s) => selectRecordCount(s, parentId) > 1,
  );

  /** What an expansion toggle's aria-label names this record: the preview it
   * shows, falling back to its key. */
  const label =
    isNew && !previewed
      ? "new record"
      : embedText({ cells, columns }) || keyText;

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    // A touch resting on the record is picking it up; its menu comes with the
    // release, if the record isn't moved.
    if (props.pressing()) return;
    openChildMenu(model, parentId, field, recordId, e.clientX, e.clientY);
  };

  // Like a field row, a child row stands for one record for its whole life
  // (it's keyed on the record's id).
  useEffect(() => {
    model.registerItem(recordId, {
      group: props.listId,
      expandable: () => true,
      setExpanded: (open) => model.toggleChild(recordId, open),
      remove: () => {
        if (field.kind === "multiRecord") {
          model.removeChild(parentId, field, recordId);
        }
      },
    });
    return () => model.unregisterItem(recordId);
  }, [model, recordId, props.listId, parentId, field]);

  return (
    <>
      <div className="flex min-h-[30px] items-center gap-1 py-0.5">
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
        {counted && (
          <span
            className={BUBBLE}
            aria-label={`${records} ${records === 1 ? "record" : "records"}`}
          >
            {records}
          </span>
        )}
        <EmbeddedRecord
          cells={isNew && !previewed ? NO_CELLS : cells}
          columns={columns}
          isNew={isNew && !previewed}
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
          onPointerDown={props.onPointerDown}
        />
        {field.kind === "multiRecord" && (
          <IconButton
            icon={Icons.Delete}
            label={`Delete ${label}`}
            size="sm"
            tabIndex={-1}
            onClick={() => model.removeChild(parentId, field, recordId)}
          />
        )}
      </div>
      {expanded && (
        <Subtree>
          <RecordNodeView
            model={model}
            recordId={joined && joinId !== undefined ? joinId : recordId}
          />
        </Subtree>
      )}
    </>
  );
}
