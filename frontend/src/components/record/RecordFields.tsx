import { createSignal, For, Index, Show, type ParentProps } from "solid-js";
import ExpansionToggle from "./ExpansionToggle";
import FieldLabel from "./FieldLabel";
import FieldValue from "./FieldValue";
import LoadingRegion from "./LoadingRegion";
import {
  fieldItemId,
  listId,
  scalarChildId,
  type RecordFormModel,
  type RecordNode,
} from "./formModel";
import type { FormField } from "../../query/recordForm";

// The form's tree, rendered. The components here call each other in a cycle — a
// record's fields, a field's expansion, a multi-record field's children, and
// each of those children's own fields — which is what lets the user recurse into
// the data as deep as it goes, so they live in one file.
//
// Every row is the same three slots in the same order: expansion toggle, field
// label, value. Rows an item can't fill still reserve the space, so toggles and
// labels line up down the whole form regardless of what any one row holds.

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

  const itemId = () => fieldItemId(props.recordId, props.field.key);
  const expanded = () => props.model.isExpanded(itemId());

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
    if (props.field.kind === "scalarLink") {
      const linked = value();
      return linked != null && linked !== "";
    }
    return props.field.valueType === "text" && overflowing();
  };

  /** An expanded *text* field moves its value below the label, where it has the
   * width to wrap; an expanded link/record field grows a subtree instead. */
  const textBelow = () => props.field.kind === "primitive" && expanded();

  return (
    <>
      <div class="flex min-h-[26px] items-center gap-1 py-0.5">
        <ExpansionToggle
          expandable={expandable()}
          expanded={expanded()}
          label={props.field.label}
          onToggle={() => props.model.toggleField(props.recordId, props.field)}
        />
        <FieldLabel field={props.field} />
        <Show
          when={props.field.kind === "multiRecord" && count() !== undefined}
        >
          <span class="bg-edge/50 text-ink-weak rounded-full px-2 text-xs leading-[18px]">
            {count()}
          </span>
        </Show>
        <Show when={props.field.kind !== "multiRecord" && !textBelow()}>
          <FieldValueSlot
            model={props.model}
            recordId={props.recordId}
            field={props.field}
            value={value()}
            expanded={false}
            onOverflow={setOverflowing}
          />
        </Show>
      </div>

      {/* Expanded text: the same value, given the full width below the label. */}
      <Show when={textBelow()}>
        <div class="pr-1 pb-1 pl-5">
          <FieldValueSlot
            model={props.model}
            recordId={props.recordId}
            field={props.field}
            value={value()}
            expanded={true}
          />
        </div>
      </Show>

      {/* A linked record expands into its own form. */}
      <Show when={expanded() && props.field.kind === "scalarLink"}>
        <Subtree>
          <RecordNodeView
            model={props.model}
            recordId={scalarChildId(props.recordId, props.field.key)}
          />
        </Subtree>
      </Show>

      {/* A multi-record field expands into the records that reference this one. */}
      <Show when={expanded() && props.field.kind === "multiRecord"}>
        <Subtree>
          <ChildList
            model={props.model}
            listId={listId(props.recordId, props.field.key)}
          />
        </Subtree>
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
          expanded={props.expanded}
          onBeginEdit={() => props.model.beginEdit(props.recordId, field().key)}
          onCommit={(text) =>
            props.model.commitEdit(props.recordId, field().column, text)
          }
          onOverflow={props.onOverflow}
        />
      )}
    </Show>
  );
}

/** The records behind an expanded multi-record field. While they load, the
 * count the parent already reported is drawn as that many placeholder rows, so
 * the list has its real shape under the loading wash before any of it arrives. */
function ChildList(props: { model: RecordFormModel; listId: string }) {
  const list = () => props.model.list(props.listId);
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
                    <span class="bg-edge/40 h-3 w-2/3 rounded" />
                  </div>
                )}
              </Index>
            }
          >
            <For each={node().childIds}>
              {(id) => <ChildRow model={props.model} recordId={id} />}
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

/** One record within a multi-record field.
 *
 * Where the design calls for an embedded record — a preview of the row — this
 * shows the record's primary key as plain text; the embedded record component
 * and the query that feeds it are still to come. Expanding it loads that
 * record's own form. */
function ChildRow(props: { model: RecordFormModel; recordId: string }) {
  const expanded = () => props.model.isExpanded(props.recordId);
  /** The key, minus the part every sibling shares (the contextual filter). */
  const keyText = () => {
    const node = props.model.record(props.recordId);
    if (!node) return "";
    const own = node.key.filter((part) => !node.hidden.includes(part.column));
    return (own.length > 0 ? own : node.key).map((p) => p.value).join(" · ");
  };

  return (
    <>
      <div class="flex min-h-[26px] items-center gap-1 py-0.5">
        <ExpansionToggle
          expandable={true}
          expanded={expanded()}
          label={keyText()}
          onToggle={() => props.model.toggleChild(props.recordId)}
        />
        <span class="text-ink-weak min-w-0 flex-1 truncate font-mono text-xs">
          {keyText()}
        </span>
      </div>
      <Show when={expanded()}>
        <Subtree>
          <RecordNodeView model={props.model} recordId={props.recordId} />
        </Subtree>
      </Show>
    </>
  );
}
