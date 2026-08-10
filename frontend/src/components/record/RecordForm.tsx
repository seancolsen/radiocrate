import { onCleanup, untrack } from "solid-js";
import type { DmlOperation, DmlResult } from "api-client";
import { createRecordForm, ROOT_ID } from "./formModel";
import { registerForm, unregisterForm } from "./formRegistry";
import { recordIdentity, releaseUnmodified, stashedForm } from "./formStash";
import FieldRecordPicker from "./FieldRecordPicker";
import RecordContextMenu from "./RecordContextMenu";
import RecordNodeView from "./RecordFields";
import type { SchemaTable } from "../../query/schema";
import type { RecordKey } from "../../query/recordForm";

/** The record editor form for the records it's opened on: the whole field tree,
 * built from introspection and filled in as its data arrives. One record is the
 * ordinary case; a wider result-row selection makes it several, and the form is
 * the same form — a field its records agree on is edited across all of them (see
 * `formValues.ts`).
 *
 * One instance belongs to one set of records — a different set means a different
 * instance (the panel keys it) rather than this one being repointed. What it
 * does *not* own is their state: unsaved changes belong to the tab, not to the
 * sidebar that happens to be showing them, so the model comes from the stash and
 * goes back to it when the user selects another row (see `formStash.ts`). Coming
 * back picks up exactly where they left it, expansion and edits and all.
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
  /** The records being edited, by key — one per result row the selection
   * covers. */
  recordKeys: readonly RecordKey[];
  /** How this form's save reaches the database — the panel hands down one that
   * refreshes the result rows the records are being edited from. */
  runDml: (operations: DmlOperation[]) => Promise<DmlResult>;
}) {
  // These props are this instance's subject, fixed for its life — different
  // records mean a different instance — so they're read once, untracked.
  const identities = untrack(() =>
    props.recordKeys.map((key) => recordIdentity(props.table, key)),
  );
  const model = untrack(() => {
    const opts = {
      tables: props.tables,
      table: props.table,
      keys: props.recordKeys,
      schemaJson: props.schemaJson,
      runDml: (operations: DmlOperation[]) => props.runDml(operations),
    };
    return stashedForm(props.tabId, identities, () => createRecordForm(opts));
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
    // Only unsaved *changes* are worth keeping — records the user merely looked
    // at are dropped rather than held for the life of the tab.
    releaseUnmodified(props.tabId, identities);
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
