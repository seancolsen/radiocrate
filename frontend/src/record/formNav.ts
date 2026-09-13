// Moving focus around the form, in DOM terms.
//
// The form's items — field labels, and the embedded records of a multi-record
// field — are focusable elements marked with `data-form-item` and carrying their
// item id. Their document order *is* the order the user reads them in: a field
// label, then whatever it expands into, then the next field label. So "the item
// below this one" is a query and an index, not a walk of the model's tree, and it
// automatically only ever lands on items that are actually on screen.

/** Every focusable item of `root`, in document (visual) order. */
export function itemElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-form-item]")];
}

/** The element of one item, if it's currently rendered. Matched on the dataset
 * rather than a selector, since item ids carry `:`, `#` and `[]`. */
export function itemElement(
  root: HTMLElement,
  itemId: string,
): HTMLElement | undefined {
  return itemElements(root).find((el) => el.dataset.itemId === itemId);
}

/** Focuses one item. Returns whether it was there to focus. */
export function focusItem(root: HTMLElement, itemId: string): boolean {
  const el = itemElement(root, itemId);
  el?.focus();
  return el !== undefined;
}

/** Focuses the item below (`forward`) or above the focused one, stopping at
 * either end. With nothing in the form focused, focuses the first or last item.
 * Returns whether focus moved. */
export function focusAdjacentItem(
  root: HTMLElement,
  forward: boolean,
): boolean {
  const items = itemElements(root);
  if (items.length === 0) return false;
  const active = document.activeElement;
  const current =
    active instanceof HTMLElement
      ? items.indexOf(active.closest<HTMLElement>("[data-form-item]") ?? active)
      : -1;
  const target =
    current === -1
      ? forward
        ? 0
        : items.length - 1
      : forward
        ? Math.min(current + 1, items.length - 1)
        : Math.max(current - 1, 0);
  if (target === current) return false;
  items[target].focus();
  return true;
}
