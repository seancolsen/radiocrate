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
 * mechanics (stage 7 supplies the real thing). Its "state" is nothing more
 * than the summary itself, so tests can drive it by calling `setSummary`. */
function stubModel(initial: RecordFormSummary) {
  const store = createStore<RecordFormSummary>()(() => initial);
  const dispose = vi.fn();
  const model: RecordFormModel = {
    store,
    getSummary: () => store.getState(),
    dispose,
    focusAdjacent: vi.fn(() => false),
    expandSelection: vi.fn(),
    deleteSelection: vi.fn(),
  };
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

  it("releaseUnmodified drops (and disposes) an unmodified form, but keeps a modified one", () => {
    const clean = stubModel(IDLE);
    const dirty = stubModel({ ...IDLE, modified: true });
    forms.actions.stashedForm("tab-a", ["clean"], () => clean.model);
    forms.actions.stashedForm("tab-a", ["dirty"], () => dirty.model);

    forms.actions.releaseUnmodified("tab-a", ["clean"]);
    forms.actions.releaseUnmodified("tab-a", ["dirty"]);

    expect(
      selectFormFor(forms.store.getState(), "tab-a", ["clean"]),
    ).toBeUndefined();
    expect(selectFormFor(forms.store.getState(), "tab-a", ["dirty"])).toBe(
      dirty.model,
    );
    expect(clean.dispose).toHaveBeenCalledTimes(1);
    expect(dirty.dispose).not.toHaveBeenCalled();
  });

  it("prune drops and disposes every form of a closed tab, keeping the rest", () => {
    const closed = stubModel({ ...IDLE, modified: true }); // even a modified form goes with its tab
    const kept = stubModel(IDLE);
    forms.actions.stashedForm("closed-tab", ["r1"], () => closed.model);
    forms.actions.stashedForm("open-tab", ["r2"], () => kept.model);

    forms.actions.prune(["open-tab"]);

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
