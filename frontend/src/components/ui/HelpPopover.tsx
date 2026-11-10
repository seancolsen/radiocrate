import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Icons } from "../../icons";
import IconButton from "./IconButton";
import { placeDropdown } from "./menuGeometry";
import { usePlacement } from "./useMenu";

/** A "?" button that opens a panel of help: for help too long, or too
 * structured, for a help tooltip (`IconButton`'s `description`), and for a
 * page used on a phone, where a tooltip waits on a touch-and-hold nobody
 * thinks to try. A click opens it and a second click closes it, as do Escape
 * and a press anywhere outside it.
 *
 * `label` names the button (its tooltip and `aria-label`) and the panel.
 * `align` lines the panel up with the button's start or end edge — `"end"`
 * for a button at the right of a toolbar. */
export default function HelpPopover(props: {
  label: string;
  align?: "start" | "end";
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={buttonRef}
        icon={Icons.Help}
        label={props.label}
        tooltipAlign={props.align}
        active={open}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <HelpPanel
          label={props.label}
          align={props.align ?? "start"}
          button={buttonRef}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) buttonRef.current?.focus();
          }}
        >
          {props.children}
        </HelpPanel>
      )}
    </>
  );
}

/** The open panel, mounted fresh each time it opens, so it takes focus then
 * (a screen reader reads it from the top). */
function HelpPanel(props: {
  label: string;
  align: "start" | "end";
  button: RefObject<HTMLButtonElement | null>;
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const { button, onClose } = props;

  usePlacement(
    panelRef,
    () => button.current,
    (anchor, size, viewport) =>
      placeDropdown(
        anchor ?? { left: 0, top: 0, right: 0, bottom: 0 },
        size,
        viewport,
        "below",
        props.align,
      ),
  );

  useLayoutEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    // A press on the button itself is left to its click, which toggles.
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (button.current?.contains(target)) return;
      onClose(false);
    };
    // On the window, in the capture phase, so the panel has Escape before the
    // app's own shortcuts (registered on the document) see it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose(true);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [button, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={props.label}
      tabIndex={-1}
      data-testid="help-popover"
      className="bg-panel border-edge text-ink fixed top-0 left-0 z-50 w-[min(380px,calc(100vw-16px))] overflow-y-auto rounded-md border px-3.5 py-3 text-sm leading-5 shadow-lg outline-none"
    >
      {props.children}
    </div>,
    document.body,
  );
}
