import { For } from "solid-js";
import {
  RECORD_SIDEBAR_MIN_WIDTH,
  useAppState,
  type RecordRef,
} from "../state/store";
import { Icons } from "../icons";
import IconButton from "./ui/IconButton";

// The record editor: a sidebar within the query page, opened from a result row's
// "Edit {table}" context-menu entry. It lives *inside* the page (not the app
// frame) so opening it narrows the toolbar and the results and leaves the tab bar
// and the now-playing bar alone — the layout the egui `record_editor` panel had.
//
// This session it only shows which record it's pointing at (the primary-key
// column/value pairs) and offers a way out; the form itself — `form.rs`, by some
// margin the largest thing left to port — lands next.

/** Least width left to the results while dragging the divider, so the pane the
 * editor was opened *from* can't be squeezed away entirely. */
const MIN_RESULTS_WIDTH = 160;
/** Keyboard resize step (Arrow keys on the divider). */
const RESIZE_STEP = 16;

/** The record-editor sidebar for `tabId`, showing the record it's open on. */
export default function RecordEditorPanel(props: {
  tabId: string;
  record: RecordRef;
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

  return (
    <aside
      class="bg-panel border-edge relative flex shrink-0 flex-col border-l"
      style={{ width: `${store.recordSidebarWidth()}px` }}
      aria-label={`Edit ${props.record.table}`}
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
          Edit {props.record.table}
        </h2>
        <IconButton
          icon={Icons.Close}
          label="Close record editor"
          onClick={() => store.closeRecordEditor(props.tabId)}
        />
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <For each={props.record.key}>
          {(part) => (
            <div class="flex flex-col gap-0.5 py-1">
              <span class="text-ink-weak text-[11px]">{part.column}</span>
              <span class="text-ink font-mono text-xs break-all">
                {part.value}
              </span>
            </div>
          )}
        </For>
      </div>
    </aside>
  );
}
