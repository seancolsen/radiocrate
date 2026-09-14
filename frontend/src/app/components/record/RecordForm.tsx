import { useEffect, useLayoutEffect, useRef, type JSX } from "react";
import { ROOT_ID, type RecordFormModel } from "../../stores/recordForm";
import { useFormsActions } from "../../stores/react";
import RecordNodeView from "./RecordFields";

/** The record editor form for the records it's opened on: the whole field tree,
 * built from introspection and filled in as its data arrives. One record is the
 * ordinary case; a wider result-row selection makes it several, and the form is
 * the same form — a field its records agree on is edited across all of them (see
 * `formValues.ts`).
 *
 * One instance belongs to one set of records — a different set means a different
 * instance (the panel keys it) rather than this one being repointed. What it
 * does *not* own is their state: unsaved changes belong to the tab, not to the
 * sidebar that happens to be showing them, so the model comes from the stash
 * (the forms store) and goes back to it when the user selects another row.
 * Coming back picks up exactly where they left it, expansion and edits and all.
 * The panel takes the model out of the stash and hands it down, since its
 * toolbar acts on the same model (see `RecordEditorPanel`).
 *
 * This is also where the form meets the rest of the app: it registers itself as
 * mounted so the selection commands can find it while it holds focus, starts
 * its root load, and watches for the two ways the user leaves — clicking
 * somewhere that isn't a selectable embedded record (which clears the
 * selection) and moving focus out of the form entirely (which gives the arrow
 * keys back to the result rows). */
export default function RecordForm(props: {
  tabId: string;
  /** The `recordIdentity` of each record — the stash key the model is under. */
  identities: readonly string[];
  model: RecordFormModel;
}): JSX.Element {
  const forms = useFormsActions();
  const { tabId, identities, model } = props;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    forms.mount(tabId, identities);
    model.start();
    return () => {
      forms.unmount(tabId, identities);
      // Whatever was focused, selected or right-clicked in here was in *this*
      // sidebar; none of it outlives the sidebar, and a stale focused item would
      // otherwise go on claiming the arrow keys when the record comes back.
      model.noteBlur();
      model.closeMenu();
      model.closePicker();
      // Only unsaved *changes* are worth keeping — records the user merely looked
      // at are dropped rather than held for the life of the tab. Deferred a
      // tick: StrictMode's mount → cleanup → mount runs within one commit, and
      // releasing (which disposes the model) in between would strand the
      // remount on a dead model. The forms store also declines to release a
      // form something still has mounted.
      queueMicrotask(() => forms.releaseUnmodified(tabId, identities));
    };
  }, [forms, tabId, identities, model]);

  // Anywhere but a selectable embedded record — another part of the form, the
  // results, the toolbar — is a click that ends the selection. A menu is the
  // exception: it was raised *on* the selection, and the entry the user is
  // reaching for may be about to act on it.
  useEffect(() => {
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
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [model]);

  // The root element, handed to the model so it can move focus, and its
  // `focusout` listener. A native listener rather than React's `onBlur`:
  // React's focus events bubble through portals along the component tree, and
  // the context menu (stage 9) is portaled from inside this form — its own
  // focus moves must not reach here.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    model.setRoot(root);

    /** Whether focus has left the form altogether — read from the event's
     * `relatedTarget` (the element taking focus, `null` for nothing at all)
     * rather than from `document.activeElement`, which during a `focusout` is
     * still `<body>`: the incoming focus hasn't been applied yet.
     *
     * The context menu is the same exception `onPointerDown` makes for a click:
     * it's raised *on* the selection, is portaled outside `root`, and (per
     * `ui/useMenuKeyboard`) grabs real focus for its own trap the moment it
     * opens — which must not read as focus leaving the form. */
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next instanceof Node && root.contains(next)) return;
      if (next instanceof HTMLElement && next.closest("[role=menu]") !== null)
        return;
      model.noteBlur();
    };
    root.addEventListener("focusout", onFocusOut);
    return () => {
      root.removeEventListener("focusout", onFocusOut);
      model.setRoot(undefined);
    };
  }, [model]);

  return (
    <div ref={rootRef}>
      <RecordNodeView model={model} recordId={ROOT_ID} />
      {/* Stage 9 ports the form's context menu (`RecordContextMenu`) and its
          modal record picker (`FieldRecordPicker`), which render here. */}
    </div>
  );
}
