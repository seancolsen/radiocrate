import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";

// The keyboard contract every dropdown/context menu shares
// (`ui/useMenuKeyboard.ts`, stage 3) registers itself here while it's open, so
// the global shortcut pass (`stores/commands.ts`'s `suppressed`) can stand
// down while a menu owns the keyboard — otherwise a bare Up/Down/Delete bound
// to a page command (e.g. row selection) would fire *underneath* the menu at
// the same time it moves the menu's own highlight.
//
// Ported from `components/ui/menuKeyboard.ts`'s `openCount` module counter. A
// `Set<symbol>` rather than a counter, so StrictMode's mount → cleanup →
// mount for one hook instance (which reuses the same symbol every time)
// nets out to exactly one open entry rather than double-counting; a bare
// `++`/`--` counter can't tell a StrictMode replay from a second, genuinely
// nested menu opening underneath the first.

export interface MenusState {
  open: ReadonlySet<symbol>;
}

function initialMenusState(): MenusState {
  return { open: new Set<symbol>() };
}

function createMenusVanillaStore() {
  return createStore<MenusState>()(subscribeWithSelector(initialMenusState));
}

export type MenusVanillaStore = ReturnType<typeof createMenusVanillaStore>;

/** Whether any menu using `useMenuKeyboard` is currently open — checked by the
 * global shortcut pass so it stands down while a menu owns the keyboard. */
export const selectAnyMenuOpen = (s: MenusState): boolean => s.open.size > 0;

export interface MenusActions {
  /** Register one open menu instance under `id` (a symbol the hook creates
   * once per mount and keeps for its lifetime). Idempotent: opening the same
   * id twice in a row is a no-op, so a StrictMode replay before the matching
   * `closeMenu` can't inflate the count. */
  openMenu: (id: symbol) => void;
  /** Unregister one open menu instance. Idempotent likewise. */
  closeMenu: (id: symbol) => void;
}

function createMenusActions(store: MenusVanillaStore): MenusActions {
  return {
    openMenu: (id) => {
      const { open } = store.getState();
      if (open.has(id)) return;
      const next = new Set(open);
      next.add(id);
      store.setState({ open: next });
    },
    closeMenu: (id) => {
      const { open } = store.getState();
      if (!open.has(id)) return;
      const next = new Set(open);
      next.delete(id);
      store.setState({ open: next });
    },
  };
}

/** Builds the menu-open registry: a tiny vanilla store, so both the
 * `useMenuKeyboard` hook (React) and `stores/commands.ts` (plain) can use it
 * without either depending on the other. */
export function createMenusStore(): {
  store: MenusVanillaStore;
  actions: MenusActions;
} {
  const store = createMenusVanillaStore();
  const actions = createMenusActions(store);
  return { store, actions };
}

export type MenusStoreBundle = ReturnType<typeof createMenusStore>;
