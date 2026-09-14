import { describe, expect, it } from "vitest";
import { emptyDefinition } from "../../query/definition";
import { createAppStore } from "./index";
import { SHORTCUTS_TAB_ID } from "./state";
import { fakeEnv } from "./testEnv";

describe("open tabs", () => {
  it("come back after a reload, unsaved edits and never-saved tabs included", () => {
    const env = fakeEnv();
    const before = createAppStore(env);
    before.actions.openTab({ id: "q1", name: "Lemonade", definition: "{}" });
    const live = emptyDefinition();
    live.filter.custom = "year:1999";
    before.actions.setTabDefinitions("q1", emptyDefinition(), live);
    before.actions.duplicateQuery("q1");
    before.actions.openShortcutsTab();
    before.actions.selectTab("q1");
    before.dispose();

    // A fresh store over the same storage stands in for the reloaded page.
    const after = createAppStore(env);
    const s = after.store.getState();
    expect(s.tabs.map((t) => t.kind)).toEqual(["query", "query", "shortcuts"]);
    expect(s.activeTabId).toBe("q1");
    const [restored, duplicate, shortcuts] = s.tabs;
    expect(restored).toMatchObject({
      id: "q1",
      name: "Lemonade",
      persisted: true,
    });
    expect(restored.kind === "query" && restored.live.filter.custom).toBe(
      "year:1999",
    );
    expect(duplicate).toMatchObject({ kind: "query", persisted: false });
    expect(shortcuts.id).toBe(SHORTCUTS_TAB_ID);
    after.dispose();
  });

  it("leave nothing behind once the last one closes", () => {
    const env = fakeEnv();
    const bundle = createAppStore(env);
    bundle.actions.openTab({ id: "q1", name: "Lemonade", definition: "{}" });
    expect(env.storage.getItem("openTabs")).not.toBeNull();
    bundle.actions.closeTab("q1");
    expect(env.storage.getItem("openTabs")).toBeNull();
    bundle.dispose();
  });

  it("restore nothing from a record that can't be trusted", () => {
    for (const raw of [
      "not json",
      JSON.stringify({ version: 99, activeTabId: null, tabs: [] }),
      JSON.stringify({
        version: 1,
        activeTabId: "q1",
        tabs: [{ kind: "query" }],
      }),
    ]) {
      const env = fakeEnv();
      env.storage.setItem("openTabs", raw);
      const bundle = createAppStore(env);
      expect(bundle.store.getState().tabs).toEqual([]);
      expect(bundle.store.getState().activeTabId).toBeNull();
      bundle.dispose();
    }
  });

  it("fall back to the first tab when the active one wasn't restored", () => {
    const env = fakeEnv();
    env.storage.setItem(
      "openTabs",
      JSON.stringify({
        version: 1,
        activeTabId: "gone",
        tabs: [{ kind: "shortcuts" }],
      }),
    );
    const bundle = createAppStore(env);
    expect(bundle.store.getState().activeTabId).toBe(SHORTCUTS_TAB_ID);
    bundle.dispose();
  });
});
