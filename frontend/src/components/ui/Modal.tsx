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
      <div class="fixed inset-0 z-[100] flex items-center justify-center p-4">
        <div
          class="absolute inset-0 bg-black/40"
          aria-hidden="true"
          onClick={() => props.onClose()}
        />
        <div
          role="dialog"
          aria-modal="true"
          class="bg-panel border-edge relative z-10 max-w-full rounded-lg border p-4 shadow-2xl"
          style={{ width: props.width ?? "320px" }}
        >
          {props.children}
        </div>
      </div>
    </Portal>
  );
}
