import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { chordToAria } from "../../commands/chord";
import type { CommandId } from "../../commands/registry";
import { selectBinding } from "../../stores/commands";
import { useCommands } from "../../stores/react";
import { LONG_PRESS_MS } from "../../gestures/press";
import { Kbd } from "./Kbd";
import { placeDropdown } from "./menuGeometry";
import { cx } from "./cx";

// Tooltips of our own drawing, in place of the browser's `title`. A tooltip
// names a control that shows no text of its own — an icon-only button — so
// what it says is the control's label, and the hook below writes that label
// once into both places it belongs: the panel the pointer sees, and the
// `aria-label` a screen reader reads. A control that a keyboard shortcut also
// triggers names its command, and the shortcut's chord (as the user has bound
// it) shows beside the label and goes out as `aria-keyshortcuts`.
//
// It shows after a short hover, at once on keyboard focus, and for touch after
// a touch-and-hold, lingering a moment past the release so the finger isn't
// left covering it. The release of a hold that showed one isn't a click.
// Pressing the control hides it until the pointer leaves, so it never
// covers the menu or the change the press brought up. Once one has shown,
// moving straight on to a neighbor shows the neighbor's at once, the way a
// toolbar's tooltips read along the row.

/** How long the pointer rests on a control before its tooltip shows. */
const OPEN_DELAY_MS = 500;
/** How long after a tooltip hides that the next one skips the delay. */
const WARM_MS = 400;
/** Until when a tooltip shows without the delay: one has just hidden. Shared
 * by every tooltip — it's the row of them that's warm, not one. */
let warmUntil = 0;
/** How long a touch-held tooltip stays after the finger lifts. */
const TOUCH_LINGER_MS = 1500;

/** What a tooltip says, and where it hangs. */
export interface TooltipSpec {
  /** The control's name: shown in the panel, and its `aria-label`. Keep it a
   * label ("Save", "Close explorer"), not help text. */
  label: string;
  /** The command a keyboard shortcut runs to the same effect. Its chord shows
   * beside the label; an unbound command shows none. */
  command?: CommandId;
  /** Longer text shown in place of the label, and announced as the control's
   * description (`aria-describedby`) while it shows. For a control whose
   * whole point is to explain (a help "?"), not for naming one. */
  description?: string;
  /** Which of the control's edges the panel lines up with. Centered unless the
   * control sits at an edge a wide panel would overrun. */
  align?: "start" | "center" | "end";
}

/** The props a tooltip's trigger spreads onto its element. */
export interface TooltipTriggerProps {
  "aria-label"?: string;
  "aria-keyshortcuts"?: string;
  "aria-describedby"?: string;
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e?: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (e?: PointerEvent<HTMLElement>) => void;
  onPointerUp?: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel?: () => void;
  onClickCapture?: (e: MouseEvent<HTMLElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
}

/** A tooltip for one control: `triggerProps` to spread onto the control (its
 * accessible name and shortcut, and the handlers that show and hide the
 * panel), and `tooltip`, the panel itself, to render anywhere beside it (it
 * portals itself out to the body). A `null` spec is no tooltip and no props —
 * for a control that's only sometimes icon-only, while its label shows. A
 * caller that has a handler of its own for one of the events calls the
 * tooltip's from it. */
export function useTooltip(spec: TooltipSpec | null): {
  triggerProps: TooltipTriggerProps;
  tooltip: ReactNode;
} {
  const id = useId();
  // The control the panel hangs off, while it shows.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  // A press hides the tooltip until the pointer leaves.
  const pressed = useRef(false);
  // A touch is down on the control; and a touch-hold has shown the tooltip, so
  // the release's click (and the context menu the OS raises) is to be eaten.
  const touching = useRef(false);
  const held = useRef(false);
  const command = spec?.command;
  const chord = useCommands((s) =>
    command ? selectBinding(s, command) : null,
  );

  useEffect(() => {
    return () => window.clearTimeout(timer.current);
  }, []);

  if (!spec) return { triggerProps: {}, tooltip: null };

  const show = (el: HTMLElement, now: boolean) => {
    window.clearTimeout(timer.current);
    if (now || performance.now() < warmUntil) setAnchor(el);
    else timer.current = window.setTimeout(() => setAnchor(el), OPEN_DELAY_MS);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    if (anchor) warmUntil = performance.now() + WARM_MS;
    setAnchor(null);
  };

  return {
    triggerProps: {
      "aria-label": spec.label,
      "aria-keyshortcuts": chord ? chordToAria(chord) : undefined,
      "aria-describedby": anchor && spec.description ? id : undefined,
      onPointerEnter: (e) => {
        if (e.pointerType !== "touch" && !pressed.current) {
          show(e.currentTarget, false);
        }
      },
      onPointerLeave: (e) => {
        pressed.current = false;
        // A touch's pointer "leaves" as it lifts; the linger decides then.
        if (e?.pointerType === "touch" && held.current) return;
        hide();
      },
      onPointerDown: (e) => {
        hide();
        if (e?.pointerType === "touch") {
          touching.current = true;
          held.current = false;
          const el = e.currentTarget;
          timer.current = window.setTimeout(() => {
            held.current = true;
            setAnchor(el);
          }, LONG_PRESS_MS);
        } else {
          pressed.current = true;
        }
      },
      onPointerUp: (e) => {
        if (e.pointerType !== "touch") return;
        touching.current = false;
        window.clearTimeout(timer.current);
        if (held.current)
          timer.current = window.setTimeout(hide, TOUCH_LINGER_MS);
      },
      onPointerCancel: () => {
        touching.current = false;
        held.current = false;
        hide();
      },
      onClickCapture: (e) => {
        if (!held.current) return;
        held.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
      onContextMenu: (e) => {
        if (touching.current || held.current) e.preventDefault();
      },
      // Keyboard focus only: a click focuses too, and the press already
      // decided the tooltip stays hidden.
      onFocus: (e) => {
        if (e.currentTarget.matches(":focus-visible")) {
          show(e.currentTarget, true);
        }
      },
      onBlur: hide,
      // Any key hides it — Enter opening a menu under it, say — and Escape is
      // the tooltip's own to take while it shows.
      onKeyDown: (e) => {
        if (!anchor) return;
        if (e.key === "Escape") e.stopPropagation();
        hide();
      },
    },
    tooltip: anchor && (
      <TooltipPanel
        id={id}
        anchor={anchor}
        align={spec.align ?? "center"}
        description={spec.description !== undefined}
        onDismiss={hide}
      >
        {spec.description ?? (
          <>
            <span>{spec.label}</span>
            {chord && <Kbd chord={chord} className="text-ink-weak" />}
          </>
        )}
      </TooltipPanel>
    ),
  };
}

/** The panel: hung below `anchor` (or, without room, above it) and kept wholly
 * inside the viewport. A label's panel is hidden from assistive technology —
 * the trigger's `aria-label` already says it — while a description's is the
 * `role="tooltip"` the trigger is described by. Scrolling hides it, rather than
 * leaving it behind. */
function TooltipPanel(props: {
  id: string;
  anchor: HTMLElement;
  align: "start" | "center" | "end";
  description: boolean;
  onDismiss: () => void;
  children: ReactNode;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const { onDismiss } = props;

  // Placed before paint, so it never shows anywhere but where it belongs —
  // again on every render, since what it says can change its width.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const root = document.documentElement;
    const p = placeDropdown(
      props.anchor.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: root.clientWidth, height: root.clientHeight },
      "below",
      props.align,
    );
    panel.style.left = `${p.left}px`;
    panel.style.top = `${p.top}px`;
  });

  useEffect(() => {
    window.addEventListener("scroll", onDismiss, true);
    return () => window.removeEventListener("scroll", onDismiss, true);
  }, [onDismiss]);

  return createPortal(
    <div
      ref={panelRef}
      id={props.id}
      data-testid="tooltip"
      role={props.description ? "tooltip" : undefined}
      aria-hidden={props.description ? undefined : true}
      className={cx(
        "bg-panel border-edge text-ink pointer-events-none fixed top-0 left-0 z-[200] rounded-md border text-xs shadow-lg",
        {
          "max-w-xs px-2.5 py-2 leading-5": props.description,
          "flex items-center gap-2 px-2 py-1 whitespace-nowrap":
            !props.description,
        },
      )}
    >
      {props.children}
    </div>,
    document.body,
  );
}
