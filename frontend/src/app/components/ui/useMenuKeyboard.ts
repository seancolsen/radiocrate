import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStores } from "../../stores/react";

// The keyboard contract every dropdown/context menu shares: a focus trap (Tab
// cycles within the menu instead of escaping it), Up/Down roving real DOM
// focus between rows, and Enter activating whichever row holds it. Wiring
// this onto a menu's container also registers it as open in the `menus`
// store, which the global shortcut pass (`stores/commands.ts`'s `suppressed`)
// checks — otherwise a bare Up/Down/Delete bound to a page command (e.g. row
// selection) would fire *underneath* the menu at the same time it moves the
// menu's own highlight.
//
// Ported from `components/ui/menuKeyboard.ts`. The module-level `openCount`
// counter becomes the `menus` store's `Set<symbol>`: each hook instance keeps
// one `symbol` (created once, via a ref) for its whole lifetime, so
// StrictMode's mount → cleanup → mount replay opens and closes the *same* id
// and nets out to one open entry, where a bare `++`/`--` counter would double
// it.

/** The selector for a menu's rows: `MenuItem` (`menuitem`) and
 * `MenuToggleItem` (`menuitemcheckbox` / `menuitemradio`) rows, skipping
 * disabled ones — matches any role starting with "menuitem". */
const ROW_SELECTOR = '[role^="menuitem"]:not(:disabled)';

/** Wires the shared menu keyboard behavior onto an open menu's container.
 * Call once per mount of the menu's content (i.e. from inside the component
 * that renders it while open) — it focuses the first row immediately and
 * restores focus to whatever held it before, once the menu closes. */
export function useMenuKeyboard(
  getContainer: () => HTMLElement | undefined | null,
  onClose: () => void,
): void {
  const { menus } = useStores();
  const [id] = useState(() => Symbol("menu"));

  // Refs so the layout effect below can stay a mount-only effect (an empty
  // dependency array) while still calling whatever `getContainer`/`onClose`
  // the *latest* render closed over — exactly what `onMount`'s closure gave
  // Solid for free, since it only ever ran once per component instance.
  // Synced from effects, never from the render body: a ref write during
  // render is unsafe (React may discard or replay a render without it ever
  // having "happened"), even though the ref's *initial* value is already
  // right for the first render via `useRef`'s own argument.
  const getContainerRef = useRef(getContainer);
  useEffect(() => {
    getContainerRef.current = getContainer;
  }, [getContainer]);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // What held focus before the menu opened, captured by the first setup only.
  // StrictMode's replay runs setup a second time *after* the first has focused
  // the menu's own first row, so a second capture would record that row and
  // closing would "restore" focus to a detached button.
  const previouslyFocusedRef = useRef<HTMLElement | null | undefined>(
    undefined,
  );

  useLayoutEffect(() => {
    const rows = (): HTMLElement[] => {
      const el = getContainerRef.current();
      return el
        ? Array.from(el.querySelectorAll<HTMLElement>(ROW_SELECTOR))
        : [];
    };

    const focusAt = (index: number): void => {
      const list = rows();
      if (list.length === 0) return;
      list[((index % list.length) + list.length) % list.length]?.focus();
    };

    const focusDelta = (delta: number): void => {
      const list = rows();
      const current = list.indexOf(document.activeElement as HTMLElement);
      focusAt(current === -1 ? (delta > 0 ? 0 : -1) : current + delta);
    };

    if (previouslyFocusedRef.current === undefined)
      previouslyFocusedRef.current =
        document.activeElement as HTMLElement | null;
    const previouslyFocused = previouslyFocusedRef.current;
    menus.actions.openMenu(id);
    focusAt(0);

    // Keeps the mouse in sync with the roving focus: hovering a row focuses
    // it, so the highlighted row always matches whichever input (keyboard or
    // mouse) moved last. Needs `mousemove`, not `mouseover`/`mouseenter`: if
    // the keyboard moves focus away while the pointer sits still over a row,
    // the next pointer motion — even within that same row, i.e. no new
    // enter/leave transition — must reclaim focus for it.
    const onMouseMove = (e: MouseEvent): void => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(ROW_SELECTOR);
      if (row && row !== document.activeElement) row.focus();
    };
    const container = getContainerRef.current();
    container?.addEventListener("mousemove", onMouseMove);

    const onKeyDown = (e: KeyboardEvent): void => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onCloseRef.current();
          break;
        case "ArrowDown":
          e.preventDefault();
          focusDelta(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          focusDelta(-1);
          break;
        case "Tab":
          // The focus trap: Tab/Shift+Tab cycle within the menu's own rows
          // rather than leaving it for the rest of the page.
          e.preventDefault();
          focusDelta(e.shiftKey ? -1 : 1);
          break;
        case "Enter": {
          const active = document.activeElement;
          if (
            active instanceof HTMLElement &&
            getContainerRef.current()?.contains(active)
          ) {
            e.preventDefault();
            active.click();
          }
          break;
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      container?.removeEventListener("mousemove", onMouseMove);
      menus.actions.closeMenu(id);
      // Deferred, and only once nothing else has claimed focus: several menu
      // rows (Edit, "Enter a new record", "Pick a record", ...) deliberately
      // focus something of their own as part of what they do, queued to run
      // once the click that chose them finishes — same tick as this cleanup,
      // but after it. Restoring unconditionally here would win that race and
      // steal focus back before the row's own effect lands (worse, refocusing
      // the old target can itself cancel what the row just started, e.g. an
      // edit-in-progress that a field's blur handler treats as abandoned).
      // Once this menu's content is gone, focus reverts to <body> until
      // something else claims it — that's the signal nothing did.
      queueMicrotask(() => {
        if (document.activeElement === document.body)
          previouslyFocused?.focus();
      });
    };
    // `id` and `menus` are both stable for the component's life (a `useState`
    // initializer and the store bundle from context, respectively), and every
    // other input is read through a ref — so despite the dependency array,
    // this never actually re-runs mid-life, matching the Solid `onMount`/
    // `onCleanup` pair it replaces.
  }, [id, menus]);
}
