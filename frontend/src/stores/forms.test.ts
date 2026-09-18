import { createStore } from "zustand/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFormsStore,
  selectFocusedForm,
  selectFormFor,
  selectModifiedRecords,
  selectRecordPickerOpen,
  type RecordFormModel,
  type RecordFormSummary,
} from "./forms";

/** A stub `RecordFormModel`: just enough to exercise the stash/registry
 * mechanics, which only ever touch `store` (to subscribe), `getSummary` and
 * `dispose` — hence the cast over the rest of the real model's surface
 * (`recordForm/model.test.ts` covers a real model in the stash). Its "state"
 * is nothing more than the summary itself, so tests can drive it by calling
 * `setSummary`. */
function stubModel(initial: RecordFormSummary) {
  const store = createStore<RecordFormSummary>()(() => initial);
  const dispose = vi.fn();
  const model = {
    store,
    getSummary: () => store.getState(),
    dispose,
    focusAdjacent: vi.fn(() => false),
    expandSelection: vi.fn(),
    deleteSelection: vi.fn(),
  } as unknown as RecordFormModel;
  return {
    model,
    dispose,
    setSummary: (next: RecordFormSummary) => store.setState(next),
  };
}

const IDLE: RecordFormSummary = {
  focused: false,
  selecting: false,
  pickerOpen: false,
  modified: false,
};

describe("forms store", () => {
  let forms: ReturnType<typeof createFormsStore>;

  beforeEach(() => {
    forms = createFormsStore();
  });

  it("stashedForm builds once and reuses the same model after", () => {
    const build = vi.fn(() => stubModel(IDLE).model);
    const first = forms.actions.stashedForm("tab-a", ["r1"], build);
    const second = forms.actions.stashedForm("tab-a", ["r1"], build);
    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
    expect(selectFormFor(forms.store.getState(), "tab-a", ["r1"])).toBe(first);
  });

  it("treats different record sets (or tabs) as different forms", () => {
    const { model: m1 } = stubModel(IDLE);
    const { model: m2 } = stubModel(IDLE);
    forms.actions.stashedForm("tab-a", ["r1"], () => m1);
    forms.actions.stashedForm("tab-a", ["r1", "r2"], () => m2);
    expect(selectFormFor(forms.store.getState(), "tab-a", ["r1"])).toBe(m1);
    expect(selectFormFor(forms.store.getState(), "tab-a", ["r1", "r2"])).toBe(
      m2,
    );
  });

  it("mirrors summary changes from the model's own store, comparing shallowly", () => {
    const { model, setSummary } = stubModel(IDLE);
    forms.actions.stashedForm("tab-a", ["r1"], () => model);
    forms.actions.mount("tab-a", ["r1"]);

    expect(selectFocusedForm(forms.store.getState())).toBeUndefined();

    setSummary({ ...IDLE, focused: true });
    expect(selectFocusedForm(forms.store.getState())).toBe(model);

    setSummary({ ...IDLE, pickerOpen: true });
    expect(selectRecordPickerOpen(forms.store.getState())).toBe(true);
  });

  it("focusedForm and recordPickerOpen ignore unmounted forms", () => {
    const { model, setSummary } = stubModel({ ...IDLE, focused: true });
    forms.actions.stashedForm("tab-a", ["r1"], () => model);
    // Never mounted.
    expect(selectFocusedForm(forms.store.getState())).toBeUndefined();

    forms.actions.mount("tab-a", ["r1"]);
    expect(selectFocusedForm(forms.store.getState())).toBe(model);

    forms.actions.unmount("tab-a", ["r1"]);
    expect(selectFocusedForm(forms.store.getState())).toBeUndefined();

    setSummary({ ...IDLE, pickerOpen: true });
    expect(selectRecordPickerOpen(forms.store.getState())).toBe(false);
  });

  it("modifiedRecords reads every identity of every modified form, mounted or not", () => {
    const { model } = stubModel({ ...IDLE, modified: true });
    forms.actions.stashedForm("tab-a", ["r1", "r2"], () => model);
    expect(selectModifiedRecords(forms.store.getState(), "tab-a")).toEqual([
      "r1",
      "r2",
    ]);
    expect(selectModifiedRecords(forms.store.getState(), "tab-b")).toEqual([]);
  });

  it("keeps a form nothing has reported on yet, whatever its mounts do", () => {
    const clean = stubModel(IDLE);
    forms.actions.stashedForm("tab-a", ["r1"], () => clean.model);
    forms.actions.mount("tab-a", ["r1"]);
    forms.actions.unmount("tab-a", ["r1"]);
    expect(selectFormFor(forms.store.getState(), "tab-a", ["r1"])).toBe(
      clean.model,
    );
    expect(clean.dispose).not.toHaveBeenCalled();
  });

  it("keeps the form its tab's editor is open on across unmounts (a tab switch)", () => {
    const clean = stubModel(IDLE);
    forms.actions.retain([{ tabId: "tab-a", target: ["r1"] }]);
    forms.actions.stashedForm("tab-a", ["r1"], () => clean.model);
    // StrictMode's mount → cleanup → mount, then the page hiding.
    forms.actions.mount("tab-a", ["r1"]);
    forms.actions.unmount("tab-a", ["r1"]);
    forms.actions.mount("tab-a", ["r1"]);
    forms.actions.unmount("tab-a", ["r1"]);

    expect(selectFormFor(forms.store.getState(), "tab-a", ["r1"])).toBe(
      clean.model,
    );
    expect(clean.dispose).not.toHaveBeenCalled();
  });

  it("drops an unmodified form once the editor moves off it or closes, but keeps a modified one", () => {
    const clean = stubModel(IDLE);
    const dirty = stubModel({ ...IDLE, modified: true });
    forms.actions.retain([{ tabId: "tab-a", target: ["clean"] }]);
    forms.actions.stashedForm("tab-a", ["clean"], () => clean.model);
    forms.actions.retain([{ tabId: "tab-a", target: ["dirty"] }]);
    forms.actions.stashedForm("tab-a", ["dirty"], () => dirty.model);

    expect(
      selectFormFor(forms.store.getState(), "tab-a", ["clean"]),
    ).toBeUndefined();
    expect(clean.dispose).toHaveBeenCalledTimes(1);

    forms.actions.retain([{ tabId: "tab-a", target: null }]);
    expect(selectFormFor(forms.store.getState(), "tab-a", ["dirty"])).toBe(
      dirty.model,
    );
    expect(dirty.dispose).not.toHaveBeenCalled();
  });

  it("waits for a still-mounted form to unmount before dropping it", () => {
    const clean = stubModel(IDLE);
    forms.actions.retain([{ tabId: "tab-a", target: ["r1"] }]);
    forms.actions.stashedForm("tab-a", ["r1"], () => clean.model);
    forms.actions.mount("tab-a", ["r1"]);

    // The editor moves on before the sidebar has re-rendered.
    forms.actions.retain([{ tabId: "tab-a", target: ["r2"] }]);
    expect(clean.dispose).not.toHaveBeenCalled();

    forms.actions.unmount("tab-a", ["r1"]);
    expect(
      selectFormFor(forms.store.getState(), "tab-a", ["r1"]),
    ).toBeUndefined();
    expect(clean.dispose).toHaveBeenCalledTimes(1);
  });

  it("drops a form left behind with changes once they're saved or reset", () => {
    const dirty = stubModel({ ...IDLE, modified: true });
    forms.actions.retain([{ tabId: "tab-a", target: ["r1"] }]);
    forms.actions.stashedForm("tab-a", ["r1"], () => dirty.model);
    forms.actions.retain([{ tabId: "tab-a", target: ["r2"] }]);
    expect(dirty.dispose).not.toHaveBeenCalled();

    dirty.setSummary(IDLE);
    expect(
      selectFormFor(forms.store.getState(), "tab-a", ["r1"]),
    ).toBeUndefined();
    expect(dirty.dispose).toHaveBeenCalledTimes(1);
  });

  it("drops and disposes every form of a closed tab, keeping the rest", () => {
    const closed = stubModel({ ...IDLE, modified: true }); // even a modified form goes with its tab
    const kept = stubModel(IDLE);
    forms.actions.retain([
      { tabId: "closed-tab", target: ["r1"] },
      { tabId: "open-tab", target: ["r2"] },
    ]);
    forms.actions.stashedForm("closed-tab", ["r1"], () => closed.model);
    forms.actions.stashedForm("open-tab", ["r2"], () => kept.model);

    forms.actions.retain([{ tabId: "open-tab", target: ["r2"] }]);

    expect(
      selectFormFor(forms.store.getState(), "closed-tab", ["r1"]),
    ).toBeUndefined();
    expect(selectFormFor(forms.store.getState(), "open-tab", ["r2"])).toBe(
      kept.model,
    );
    expect(closed.dispose).toHaveBeenCalledTimes(1);
    expect(kept.dispose).not.toHaveBeenCalled();
  });
});
