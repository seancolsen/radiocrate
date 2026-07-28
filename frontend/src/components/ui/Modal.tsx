import { onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

/** A centered modal dialog over a dimming scrim. Closes on scrim click and on
 * Escape. Rendered through a Portal so it escapes the toolbar's stacking/overflow
 * context. */
export function Modal(props: {
  onClose: () => void;
  children: JSX.Element;
  width?: string;
}): JSX.Element {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <Portal>
      {/* `items-start` + the dialog's own `my-auto` centers it vertically when
          it fits, exactly like `items-center` would — but once the dialog is
          taller than the viewport (a short window, a long result list), the
          overlay scrolls instead of clipping the dialog off-screen. */}
      <div class="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4">
        <div
          class="absolute inset-0 bg-black/40"
          aria-hidden="true"
          onClick={() => props.onClose()}
        />
        <div
          role="dialog"
          aria-modal="true"
          class="bg-panel border-edge relative z-10 my-auto max-w-full rounded-lg border p-4 shadow-2xl"
          style={{ width: props.width ?? "320px" }}
        >
          {props.children}
        </div>
      </div>
    </Portal>
  );
}
