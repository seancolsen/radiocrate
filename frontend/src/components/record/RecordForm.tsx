import { onCleanup, untrack } from "solid-js";
import type { DmlOperation, DmlResult } from "api-client";
import { createRecordForm, ROOT_ID } from "./formModel";
import { registerForm, unregisterForm } from "./formRegistry";
import { recordIdentity, releaseUnmodified, stashedForm } from "./formStash";
import FieldRecordPicker from "./FieldRecordPicker";
import RecordContextMenu from "./RecordContextMenu";
import RecordNodeView from "./RecordFields";
import type { SchemaTable } from "../../query/schema";
import type { KeyPart } from "../../query/recordForm";

/** The record editor form for one record: the whole field tree, built from
 * introspection and filled in as its data arrives.
 *
 * One instance belongs to one record — a different record means a different
 * instance (the panel keys it) rather than this one being repointed. What it
 * does *not* own is the record's state: unsaved changes belong to the tab, not
 * to the sidebar that happens to be showing them, so the model comes from the
 * stash and goes back to it when the user selects another row (see
 * `formStash.ts`). Coming back to a record picks up exactly where they left it,
 * expansion and edits and all.
 *
 * This is also where the form meets the rest of the app: it registers itself so
 * the selection commands can find it while it holds focus, and it watches for
 * the two ways the user leaves — clicking somewhere that isn't a selectable
 * embedded record (which clears the selection) and moving focus out of the form
 * entirely (which gives the arrow keys back to the result rows). */
export default function RecordForm(props: {
  tabId: string;
  tables: readonly SchemaTable[];
  schemaJson: string;
  table: string;
  recordKey: readonly KeyPart[];
  /** How this form's save reaches the database — the panel hands down one that
   * refreshes the result row the record is being edited from. */
  runDml: (operations: DmlOperation[]) => Promise<DmlResult>;
}) {
  // These props are this instance's subject, fixed for its life — a different
  // record means a different instance — so they're read once, untracked.
  const identity = untrack(() => recordIdentity(props.table, props.recordKey));
  const model = untrack(() => {
    const opts = {
      tables: props.tables,
      table: props.table,
      key: props.recordKey,
      schemaJson: props.schemaJson,
      runDml: (operations: DmlOperation[]) => props.runDml(operations),
    };
    return stashedForm(props.tabId, identity, () => createRecordForm(opts));
  });

  const handle = { model };
  registerForm(handle);
  onCleanup(() => {
    unregisterForm(handle);
    // Whatever was focused, selected or right-clicked in here was in *this*
    // sidebar; none of it outlives the sidebar, and a stale focused item would
    // otherwise go on claiming the arrow keys when the record comes back.
    model.noteBlur();
    model.closeMenu();
    model.closePicker();
    // Only unsaved *changes* are worth keeping — a record the user merely looked
    // at is dropped rather than held for the life of the tab.
    releaseUnmodified(props.tabId, identity);
  });

  // Anywhere but a selectable embedded record — another part of the form, the
  // results, the toolbar — is a click that ends the selection. A menu is the
  // exception: it was raised *on* the selection, and the entry the user is
  // reaching for may be about to act on it.
  const onPointerDown = (e: MouseEvent) => {
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      target.closest("[data-selectable], [role=menu]") !== null
    )
      return;
    model.clearSelection();
  };
  document.addEventListener("mousedown", onPointerDown, true);
  onCleanup(() =>
    document.removeEventListener("mousedown", onPointerDown, true),
  );

  /** Whether focus has left the form altogether — read from the event's
   * `relatedTarget` (the element taking focus, `null` for nothing at all)
   * rather than from `document.activeElement`, which during a `focusout` is
   * still `<body>`: the incoming focus hasn't been applied yet.
   *
   * The context menu is the same exception `onPointerDown` makes for a click:
   * it's raised *on* the selection, is portaled outside `root`, and (per
   * `ui/menuKeyboard`) grabs real focus for its own trap the moment it opens —
   * which must not read as focus leaving the form. */
  const onFocusOut = (root: HTMLElement) => (e: FocusEvent) => {
    const next = e.relatedTarget;
    if (next instanceof Node && root.contains(next)) return;
    if (next instanceof HTMLElement && next.closest("[role=menu]") !== null)
      return;
    model.noteBlur();
  };

  return (
    <div
      ref={(el) => {
        model.setRoot(el);
        el.addEventListener("focusout", onFocusOut(el));
      }}
    >
      <RecordNodeView model={model} recordId={ROOT_ID} />
      <RecordContextMenu model={model} />
      <FieldRecordPicker model={model} schemaJson={props.schemaJson} />
    </div>
  );
}
