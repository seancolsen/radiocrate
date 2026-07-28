// Which record editor form the keyboard is aimed at.
//
// The selection commands ("Selection: Select down", "Expand nested items",
// "Delete") are dispatched globally, but when the user is working inside a
// record editor they have to land there instead of on the result rows. A form
// registers itself here while it's mounted; `focusedForm` picks out the one the
// user is actually in — the one holding focus, or a selection — and the command
// store both gates and routes on that.
//
// More than one form can be mounted at a time (one per open tab), so this is a
// list rather than a single slot. It's reactive: `focusedForm` reads each form's
// own focus state, so the command context updates as focus moves.

import { createSignal } from "solid-js";
import type { RecordFormModel } from "./formModel";

/** A mounted record editor form. */
export interface FormHandle {
  model: RecordFormModel;
}

const [forms, setForms] = createSignal<readonly FormHandle[]>([]);

export function registerForm(handle: FormHandle): void {
  setForms((prev) => [...prev, handle]);
}

export function unregisterForm(handle: FormHandle): void {
  setForms((prev) => prev.filter((f) => f !== handle));
}

/** The form the user is working in, if any: the one with a focused item or a
 * non-empty selection. */
export function focusedForm(): FormHandle | undefined {
  return forms().find(
    (f) => f.model.focused() !== null || f.model.selection().length > 0,
  );
}

/** Whether any mounted form has its modal record picker open — a dialog that
 * owns the keyboard, so the global shortcut pass stands down for it as it does
 * for the app's other modals. */
export function recordPickerOpen(): boolean {
  return forms().some((f) => f.model.picker() !== null);
}
