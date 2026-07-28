import { onCleanup, untrack } from "solid-js";
import { createRecordForm, ROOT_ID } from "./formModel";
import { registerForm, unregisterForm } from "./formRegistry";
import RecordNodeView from "./RecordFields";
import type { SchemaTable } from "../../query/schema";
import type { KeyPart } from "../../query/recordForm";

/** The record editor form for one record: the whole field tree, built from
 * introspection and filled in as its data arrives.
 *
 * One instance belongs to one record — the model it creates on mount starts the
 * load, and the expansion/edit/selection state it accumulates is that record's.
 * Pointing the sidebar at a different record replaces the instance (the panel
 * keys it), rather than resetting this one.
 *
 * This is also where the form meets the rest of the app: it registers itself so
 * the selection commands can find it while it holds focus, and it watches for
 * the two ways the user leaves — clicking somewhere that isn't a selectable
 * embedded record (which clears the selection) and moving focus out of the form
 * entirely (which gives the arrow keys back to the result rows). */
export default function RecordForm(props: {
  tables: readonly SchemaTable[];
  schemaJson: string;
  table: string;
  recordKey: readonly KeyPart[];
}) {
  // These props are this instance's subject, fixed for its life — a different
  // record means a different instance — so they're read once, untracked.
  const model = untrack(() =>
    createRecordForm({
      tables: props.tables,
      table: props.table,
      key: props.recordKey,
      schemaJson: props.schemaJson,
    }),
  );

  const handle = { model };
  registerForm(handle);
  onCleanup(() => unregisterForm(handle));

  // Anywhere but a selectable embedded record — another part of the form, the
  // results, the toolbar — is a click that ends the selection.
  const onPointerDown = (e: MouseEvent) => {
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      target.closest("[data-selectable]") !== null
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
   * still `<body>`: the incoming focus hasn't been applied yet. */
  const onFocusOut = (root: HTMLElement) => (e: FocusEvent) => {
    const next = e.relatedTarget;
    if (next instanceof Node && root.contains(next)) return;
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
    </div>
  );
}
