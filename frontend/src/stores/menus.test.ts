import { describe, expect, it } from "vitest";
import { createMenusStore, selectAnyMenuOpen } from "./menus";

describe("menus store", () => {
  it("reports open only while at least one id is registered", () => {
    const { store, actions } = createMenusStore();
    const a = Symbol("a");
    const b = Symbol("b");
    expect(selectAnyMenuOpen(store.getState())).toBe(false);

    actions.openMenu(a);
    expect(selectAnyMenuOpen(store.getState())).toBe(true);

    // A second, genuinely nested menu opening underneath the first.
    actions.openMenu(b);
    actions.closeMenu(a);
    expect(selectAnyMenuOpen(store.getState())).toBe(true);

    actions.closeMenu(b);
    expect(selectAnyMenuOpen(store.getState())).toBe(false);
  });

  it("is idempotent, so a StrictMode mount → cleanup → mount replay can't miscount", () => {
    const { store, actions } = createMenusStore();
    const id = Symbol("menu");

    actions.openMenu(id);
    actions.openMenu(id); // replayed mount with the same symbol
    actions.closeMenu(id); // the replay's own cleanup
    // The real, final open should still register.
    actions.openMenu(id);
    expect(selectAnyMenuOpen(store.getState())).toBe(true);

    actions.closeMenu(id);
    actions.closeMenu(id); // a redundant close is a no-op, not a negative count
    expect(selectAnyMenuOpen(store.getState())).toBe(false);
  });
});
