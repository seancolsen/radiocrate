// Which gesture owns a pointer, when two are listening to it. The explorer's
// drag-to-rearrange and the panel's resize handle both start from inside the
// mobile drawer, whose swipe-to-close tracks every touch that goes down in it:
// once one of them claims its pointer, the swipe stands down, so moving sideways
// to pick a nesting depth or a width doesn't also slide the drawer shut.

const claimed = new Set<number>();

/** Marks `pointerId` as owned by the caller's gesture until released. */
export function claimPointer(pointerId: number): void {
  claimed.add(pointerId);
}

export function releasePointer(pointerId: number): void {
  claimed.delete(pointerId);
}

/** Whether another gesture has claimed `pointerId`. */
export function isPointerClaimed(pointerId: number): boolean {
  return claimed.has(pointerId);
}
