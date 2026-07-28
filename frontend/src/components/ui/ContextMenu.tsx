import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { JSX } from "solid-js";
import { useMenuKeyboard } from "./menuKeyboard";

/** Gap kept between the menu and the viewport edges when it has to flip. */
const EDGE_MARGIN = 8;

/** A menu anchored at a point (a right-click), rendered in the DOM over
 * everything else — including the results canvas, which draws no menus of its
 * own.
 *
 * The whole viewport is covered by a transparent blocking layer while the menu
 * is up. That layer is what makes the menu modal: every pointer event lands on
 * it instead of the content beneath, so the results pane can't be hovered,
 * scrolled or clicked through, and a click outside *only* dismisses the menu —
 * it never also selects the row it landed on. (The results grid is frozen in
 * parallel by its owner, for the events a DOM layer can't intercept.)
 *
 * Closes on outside pointerdown, on a scroll/resize that would strand it away
 * from its anchor, and on any click inside the content — matching {@link Menu},
 * where choosing a row dismisses the popup. While open, {@link useMenuKeyboard}
 * owns Escape, the focus trap, and Up/Down/Enter navigation. */
export function ContextMenu(props: {
  /** Viewport coordinates to anchor at (the `contextmenu` event's client x/y). */
  x: number;
  y: number;
  onClose: () => void;
  children: JSX.Element;
  width?: string;
  /** Stacking layer, for a menu raised from inside another overlay. The app's
   * layers: page content menus 90 (the default), modal dialogs 100, the command
   * palette 110 — so a menu opened *within* a dialog needs 120. */
  z?: number;
}): JSX.Element {
  let menu: HTMLDivElement | undefined;
  // Placed by the effect below, which runs after the menu is in the DOM (it has
  // to measure it) but before the browser paints — so the zero here is never
  // seen, and the menu never appears at the wrong spot first.
  const [pos, setPos] = createSignal({ left: 0, top: 0 });

  // Anchor the menu at the pointer, flipping it back inside the viewport when it
  // would overflow — the standard context-menu placement. Runs as an effect (so
  // it re-places if the anchor moves) but before the browser paints, so the menu
  // never appears at the unflipped position first.
  createEffect(() => {
    const x = props.x;
    const y = props.y;
    const rect = menu?.getBoundingClientRect();
    const w = rect?.width ?? 0;
    const h = rect?.height ?? 0;
    const maxLeft = window.innerWidth - w - EDGE_MARGIN;
    const maxTop = window.innerHeight - h - EDGE_MARGIN;
    setPos({
      left: Math.max(EDGE_MARGIN, Math.min(x, maxLeft)),
      top: Math.max(EDGE_MARGIN, Math.min(y, maxTop)),
    });
  });

  useMenuKeyboard(
    () => menu,
    () => props.onClose(),
  );

  onMount(() => {
    // A resize (or an on-screen keyboard) moves the content out from under the
    // anchor; dismiss rather than leave the menu pointing at nothing.
    window.addEventListener("resize", props.onClose);
    onCleanup(() => window.removeEventListener("resize", props.onClose));
  });

  return (
    <Portal>
      <div
        class="fixed inset-0"
        style={{ "z-index": props.z ?? 90 }}
        onPointerDown={() => props.onClose()}
        // A right-click outside dismisses too, without handing the browser's own
        // menu to the blocking layer.
        onContextMenu={(e) => {
          e.preventDefault();
          props.onClose();
        }}
        // Nothing behind the layer may scroll while the menu is up.
        onWheel={(e) => e.preventDefault()}
      >
        <div
          ref={(el) => (menu = el)}
          role="menu"
          class="bg-panel border-edge absolute flex flex-col gap-0.5 rounded-md border p-1 shadow-lg"
          style={{
            left: `${pos().left}px`,
            top: `${pos().top}px`,
            "min-width": props.width ?? "170px",
          }}
          // Keep a press inside the menu from reaching the blocking layer's
          // dismiss handler — the click that follows is what runs the action.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => props.onClose()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {props.children}
        </div>
      </div>
    </Portal>
  );
}
