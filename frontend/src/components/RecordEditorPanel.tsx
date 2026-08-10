import { createMemo, Show, type Component } from "solid-js";
import {
  RECORD_SIDEBAR_MIN_WIDTH,
  useAppState,
  type RecordEditorTarget,
  type RecordRef,
} from "../state/store";
import { Icons } from "../icons";
import RecordForm from "./record/RecordForm";
import IconButton from "./ui/IconButton";
import { formFor, recordIdentity } from "./record/formStash";

// The record editor: a sidebar within the query page, opened from a result row's
// "Edit {table}" context-menu entry or the "Results: Edit selected rows"
// command, and kept in sync with the result-row selection while it's open
// (QueryPage owns that wiring). It lives *inside* the page (not the app frame)
// so opening it narrows the toolbar and the results and leaves the tab bar and
// the now-playing bar alone.
//
// The panel itself is the frame — heading, close/reset/save buttons, resize
// divider — and the dynamic-form work happens below it in `record/`. A multi-row
// selection is no exception here: the same form is built for every record the
// selection covers, and what differs about editing several at once is settled
// field by field, well below this (see `record/formValues.ts`).

/** Least width left to the results while dragging the divider, so the pane the
 * editor was opened *from* can't be squeezed away entirely. */
const MIN_RESULTS_WIDTH = 160;
/** Keyboard resize step (Arrow keys on the divider). */
const RESIZE_STEP = 16;

/** The records' identities as strings — table plus key each — for comparing two
 * selections without caring which objects carry them. The same strings key the
 * stashed form, so "the same records" means one thing throughout. */
function identities(records: readonly RecordRef[]): string[] {
  return records.map((record) => recordIdentity(record.table, record.key));
}

/** One labelled button of the panel's toolbar: the icon and the word, since
 * these two are consequential enough to be worth naming (unlike the icon-only
 * controls elsewhere). */
function ToolbarButton(props: {
  icon: Component<{ class?: string }>;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      class="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-sm"
      classList={{
        "text-ink hover:bg-hover": !props.disabled,
        "text-ink-weak/40": props.disabled,
      }}
      onClick={() => props.onClick()}
    >
      {props.icon({ class: "size-4" })}
      {props.label}
    </button>
  );
}

/** The record-editor sidebar for `tabId`, showing the record(s) it's open on.
 * `target.records` holds more than one entry when the result-row selection it
 * tracks widens to multiple rows; the form below handles that as a matter of
 * course. */
export default function RecordEditorPanel(props: {
  tabId: string;
  target: RecordEditorTarget;
}) {
  const store = useAppState();

  /** Applies a dragged/typed width, keeping the results pane visible. The store
   * clamps to the absolute bounds; this is the viewport-relative cap on top. */
  const applyWidth = (px: number) => {
    const max = Math.max(
      RECORD_SIDEBAR_MIN_WIDTH,
      window.innerWidth - MIN_RESULTS_WIDTH,
    );
    store.setRecordSidebarWidth(Math.min(px, max));
  };

  // Drag the divider: pointer capture keeps the gesture alive over the canvas
  // (which swallows pointer events of its own), and the width is persisted once
  // on release rather than on every move.
  const onDividerPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const divider = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startWidth = store.recordSidebarWidth();
    divider.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      // The sidebar is on the right, so dragging left widens it.
      applyWidth(startWidth - (ev.clientX - startX));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      divider.removeEventListener("pointercancel", onUp);
      store.commitRecordSidebarWidth();
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
    divider.addEventListener("pointercancel", onUp);
  };

  const onDividerKeyDown = (e: KeyboardEvent) => {
    const step =
      e.key === "ArrowLeft"
        ? RESIZE_STEP
        : e.key === "ArrowRight"
          ? -RESIZE_STEP
          : 0;
    if (step === 0) return;
    e.preventDefault();
    applyWidth(store.recordSidebarWidth() + step);
    store.commitRecordSidebarWidth();
  };

  const records = () => props.target.records;

  /** The records the form is for. Held behind a memo that compares them by
   * identity-in-the-database rather than by object identity, so the resyncing
   * the sidebar does as the selection moves only yields a new value when it has
   * genuinely landed on different records — and only then is the form (and its
   * load) rebuilt underneath the user. */
  const formRecords = createMemo(records, undefined, {
    equals: (a, b) => identities(a).join(" ") === identities(b).join(" "),
  });

  const heading = () =>
    records().length > 1
      ? `Edit ${records().length} ${props.target.table} records`
      : `Edit ${props.target.table}`;

  /** The form the toolbar acts on. It belongs to the tab rather than to this
   * component (see `formStash.ts`), so the panel finds it by the same identities
   * the form below registers itself under — reactively, since the form mounts
   * within the same render this reads it in. */
  const model = () => formFor(props.tabId, identities(formRecords()));

  return (
    <aside
      class="bg-panel border-edge relative flex shrink-0 flex-col border-l shadow-[-8px_0_16px_-4px_rgba(0,0,0,0.25)]"
      style={{ width: `${store.recordSidebarWidth()}px` }}
      aria-label={`Edit ${props.target.table}`}
    >
      {/* The resize divider straddles the border so it's grabbable from either
          side without widening the visible seam. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize record editor"
        tabindex="0"
        class="hover:bg-accent/40 focus-visible:bg-accent/40 absolute inset-y-0 -left-[3px] z-10 w-[7px] cursor-col-resize outline-none"
        onPointerDown={onDividerPointerDown}
        onKeyDown={onDividerKeyDown}
      />

      {/* The record editor toolbar: what the form is editing, and the ways out
          of it. Reset and Save only appear once there's something to reset or
          save; the X always closes the sidebar (the changes, if any, stay with
          the tab). */}
      <header class="border-edge flex items-center gap-1 border-b px-2 py-1.5">
        <span class="text-ink-weak flex size-4 shrink-0 items-center justify-center">
          {Icons.Edit({ class: "size-4" })}
        </span>
        <h2 class="text-ink min-w-0 flex-1 truncate text-sm font-semibold">
          {heading()}
        </h2>
        <Show when={model()}>
          {(form) => (
            <Show when={form().isModified()}>
              <ToolbarButton
                icon={Icons.Revert}
                label="Reset"
                disabled={form().saving()}
                onClick={() => form().reset()}
              />
              <ToolbarButton
                icon={Icons.Save}
                label={form().saving() ? "Saving…" : "Save"}
                disabled={form().saving()}
                onClick={() => void form().save()}
              />
            </Show>
          )}
        </Show>
        <IconButton
          icon={Icons.Close}
          label="Close record editor"
          onClick={() => store.closeRecordEditor(props.tabId)}
        />
      </header>

      {/* A save that failed says why, and keeps saying so until the next one (or
          it's dismissed). The changes it couldn't write are still in the form
          below. */}
      <Show when={model()}>
        {(form) => (
          <Show when={form().saveError()}>
            {(message) => (
              <div
                role="alert"
                class="text-danger border-edge bg-danger/10 flex items-center gap-1 border-b py-1.5 pr-1.5 pl-2 text-xs"
              >
                <p class="min-w-0 flex-1">{message()}</p>
                <IconButton
                  icon={Icons.Close}
                  label="Dismiss error"
                  size="sm"
                  onClick={() => form().clearSaveError()}
                />
              </div>
            )}
          </Show>
        )}
      </Show>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        {/* The form. Keyed on the records, so re-pointing the sidebar builds a
            fresh form (and a fresh load) rather than mutating this one. It needs
            the schema — the form's whole structure comes from introspection —
            which by this point has long since loaded, since running the query
            the rows came from needed it too. */}
        <Show when={store.schemaJson()}>
          {(schemaJson) => (
            <Show when={formRecords()} keyed>
              {(forRecords) => (
                <RecordForm
                  tabId={props.tabId}
                  tables={store.schemaTables()}
                  schemaJson={schemaJson()}
                  table={props.target.table}
                  recordKeys={forRecords.map((record) => record.key)}
                  // The save is a write *from* result rows, so it goes through
                  // the store: what it changed is read back into the rows the
                  // editor was opened on (see `query/rowDml.ts`).
                  runDml={(operations) =>
                    store.runRecordDml(props.tabId, forRecords, operations)
                  }
                />
              )}
            </Show>
          )}
        </Show>
      </div>
    </aside>
  );
}
