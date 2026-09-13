import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { JSX, ReactNode } from "react";

/** A centered modal dialog over a dimming scrim. Closes on scrim click and on
 * Escape. Rendered through a portal so it escapes the toolbar's stacking/overflow
 * context. */
export function Modal(props: {
  onClose: () => void;
  children: ReactNode;
  width?: string;
}): JSX.Element {
  const { onClose, children, width } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    // `items-start` + the dialog's own `my-auto` centers it vertically when
    // it fits, exactly like `items-center` would — but once the dialog is
    // taller than the viewport (a short window, a long result list), the
    // overlay scrolls instead of clipping the dialog off-screen.
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4">
      <div
        className="absolute inset-0 bg-black/40"
        aria-hidden="true"
        onClick={() => onClose()}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="bg-panel border-edge relative z-10 my-auto max-w-full rounded-lg border p-4 shadow-2xl"
        style={{ width: width ?? "320px" }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
