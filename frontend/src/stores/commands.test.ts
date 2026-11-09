import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChord } from "../commands/chord";
import { commandDef } from "../commands/registry";
import { buildResultFromStringRows } from "../query/result";
import { createAppStore, type AppStoreBundle } from "./app";
import { fakeEnv } from "./app/testEnv";
import {
  createCommandsStore,
  selectBinding,
  type CommandsStoreBundle,
} from "./commands";
import {
  createFormsStore,
  type FormsStoreBundle,
  type RecordFormModel,
  type RecordFormSummary,
} from "./forms";
import { createMenusStore, type MenusStoreBundle } from "./menus";

vi.mock("api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("api-client")>();
  return {
    ...actual,
    keybindingList: vi.fn(() => Promise.resolve([])),
    keybindingSet: vi.fn(() => Promise.resolve(null)),
    keybindingDelete: vi.fn(() => Promise.resolve(null)),
  };
});

const IDLE_SUMMARY: RecordFormSummary = {
  focused: false,
  selecting: false,
  pickerOpen: false,
  modified: false,
  canAutocomplete: false,
};

/** A stubbed, focused-and-mounted record form: enough for the selection
 * commands to route to it. Cast, since the commands only reach a form through
 * these members — not the rest of the real model's surface. */
function mountFocusedForm(forms: FormsStoreBundle, tabId: string) {
  const summaryStore = createStore<RecordFormSummary>()(() => ({
    ...IDLE_SUMMARY,
    focused: true,
  }));
  const model = {
    store: summaryStore,
    getSummary: () => summaryStore.getState(),
    dispose: vi.fn(),
    focusAdjacent: vi.fn(() => true),
    expandSelection: vi.fn(),
    deleteSelection: vi.fn(),
  } as unknown as RecordFormModel;
  forms.actions.stashedForm(tabId, ["r1"], () => model);
  forms.actions.mount(tabId, ["r1"]);
  return model;
}

describe("commands store", () => {
  let app: AppStoreBundle;
  let forms: FormsStoreBundle;
  let menus: MenusStoreBundle;
  let commands: CommandsStoreBundle;

  beforeEach(() => {
    app = createAppStore(fakeEnv());
    forms = createFormsStore();
    menus = createMenusStore();
    commands = createCommandsStore(app, forms, menus);
  });

  describe('run("tabs.save_all")', () => {
    it("saves only tabs that are actually unsaved", () => {
      // A saved query's edit is saved lazily, on its own: nothing to do here.
      app.actions.openTab({ id: "saved", name: "saved", definition: "{}" });
      app.actions.setFilterCustom("saved", "artist:queen");
      app.actions.newQueryTab();
      const unsaved = app.store.getState().activeTabId;

      const saveQuery = vi.spyOn(app.actions, "saveQuery");
      commands.actions.run("tabs.save_all");

      expect(saveQuery).toHaveBeenCalledTimes(1);
      expect(saveQuery).toHaveBeenCalledWith(unsaved);
    });
  });

  describe('run("query.new")', () => {
    it("opens a new query, with or without a tab open", () => {
      commands.actions.run("query.new");
      commands.actions.run("query.new");
      const { tabs, activeTabId } = app.store.getState();
      expect(tabs.map((t) => t.kind)).toEqual(["query", "query"]);
      expect(activeTabId).toBe(tabs[1].id);
    });
  });

  describe("tabs.rename_active", () => {
    it("renames a query or playlist tab, and no other kind", () => {
      app.actions.openTab({ id: "q", name: "Q", definition: "{}" });
      app.actions.selectTab("q");
      commands.actions.run("tabs.rename_active");
      expect(app.store.getState().renaming).toMatchObject({
        id: "q",
        buffer: "Q",
      });

      app.actions.cancelRename();
      app.actions.openShortcutsTab();
      commands.actions.run("tabs.rename_active");
      expect(app.store.getState().renaming).toBeNull();
    });

    it("is F2, and only offered where a tab can be renamed", () => {
      expect(commandDef("tabs.rename_active").defaultChord).toEqual(
        parseChord("F2"),
      );
      expect(commandDef("tabs.rename_active").when).toBe("queryTab");
    });
  });

  describe("results.edit_selected", () => {
    it("toggles the record editor", () => {
      app.actions.openTab({ id: "t", name: "t", definition: "{}" });
      app.actions.selectTab("t");
      const edit = vi.spyOn(app.actions, "editSelectedRows");
      const close = vi.spyOn(app.actions, "closeRecordEditor");

      commands.actions.run("results.edit_selected");
      expect(edit).toHaveBeenCalledWith("t");

      app.actions.setRecordEditorRecords("t", "track", [
        { table: "track", key: [{ column: "id", value: "x" }] },
      ]);
      commands.actions.run("results.edit_selected");
      expect(close).toHaveBeenCalledWith("t");
      expect(app.store.getState().pages.t?.recordEditor).toBeNull();
    });
  });

  describe("results.focus", () => {
    it("lets go of the focused record form", () => {
      app.actions.openTab({ id: "t", name: "t", definition: "{}" });
      app.actions.selectTab("t");
      const model = mountFocusedForm(forms, "t");
      (model as unknown as { noteBlur: () => void }).noteBlur = vi.fn();

      commands.actions.run("results.focus");
      expect(model.noteBlur).toHaveBeenCalledTimes(1);
    });
  });

  describe("selection commands", () => {
    it("route to the focused record form instead of the result rows", () => {
      app.actions.openTab({ id: "t", name: "t", definition: "{}" });
      app.actions.selectTab("t");
      const model = mountFocusedForm(forms, "t");
      const moveRowSelection = vi.spyOn(app.actions, "moveRowSelection");

      commands.actions.run("results.select_next");
      expect(model.focusAdjacent).toHaveBeenCalledWith(true);
      expect(moveRowSelection).not.toHaveBeenCalled();

      commands.actions.run("selection.expand_nested");
      expect(model.expandSelection).toHaveBeenCalledWith(true);

      commands.actions.run("selection.delete");
      expect(model.deleteSelection).toHaveBeenCalledTimes(1);
    });

    it("fall through to row selection when no form is focused", () => {
      app.actions.openTab({ id: "t", name: "t", definition: "{}" });
      app.actions.selectTab("t");
      const moveRowSelection = vi.spyOn(app.actions, "moveRowSelection");

      commands.actions.run("results.select_next");
      expect(moveRowSelection).toHaveBeenCalledWith("t", true, false);
    });
  });

  describe("record.autocomplete", () => {
    beforeEach(() => vi.stubGlobal("HTMLElement", class {}));
    afterEach(() => vi.unstubAllGlobals());

    /** A mounted form with a field in edit mode that can offer autocomplete. A
     * click into a value begins an edit without giving the form a focused item,
     * so the summary says nothing of focus. */
    function mountEditingForm(canAutocomplete: boolean) {
      const summary = createStore<RecordFormSummary>()(() => ({
        ...IDLE_SUMMARY,
        canAutocomplete,
      }));
      const model = {
        store: summary,
        getSummary: () => summary.getState(),
        dispose: vi.fn(),
        toggleAutocomplete: vi.fn(),
      } as unknown as RecordFormModel;
      forms.actions.stashedForm("t", ["r1"], () => model);
      forms.actions.mount("t", ["r1"]);
      return model;
    }
    /** Ctrl+Enter, in a text box, as the global keydown pass sees it. */
    function pressCtrlEnter() {
      const event = {
        code: "Enter",
        key: "Enter",
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      commands.actions.handleKeyDown(event as unknown as KeyboardEvent);
      return event;
    }

    it("takes Ctrl+Enter on a field that can offer autocomplete", () => {
      const model = mountEditingForm(true);
      const event = pressCtrlEnter();
      expect(model.toggleAutocomplete).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("leaves Ctrl+Enter alone anywhere else", () => {
      const model = mountEditingForm(false);
      const event = pressCtrlEnter();
      expect(model.toggleAutocomplete).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("tab switcher shortcuts", () => {
    beforeEach(() => {
      vi.stubGlobal("HTMLElement", class {});
      for (const id of ["a", "b", "c"])
        app.actions.openTab({ id, name: id, definition: "{}" });
      app.actions.selectTab("a"); // stack, top first: a c b
    });
    afterEach(() => vi.unstubAllGlobals());

    function press(code: string, init: Partial<KeyboardEvent> = {}) {
      const event = {
        code,
        key: code,
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        target: null,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...init,
      };
      commands.actions.handleKeyDown(event as unknown as KeyboardEvent);
      return event;
    }
    const release = (key: string) =>
      commands.actions.handleKeyUp({ key } as KeyboardEvent);

    it("Ctrl+Tab cycles most recently used first, and releasing Ctrl picks", () => {
      press("Tab");
      expect(app.store.getState().tabSwitcher?.index).toBe(1);
      press("Tab");
      expect(app.store.getState().tabSwitcher?.index).toBe(2);
      press("Tab", { shiftKey: true });
      expect(app.store.getState().tabSwitcher?.index).toBe(1);
      release("Shift"); // not the held modifier
      expect(app.store.getState().tabSwitcher).not.toBeNull();
      release("Control");
      const s = app.store.getState();
      expect(s.tabSwitcher).toBeNull();
      expect(s.activeTabId).toBe("c");
    });

    it("Ctrl+Shift+Tab opens on the least recent tab", () => {
      press("Tab", { shiftKey: true });
      expect(app.store.getState().tabSwitcher?.index).toBe(2);
    });

    it("Escape closes it without switching", () => {
      press("Tab");
      const event = press("Escape", { ctrlKey: true });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(app.store.getState().tabSwitcher).toBeNull();
      expect(app.store.getState().activeTabId).toBe("a");
    });

    it("keeps other keys from reaching the page behind it", () => {
      press("Tab");
      const event = press("KeyA");
      expect(event.preventDefault).toHaveBeenCalled();
      expect(app.store.getState().tabSwitcher).not.toBeNull();
    });

    it("Ctrl+PageDown-style tab order commands cycle in the tab bar's order", () => {
      commands.actions.run("tabs.next");
      expect(app.store.getState().activeTabId).toBe("b");
      commands.actions.run("tabs.previous");
      commands.actions.run("tabs.previous");
      expect(app.store.getState().activeTabId).toBe("c");
    });
  });

  describe("transport and selection shortcuts", () => {
    beforeEach(() => vi.stubGlobal("HTMLElement", class {}));
    afterEach(() => vi.unstubAllGlobals());

    /** Presses a plain key at the page, as the global keydown pass sees it. */
    function press(code: string, init: Partial<KeyboardEvent> = {}) {
      const event = {
        code,
        key: code,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...init,
      };
      commands.actions.handleKeyDown(event as unknown as KeyboardEvent);
      return event;
    }

    it("seek, skip and toggle play while a track is loaded", () => {
      const seekBy = vi.spyOn(app.actions, "seekBy");
      const skipPrevious = vi.spyOn(app.actions, "skipPrevious");
      const skipNext = vi.spyOn(app.actions, "skipNext");
      const toggle = vi.spyOn(app.actions, "togglePlayPause");

      press("ArrowLeft");
      press("PageUp");
      expect(seekBy).not.toHaveBeenCalled(); // nothing loaded yet
      expect(skipPrevious).not.toHaveBeenCalled();

      app.actions.seedNowPlaying(
        {
          id: "t1",
          title: "T",
          artists: [],
          sourceTabId: null,
          rowIndex: null,
        },
        { playing: true, position: 0, duration: 100, hasNext: true },
      );
      press("ArrowLeft");
      press("ArrowRight");
      press("PageUp");
      press("PageDown");
      press("Space");
      expect(seekBy.mock.calls).toEqual([[-10], [10]]);
      expect(skipPrevious).toHaveBeenCalledTimes(1);
      expect(skipNext).toHaveBeenCalledTimes(1);
      expect(toggle).toHaveBeenCalledTimes(1);
    });

    it("selects all rows with Ctrl+A, but not inside a text field", () => {
      app.actions.openTab({ id: "t", name: "t", definition: "{}" });
      app.actions.selectTab("t");
      const selectAll = vi.spyOn(app.actions, "selectAllRows");
      app.actions.setResults("t", buildResultFromStringRows([["1"], ["2"]]));

      press("KeyA", { key: "a", ctrlKey: true });
      expect(selectAll).toHaveBeenCalledWith("t");
      expect(app.store.getState().pages["t"]?.selection?.rows).toEqual(
        new Set([0, 1]),
      );
    });
  });

  describe("Delete", () => {
    const PLAYLIST_TAB = "00000000-0000-0000-0000-0000000000c1";

    /** Presses `Delete` at the page, as the global keydown pass sees it. */
    function pressDelete() {
      const event = {
        code: "Delete",
        key: "Delete",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      commands.actions.handleKeyDown(event as unknown as KeyboardEvent);
      return event;
    }

    beforeEach(() => {
      // The pass asks whether the key landed in a text field; there's no DOM.
      vi.stubGlobal("HTMLElement", class {});
      app.actions.openTab({
        id: PLAYLIST_TAB,
        name: "Road trip",
        definition: "{}",
        kind: "playlist",
        playlistId: "00000000-0000-0000-0000-0000000000d1",
      });
      app.actions.selectTab(PLAYLIST_TAB);
      app.actions.setResults(
        PLAYLIST_TAB,
        buildResultFromStringRows([
          ["e1", "1"],
          ["e2", "2"],
        ]),
      );
      app.actions.clickRow(PLAYLIST_TAB, 1, { shift: false, ctrl: false });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("removes the selected tracks on a playlist's results", () => {
      const removeRows = vi
        .spyOn(app.actions, "removeRows")
        .mockImplementation(() => {});
      const event = pressDelete();
      expect(removeRows).toHaveBeenCalledWith(PLAYLIST_TAB, new Set([1]));
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("belongs to the record form while it has focus", () => {
      const removeRows = vi
        .spyOn(app.actions, "removeRows")
        .mockImplementation(() => {});
      const model = mountFocusedForm(forms, PLAYLIST_TAB);
      pressDelete();
      expect(model.deleteSelection).toHaveBeenCalledTimes(1);
      expect(removeRows).not.toHaveBeenCalled();
    });

    it("does nothing on a query's results", () => {
      app.actions.openTab({ id: "q", name: "q", definition: "{}" });
      app.actions.selectTab("q");
      app.actions.setResults("q", buildResultFromStringRows([["1"]]));
      const removeRows = vi
        .spyOn(app.actions, "removeRows")
        .mockImplementation(() => {});
      const event = pressDelete();
      expect(removeRows).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe("rebinding", () => {
    it("steals a chord only from commands whose contexts can overlap", () => {
      const del = parseChord("Delete")!;
      // Both keep Delete: they never compete for it.
      commands.actions.setBinding("selection.delete", del);
      expect(
        selectBinding(
          commands.store.getState(),
          "playlist.remove_selected_tracks",
        ),
      ).toEqual(del);
      // A results command competes with both, so it takes Delete from each.
      commands.actions.setBinding("results.edit_selected", del);
      const s = commands.store.getState();
      expect(selectBinding(s, "results.edit_selected")).toEqual(del);
      expect(selectBinding(s, "selection.delete")).toBeNull();
      expect(selectBinding(s, "playlist.remove_selected_tracks")).toBeNull();
    });
  });

  describe("the palette", () => {
    it("excludes palette.open from the MRU, but records everything else", () => {
      commands.actions.run("explorer.toggle");
      commands.actions.run("palette.open");
      commands.actions.run("playback.toggle_play");
      expect(commands.store.getState().mru).toEqual([
        "playback.toggle_play",
        "explorer.toggle",
      ]);
    });

    it("clamps the highlight to the current list and wraps when moved", () => {
      // With no active tab, only the five "always" commands are available
      // (everything else needs `trackLoaded`/`queryTab`/`results`/
      // `recordForm`/`activeTab`) — a small, fixed-order, deterministic list
      // to clamp and wrap around.
      commands.store.setState({ paletteIndex: 10 }); // out of range
      commands.actions.movePaletteIndex(0); // clamps first, then moves by 0
      expect(commands.store.getState().paletteIndex).toBe(4);

      commands.actions.movePaletteIndex(1); // wraps past the end
      expect(commands.store.getState().paletteIndex).toBe(0);

      commands.actions.movePaletteIndex(-1); // wraps past the start
      expect(commands.store.getState().paletteIndex).toBe(4);
    });

    it("resets the index to 0 whenever the query changes", () => {
      commands.actions.setPaletteIndex(3);
      commands.actions.setPaletteQuery("tabs");
      expect(commands.store.getState().paletteIndex).toBe(0);
    });
  });
});
