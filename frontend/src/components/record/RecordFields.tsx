import {
  createSignal,
  For,
  Index,
  onCleanup,
  Show,
  untrack,
  type ParentProps,
} from "solid-js";
import EmbeddedRecord from "./EmbeddedRecord";
import ExpansionToggle from "./ExpansionToggle";
import FieldLabel from "./FieldLabel";
import FieldValue, { type EditExit } from "./FieldValue";
import LoadingRegion from "./LoadingRegion";
import ModifiedStar from "./ModifiedStar";
import {
  fieldItemId,
  listId,
  scalarChildId,
  type RecordFormModel,
  type RecordNode,
} from "./formModel";
import { Icons } from "../../icons";
import IconButton from "../ui/IconButton";
import type { FormField, MultiRecordField } from "../../query/recordForm";

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

/** All of one record's fields, dimmed under the loading wash while its data is
 * in flight. */
export default function RecordNodeView(props: {
  model: RecordFormModel;
  recordId: string;
}) {
  return (
    <Show when={props.model.record(props.recordId)}>
      {(node) => (
        <LoadingRegion loading={node().status === "loading"}>
          <For each={node().fields}>
            {(field) => (
              <FieldRow
                model={props.model}
                recordId={props.recordId}
                node={node()}
                field={field}
              />
            )}
          </For>
          <Show when={node().status === "error"}>
            <p class="text-danger px-1 py-0.5 text-xs">{node().error}</p>
          </Show>
        </LoadingRegion>
      )}
    </Show>
  );
}

/** One field: its row, plus whatever the row expands into. */
function FieldRow(props: {
  model: RecordFormModel;
  recordId: string;
  node: RecordNode;
  field: FormField;
}) {
  // Whether the collapsed value is actually cut off — reported up from the value
  // itself, since only it knows how much room the text needed.
  const [overflowing, setOverflowing] = createSignal(false);

  // A row stands for one field of one record for its whole life, so its id — and
  // the registration keyed on it — is read once rather than tracked.
  const itemId = untrack(() => fieldItemId(props.recordId, props.field.key));
  const expanded = () => props.model.isExpanded(itemId);

  /** The record count behind a multi-record field, once loaded. */
  const count = (): number | undefined =>
    props.field.kind === "multiRecord"
      ? props.node.counts[props.field.key]
      : undefined;
  /** The column value behind any other field: `undefined` until loaded. */
  const value = (): string | null | undefined =>
    props.field.kind === "multiRecord"
      ? undefined
      : props.node.values[props.field.column];

  const expandable = () => {
    if (props.field.kind === "multiRecord") {
      // A field with no records has nothing to open; one whose table has no
      // record identity at all can be counted but not listed.
      return (count() ?? 0) > 0 && props.field.keyColumns.length > 0;
    }
    if (props.field.kind === "scalarLink") return linked();
    return props.field.valueType === "text" && overflowing();
  };

  /** Whether a scalar linked record field has a record to show — one it points
   * at, or a new one the user is entering into it. What decides between an
   * embedded record and the pencil that offers to fill the field in. */
  const linked = () =>
    props.field.kind === "scalarLink" &&
    props.model.hasLinkedRecord(props.recordId, props.field);

  /** Whether this field carries an unsaved change, its own or one anywhere
   * inside it. */
  const modified = () =>
    props.model.isFieldModified(props.recordId, props.field.key);

  /** Whether the open context menu is this field's own. */
  const menuOpen = () => {
    const menu = props.model.menu();
    return (
      menu?.target.kind === "field" &&
      menu.target.recordId === props.recordId &&
      menu.target.fieldKey === props.field.key
    );
  };

  /** Raises the menu for this field — from its label, its value, or the
   * embedded record a scalar linked record field shows. */
  const openMenu = (e: MouseEvent, kind: "field" | "scalarEmbed") => {
    e.preventDefault();
    props.model.openMenu({
      target: { kind, recordId: props.recordId, fieldKey: props.field.key },
      x: e.clientX,
      y: e.clientY,
    });
  };

  /** An expanded *text* field moves its value below the label, where it has the
   * width to wrap; an expanded link/record field grows a subtree instead. */
  const textBelow = () => props.field.kind === "primitive" && expanded();

  /** The id of both the record behind a scalar linked record field and that
   * field's embedded record. */
  const embedId = () => scalarChildId(props.recordId, props.field.key);

  /** Whether the embedded record's preview is still on its way. A record the
   * form is *creating* has no preview to wait for — it renders as "New". */
  const embedLoading = () =>
    props.model.record(embedId())?.isNew !== true &&
    props.model.embed(embedId())?.status !== "loaded";

  /** Whether the row's value renders as plain text (or a pencil): everything
   * except a record count, an embedded record, and text that has moved below
   * its label. */
  const plainValue = () => {
    if (props.field.kind === "multiRecord" || textBelow()) return false;
    return !linked();
  };

  // Only an editable primitive field has an editor to Tab into — a field's kind
  // and read-only-ness are as fixed for its row's lifetime as its key is.
  const editable = untrack(
    () => props.field.kind === "primitive" && !props.field.readOnly,
  );
  const beginTabEdit = (selectAll: boolean) => {
    props.model.beginEdit(props.recordId, props.field.key, { selectAll });
  };
  untrack(() =>
    props.model.registerItem(itemId, {
      group: props.recordId,
      expandable,
      setExpanded: (open) =>
        props.model.toggleField(props.recordId, props.field, open),
      remove: () => props.model.clearField(props.recordId, props.field),
      beginEdit: editable ? beginTabEdit : undefined,
    }),
  );
  onCleanup(() => props.model.unregisterItem(itemId));

  const toggle = (siblings: boolean) => {
    if (siblings) props.model.toggleSiblings(itemId, !expanded());
    else props.model.toggleField(props.recordId, props.field);
  };

  /** A field label's double click: a primitive field goes into edit mode, a
   * scalar linked record field opens the record picker (spec: "Modal record
   * picker" — whatever the field currently points at, which is why this isn't
   * the expansion the chevron and the embedded record already offer), and a
   * multi-record field opens or closes. */
  const activate = () => {
    if (props.field.kind === "primitive")
      props.model.beginEdit(props.recordId, props.field.key);
    else if (props.field.kind === "scalarLink")
      props.model.openPicker(props.recordId, props.field.key);
    else props.model.toggleField(props.recordId, props.field);
  };

  /** Activating an empty field's value — the pencil button, or a click on the
   * value itself. A scalar linked record field holds a foreign key rather than
   * anything a user would type, so its pencil offers the picker instead of a
   * text box. */
  const beginEdit = () => {
    if (props.field.kind === "scalarLink")
      props.model.openPicker(props.recordId, props.field.key);
    else props.model.beginEdit(props.recordId, props.field.key);
  };

  /** Enter on a focused label: the field's "do the thing" key, one per kind —
   * a primitive field's input, a scalar linked record field's picker, or (unlike
   * double-click, which only expands) a fresh child of a multi-record field. */
  const onLabelKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (props.field.kind === "primitive")
      props.model.beginEdit(props.recordId, props.field.key);
    else if (props.field.kind === "scalarLink")
      props.model.openPicker(props.recordId, props.field.key);
    else props.model.addChild(props.recordId, props.field);
  };

  /** Leaving edit mode: the value is kept in the form, and focus goes wherever
   * the key that ended the edit says. Deferred a tick so the input is gone (and
   * the label is back) before it's asked for focus. */
  const commit = (text: string, exit: EditExit) =>
    untrack(() => {
      if (props.field.kind === "multiRecord") return;
      const model = props.model;
      model.commitEdit(props.recordId, props.field.column, text);
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
    });

  return (
    <>
      <div class="flex min-h-[26px] items-center gap-1 py-0.5">
        <ExpansionToggle
          expandable={expandable()}
          expanded={expanded()}
          label={props.field.label}
          onToggle={toggle}
        />
        <div class="relative shrink-0">
          <FieldLabel
            field={props.field}
            itemId={itemId}
            menuOpen={menuOpen()}
            onClick={() => props.model.focusItem(itemId)}
            onDblClick={activate}
            onFocus={() => props.model.noteFocus(itemId)}
            onKeyDown={onLabelKeyDown}
            onContextMenu={(e) => openMenu(e, "field")}
          />
          {/* A field of a record still being created shows no star of its own:
              there's nothing yet to compare it against. The record's parent
              still wears one, for having gained it. */}
          <Show when={!props.node.isNew && modified()}>
            <ModifiedStar label={props.field.label} />
          </Show>
        </div>
        <Show
          when={props.field.kind === "multiRecord" && count() !== undefined}
        >
          <span class="bg-edge/50 text-ink-weak rounded-full px-2 text-xs leading-[18px]">
            {count()}
          </span>
        </Show>

        {/* The one way into a multi-record field that doesn't need a record to
            already be there: add one. Like the expansion toggle beside it, it's
            a control *on* the field rather than an item of its own, so it isn't
            focusable and doesn't take focus when clicked. */}
        <Show
          when={
            props.field.kind === "multiRecord" &&
            props.field.keyColumns.length > 0
              ? props.field
              : undefined
          }
        >
          {(field) => (
            <IconButton
              icon={Icons.Add}
              label={`Add ${field().label}`}
              size="sm"
              tabIndex={-1}
              onClick={() => props.model.addChild(props.recordId, field())}
            />
          )}
        </Show>

        {/* A scalar linked record field shows the record it points at, rather
            than the id it holds. It isn't focusable — the field's label is what
            the user selects — so clicking it lands there. The button beside it
            clears the field, dropping the record it points at with it — the
            same action, and the same icon, as "Clear" on its context menu. */}
        <Show when={linked()}>
          <LoadingRegion loading={embedLoading()} class="flex min-w-0 flex-1">
            <EmbeddedRecord
              cells={props.model.embed(embedId())?.cells ?? []}
              isNew={props.model.record(embedId())?.isNew}
              onClick={() => props.model.focusItem(itemId)}
              onDblClick={() =>
                props.model.toggleField(props.recordId, props.field)
              }
              onContextMenu={(e) => openMenu(e, "scalarEmbed")}
            />
          </LoadingRegion>
          <IconButton
            icon={Icons.Clear}
            label={`Clear ${props.field.label}`}
            size="sm"
            tabIndex={-1}
            onClick={() => props.model.clearField(props.recordId, props.field)}
          />
        </Show>

        <Show when={plainValue()}>
          <FieldValueSlot
            model={props.model}
            recordId={props.recordId}
            field={props.field}
            value={value()}
            expanded={false}
            onBeginEdit={beginEdit}
            onCommit={commit}
            onContextMenu={(e) => openMenu(e, "field")}
            onOverflow={setOverflowing}
          />
        </Show>
      </div>

      {/* Expanded text: the same value, given the full width below the label —
          under the same tree line every other kind of expansion draws. */}
      <Show when={textBelow()}>
        <Subtree>
          <div class="pr-1 pb-1">
            <FieldValueSlot
              model={props.model}
              recordId={props.recordId}
              field={props.field}
              value={value()}
              expanded={true}
              onBeginEdit={beginEdit}
              onCommit={commit}
              onContextMenu={(e) => openMenu(e, "field")}
            />
          </div>
        </Subtree>
      </Show>

      {/* A linked record expands into its own form. */}
      <Show when={expanded() && props.field.kind === "scalarLink"}>
        <Subtree>
          <RecordNodeView model={props.model} recordId={embedId()} />
        </Subtree>
      </Show>

      {/* A multi-record field expands into the records that reference this one. */}
      <Show
        when={
          expanded() && props.field.kind === "multiRecord"
            ? props.field
            : undefined
        }
      >
        {(field) => (
          <Subtree>
            <ChildList
              model={props.model}
              recordId={props.recordId}
              field={field()}
            />
          </Subtree>
        )}
      </Show>
    </>
  );
}

/** Indents a row's children and draws the tree line down their left edge. */
function Subtree(props: ParentProps) {
  return <div class="border-edge ml-2 border-l pl-2">{props.children}</div>;
}

/** Narrows a field to the kinds that have a value, and wires the value's edit
 * mode to the model. (`multiRecord` fields never reach here — they show a count
 * instead.) */
function FieldValueSlot(props: {
  model: RecordFormModel;
  recordId: string;
  field: FormField;
  value: string | null | undefined;
  expanded: boolean;
  onBeginEdit: () => void;
  onCommit: (text: string, exit: EditExit) => void;
  onContextMenu: (e: MouseEvent) => void;
  onOverflow?: (overflowing: boolean) => void;
}) {
  return (
    <Show when={props.field.kind !== "multiRecord" ? props.field : undefined}>
      {(field) => (
        <FieldValue
          field={field()}
          value={props.value}
          editing={
            props.model.editing() === fieldItemId(props.recordId, field().key)
          }
          editingSelectAll={props.model.editingSelectAll()}
          expanded={props.expanded}
          onBeginEdit={() => props.onBeginEdit()}
          // Every keystroke goes into the form as it's typed, so what the user
          // sees elsewhere (the modification star, above all) is never a
          // keystroke behind.
          onInput={(text) =>
            props.model.editValue(props.recordId, field().column, text)
          }
          onCommit={props.onCommit}
          onContextMenu={props.onContextMenu}
          onOverflow={props.onOverflow}
        />
      )}
    </Show>
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
}) {
  const id = () => listId(props.recordId, props.field.key);
  const list = () => props.model.list(id());
  const loading = () => {
    const status = list()?.status;
    return status === "unloaded" || status === "loading";
  };
  return (
    <Show when={list()}>
      {(node) => (
        <LoadingRegion loading={loading()}>
          <Show
            when={!loading()}
            fallback={
              <Index each={Array.from({ length: node().expected }, () => null)}>
                {() => (
                  <div
                    class="flex min-h-[26px] items-center gap-1 py-0.5"
                    data-testid="record-placeholder"
                  >
                    <span class="size-4 shrink-0" aria-hidden="true" />
                    <EmbeddedRecord cells={[]} />
                  </div>
                )}
              </Index>
            }
          >
            <For each={node().childIds}>
              {(childId) => (
                <ChildRow
                  model={props.model}
                  parentId={props.recordId}
                  field={props.field}
                  listId={id()}
                  recordId={childId}
                />
              )}
            </For>
          </Show>
          <Show when={node().status === "error"}>
            <p class="text-danger px-1 py-0.5 text-xs">{node().error}</p>
          </Show>
        </LoadingRegion>
      )}
    </Show>
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
}) {
  const expanded = () => props.model.isExpanded(props.recordId);
  const cells = () => props.model.embed(props.recordId)?.cells ?? [];
  /** Whether this record is one the form is creating rather than one it
   * loaded — which is what the widget says, in place of a preview it has no
   * values for yet. */
  const isNew = () => props.model.record(props.recordId)?.isNew === true;
  /** What an expansion toggle's aria-label names this record: the preview it
   * shows, falling back to its key. */
  const label = () => {
    if (isNew()) return "new record";
    const preview = cells().filter(Boolean).join(" ");
    if (preview) return preview;
    const node = props.model.record(props.recordId);
    return node ? node.key.map((p) => p.value).join(" ") : "";
  };

  /** The records a menu raised on this one acts on: the whole selection when
   * this record is part of it, otherwise just this record. Fixed as the menu
   * opens, so the action isn't at the mercy of what happens to the selection
   * while the menu is up. */
  const menuTargets = (): string[] => {
    if (!props.model.isSelected(props.recordId)) return [props.recordId];
    const siblings = props.model.list(props.listId)?.childIds ?? [];
    return props.model.selection().filter((id) => siblings.includes(id));
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const targets = menuTargets();
    // Right-clicking outside the selection moves it here first, so the menu's
    // target is visible — the same courtesy the result rows extend.
    if (!props.model.isSelected(props.recordId)) {
      props.model.clickEmbedded(props.recordId, { shift: false, ctrl: false });
    }
    props.model.openMenu({
      target: {
        kind: "childRecords",
        recordId: props.parentId,
        fieldKey: props.field.key,
        ids: targets,
      },
      x: e.clientX,
      y: e.clientY,
    });
  };

  // Like a field row, a child row stands for one record for its whole life.
  const itemId = untrack(() => props.recordId);
  untrack(() =>
    props.model.registerItem(itemId, {
      group: props.listId,
      expandable: () => true,
      setExpanded: (open) => props.model.toggleChild(props.recordId, open),
      remove: () =>
        props.model.removeChild(props.parentId, props.field, props.recordId),
    }),
  );
  onCleanup(() => props.model.unregisterItem(itemId));

  return (
    <>
      <div class="flex min-h-[26px] items-center gap-1 py-0.5">
        <ExpansionToggle
          expandable={true}
          expanded={expanded()}
          label={label()}
          onToggle={(siblings) =>
            siblings
              ? props.model.toggleSiblings(props.recordId, !expanded())
              : props.model.toggleChild(props.recordId)
          }
        />
        <EmbeddedRecord
          cells={isNew() ? [] : cells()}
          isNew={isNew()}
          itemId={props.recordId}
          focusable
          selected={props.model.isSelected(props.recordId)}
          modifiedLabel={
            !isNew() && props.model.isRecordModified(props.recordId)
              ? label()
              : undefined
          }
          onContextMenu={onContextMenu}
          onClick={(e) => {
            // Clicking a widget selects it — and puts focus on it, since a
            // selected item is a focused one.
            e.currentTarget.focus();
            props.model.clickEmbedded(props.recordId, {
              shift: e.shiftKey,
              ctrl: e.ctrlKey || e.metaKey,
            });
          }}
          onDblClick={() => props.model.toggleChild(props.recordId)}
          onFocus={() => props.model.noteFocus(props.recordId)}
        />
        <IconButton
          icon={Icons.Delete}
          label={`Delete ${label()}`}
          size="sm"
          tabIndex={-1}
          onClick={() =>
            props.model.removeChild(props.parentId, props.field, props.recordId)
          }
        />
      </div>
      <Show when={expanded()}>
        <Subtree>
          <RecordNodeView model={props.model} recordId={props.recordId} />
        </Subtree>
      </Show>
    </>
  );
}
