import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { JSX, ReactNode } from "react";
import { Icons } from "../../icons";
import IconButton from "./IconButton";
import { useFocusTrap } from "./useFocusTrap";

/** A centered modal dialog over a dimming scrim: a title row, with the ×
 * that closes it at its far right, over `children`. Closes on the ×, on a
 * scrim click, and on an Escape nothing inside it has already used (as a
 * Querydown editor does, closing its completion popup). Tab is kept within it
 * (`useFocusTrap`). Rendered through a portal so it escapes the toolbar's
 * stacking/overflow context.
 *
 * The × is the way out of a dialog with nothing to confirm, so the dialog
 * itself has no Close button. One that asks for a decision keeps its Cancel
 * beside the button that confirms. */
export function Modal(props: {
  /** What the dialog is, in its title row. It names the dialog, too. */
  title: ReactNode;
  /** A line under the title, a little quieter. */
  subtitle?: ReactNode;
  /** The ×'s name: "Close" unless the dialog wants a more specific one. */
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}): JSX.Element {
  const { onClose, children, width } = props;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-panel border-edge relative z-10 my-auto max-w-full rounded-lg border p-4 shadow-2xl outline-none"
        style={{ width: width ?? "320px" }}
      >
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="text-ink flex min-h-[26px] items-center text-base font-semibold break-words"
            >
              {props.title}
            </h2>
            {props.subtitle !== undefined && (
              <p className="text-ink-weak text-sm">{props.subtitle}</p>
            )}
          </div>
          <IconButton
            icon={Icons.Close}
            label={props.closeLabel ?? "Close"}
            onClick={() => onClose()}
          />
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
