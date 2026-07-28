import { createMemo, For, Show } from "solid-js";
import {
  RECORD_SIDEBAR_MIN_WIDTH,
  useAppState,
  type RecordEditorTarget,
  type RecordRef,
} from "../state/store";
import { Icons } from "../icons";
import IconButton from "./ui/IconButton";
import RecordForm from "./record/RecordForm";

// The record editor: a sidebar within the query page, opened from a result row's
// "Edit {table}" context-menu entry or the "Results: Edit selected rows"
// command, and kept in sync with the result-row selection while it's open
// (QueryPage owns that wiring). It lives *inside* the page (not the app frame)
// so opening it narrows the toolbar and the results and leaves the tab bar and
// the now-playing bar alone.
//
// The panel itself is the frame — heading, close button, resize divider — and
// the dynamic-form work happens below it in `record/`. A multi-row selection is
// the exception it handles on its own: it lists the records it covers and says
// bulk modification isn't supported, rather than building a form for them.

/** Least width left to the results while dragging the divider, so the pane the
 * editor was opened *from* can't be squeezed away entirely. */
const MIN_RESULTS_WIDTH = 160;
/** Keyboard resize step (Arrow keys on the divider). */
const RESIZE_STEP = 16;

/** A record's identity as a string — table plus key — for comparing two
 * `RecordRef`s without caring which object carries them. */
function identity(record: RecordRef | undefined): string {
  return record
    ? `${record.table}(${record.key.map((p) => `${p.column}=${p.value}`).join(",")})`
    : "";
}

/** The record-editor sidebar for `tabId`, showing the record(s) it's open on.
 * `target.records` holds more than one entry when the result-row selection it
 * tracks widens to multiple rows (bulk modification isn't supported yet — see
 * the body below). */
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
  const isBulk = () => records().length > 1;

  /** The one record the form is for. Held behind a memo that compares records by
   * identity-in-the-database rather than by object identity, so the resyncing
   * the sidebar does as the selection moves only yields a new value when it has
   * genuinely landed on a different record — and only then is the form (and its
   * load) rebuilt underneath the user. */
  const formRecord = createMemo(
    () => (isBulk() ? undefined : records()[0]),
    undefined,
    {
      equals: (a, b) => identity(a) === identity(b),
    },
  );

  const heading = () =>
    isBulk()
      ? `Edit ${records().length} ${props.target.table} records`
      : `Edit ${props.target.table}`;

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

      <header class="border-edge flex items-center gap-2 border-b px-2 py-1.5">
        <span class="text-ink-weak flex size-4 shrink-0 items-center justify-center">
          {Icons.Edit({ class: "size-4" })}
        </span>
        <h2 class="text-ink min-w-0 flex-1 truncate text-sm font-semibold">
          {heading()}
        </h2>
        <IconButton
          icon={Icons.Close}
          label="Close record editor"
          onClick={() => store.closeRecordEditor(props.tabId)}
        />
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        {/* Bulk: the records the selection covers, listed by key, with no form —
            editing them together is separate UI, still to come. */}
        <Show when={isBulk()}>
          <For each={records()}>
            {(record) => (
              <div class="border-edge flex flex-col gap-0.5 border-b py-1 last:border-b-0">
                <For each={record.key}>
                  {(part) => (
                    <div class="flex flex-col gap-0.5 py-0.5">
                      <span class="text-ink-weak text-[11px]">
                        {part.column}
                      </span>
                      <span class="text-ink font-mono text-xs break-all">
                        {part.value}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
          <p class="text-ink-weak mt-2 text-xs italic">
            Bulk modification not yet supported
          </p>
        </Show>

        {/* One record: the form. Keyed on the record, so re-pointing the sidebar
            builds a fresh form (and a fresh load) rather than mutating this one.
            It needs the schema — the form's whole structure comes from
            introspection — which by this point has long since loaded, since
            running the query the row came from needed it too. */}
        <Show when={store.schemaJson()}>
          {(schemaJson) => (
            <Show when={formRecord()} keyed>
              {(record) => (
                <RecordForm
                  tables={store.schemaTables()}
                  schemaJson={schemaJson()}
                  table={record.table}
                  recordKey={record.key}
                />
              )}
            </Show>
          )}
        </Show>
      </div>
    </aside>
  );
}
