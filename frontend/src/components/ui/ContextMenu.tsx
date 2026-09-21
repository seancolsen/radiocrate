import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { JSX, ReactNode } from "react";
import { MENU_PANEL_CLASS } from "./Menu";
import { placeAtPoint } from "./menuGeometry";
import { MenuContext, useMenuRoot, usePlacement } from "./useMenu";

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
 * Closes on outside pointerdown, on a resize that would strand it away from its
 * anchor, and on any click inside the content — matching {@link Menu}, where
 * choosing a row dismisses the popup. While open, {@link useMenuRoot} owns
 * Escape, the focus trap, arrow-key navigation and submenus. */
export function ContextMenu(props: {
  /** Viewport coordinates to anchor at (the `contextmenu` event's client x/y). */
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  /** Stacking layer, for a menu raised from inside another overlay. The app's
   * layers: page content menus 90 (the default), modal dialogs 100, the command
   * palette 110 — so a menu opened *within* a dialog needs 120. */
  z?: number;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const menu = useMenuRoot(
    () => menuRef.current,
    () => props.onClose(),
  );

  // Anchor the menu at the pointer, slid back inside the viewport where it
  // would overflow — the standard context-menu placement. Placed before the
  // browser paints, so the menu never appears at the unclamped position first.
  usePlacement(menuRef, null, (_anchor, size, viewport) =>
    placeAtPoint({ x: props.x, y: props.y }, size, viewport),
  );

  useEffect(() => {
    // A resize (or an on-screen keyboard) moves the content out from under the
    // anchor; dismiss rather than leave the menu pointing at nothing.
    window.addEventListener("resize", props.onClose);
    return () => window.removeEventListener("resize", props.onClose);
  }, [props.onClose]);

  return createPortal(
    <div
      className="fixed inset-0"
      style={{ zIndex: props.z ?? 90 }}
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
      <MenuContext.Provider
        value={{ menu, depth: 0, closeRoot: props.onClose }}
      >
        <div
          ref={menuRef}
          role="menu"
          className={MENU_PANEL_CLASS}
          style={{ minWidth: props.width ?? "170px" }}
          // Keep a press inside the menu from reaching the blocking layer's
          // dismiss handler — the click that follows is what runs the action.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => props.onClose()}
          onContextMenu={(e) => e.preventDefault()}
          onPointerMove={(e) => menu.pointerMove(0, e)}
          onPointerLeave={() => menu.tree.pointerLeaveTree()}
        >
          {props.children}
        </div>
      </MenuContext.Provider>
    </div>,
    document.body,
  );
}
