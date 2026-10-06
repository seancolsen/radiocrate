import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChord } from "../commands/chord";
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
      // With no active tab, only the four "always" commands are available
      // (everything else needs `trackLoaded`/`queryTab`/`results`/
      // `recordForm`/`activeTab`) — a small, fixed-order, deterministic list
      // to clamp and wrap around.
      commands.store.setState({ paletteIndex: 10 }); // out of range
      commands.actions.movePaletteIndex(0); // clamps first, then moves by 0
      expect(commands.store.getState().paletteIndex).toBe(3);

      commands.actions.movePaletteIndex(1); // wraps past the end
      expect(commands.store.getState().paletteIndex).toBe(0);

      commands.actions.movePaletteIndex(-1); // wraps past the start
      expect(commands.store.getState().paletteIndex).toBe(3);
    });

    it("resets the index to 0 whenever the query changes", () => {
      commands.actions.setPaletteIndex(3);
      commands.actions.setPaletteQuery("tabs");
      expect(commands.store.getState().paletteIndex).toBe(0);
    });
  });
});
