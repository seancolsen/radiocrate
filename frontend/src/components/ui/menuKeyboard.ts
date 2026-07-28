import { onCleanup, onMount } from "solid-js";

// The keyboard contract every dropdown/context menu shares: a focus trap (Tab
// cycles within the menu instead of escaping it), Up/Down roving real DOM
// focus between rows, and Enter activating whichever row holds it. Wiring
// this onto a menu's container also registers it as open here, which the
// global shortcut pass (`state/commands.tsx:suppressed`) checks — otherwise a
// bare Up/Down/Delete bound to a page command (e.g. row selection) would fire
// *underneath* the menu at the same time it moves the menu's own highlight.

// A plain counter, not a Solid signal: nothing renders off this, it only needs
// to be readable synchronously from the command store's keydown handler. A
// counter rather than a boolean so a menu opened from inside another overlay
// (nesting) can't have the outer one's close miscount it shut.
let openCount = 0;

/** Whether any menu using {@link useMenuKeyboard} is currently open — checked
 * by the global shortcut pass so it stands down while a menu owns the
 * keyboard. */
export function anyMenuOpen(): boolean {
  return openCount > 0;
}

/** The selector for a menu's rows: `MenuItem` (`menuitem`) and
 * `MenuToggleItem` (`menuitemcheckbox` / `menuitemradio`) rows, skipping
 * disabled ones — matches any role starting with "menuitem". */
const ROW_SELECTOR = '[role^="menuitem"]:not(:disabled)';

/** Wires the shared menu keyboard behavior onto an open menu's container.
 * Call once per mount of the menu's content (i.e. from inside the `Show`/
 * `Portal` that renders it while open) — it focuses the first row immediately
 * and restores focus to whatever held it before, once the menu closes. */
export function useMenuKeyboard(
  getContainer: () => HTMLElement | undefined,
  onClose: () => void,
): void {
  const rows = (): HTMLElement[] => {
    const el = getContainer();
    return el ? Array.from(el.querySelectorAll<HTMLElement>(ROW_SELECTOR)) : [];
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

  onMount(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    openCount++;
    focusAt(0);

    const onKeyDown = (e: KeyboardEvent): void => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
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
            getContainer()?.contains(active)
          ) {
            e.preventDefault();
            active.click();
          }
          break;
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown);
      openCount--;
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
    });
  });
}
