import { createStore } from "zustand/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppStore, type AppStoreBundle } from "./app";
import { fakeEnv } from "./app/testEnv";
import { createCommandsStore, type CommandsStoreBundle } from "./commands";
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
 * commands to route to it. */
function mountFocusedForm(forms: FormsStoreBundle, tabId: string) {
  const summaryStore = createStore<RecordFormSummary>()(() => ({
    ...IDLE_SUMMARY,
    focused: true,
  }));
  const model: RecordFormModel = {
    store: summaryStore,
    getSummary: () => summaryStore.getState(),
    dispose: vi.fn(),
    focusAdjacent: vi.fn(() => true),
    expandSelection: vi.fn(),
    deleteSelection: vi.fn(),
  };
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
      app.actions.openTab({ id: "saved", name: "saved", definition: "{}" });
      app.actions.openTab({ id: "dirty", name: "dirty", definition: "{}" });
      app.actions.setFilterCustom("dirty", "artist:queen");

      const saveQuery = vi.spyOn(app.actions, "saveQuery");
      commands.actions.run("tabs.save_all");

      expect(saveQuery).toHaveBeenCalledTimes(1);
      expect(saveQuery).toHaveBeenCalledWith("dirty");
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
