// A page's undo history, as a stack of steps that can each be applied and
// unapplied.
//
// A step changes the page's working definition (its filter, sort and display),
// writes to a playlist's entries, or both at once ("Remove these tracks"
// deletes entries and clears the filter as one step). The definition half is
// a transition, before and after. The writes half carries its own inverse
// (`EntryWrites`), so a removal's undo re-inserts the very records it deleted.
//
// The query page only ever has definition steps. They're recorded at
// *checkpoints* (every run of the query): whatever the working definition has
// become since the last checkpoint is one step. A step with writes is recorded
// by whoever made the writes, once they've landed.
//
// Everything here is pure: each function returns a new history (or the same
// one, when nothing changed), never mutating its input, so a store can replace
// a page's history wholesale on every change.

import type { EntryWrites } from "../query/playlistEntries";

/** A change of a page's working definition, from `before` to `after`. */
export interface DefinitionChange<D> {
  before: D;
  after: D;
}

/** One undoable change. At least one half is present. */
export interface UndoStep<D> {
  definition?: DefinitionChange<D>;
  /** Writes to a playlist's entries: `apply` redoes the step, `revert` undoes
   * it. */
  writes?: EntryWrites;
}

/** A page's undo history. Unbounded, and kept only as long as the page is:
 * closing the tab forgets it. */
export interface UndoHistory<D> {
  /** The working definition as of the last checkpoint or step, which is what
   * the next checkpoint compares against. `undefined` until the first
   * checkpoint, which records the definition the page started from rather than
   * a step. */
  current: D | undefined;
  steps: readonly UndoStep<D>[];
  /** How many of `steps` are applied: undo unapplies `steps[index - 1]`, and
   * redo reapplies `steps[index]`. */
  index: number;
}

/** Whether two definitions are the same. */
export type DefinitionEquals<D> = (a: D, b: D) => boolean;

/** A history with nothing in it — what a page starts with. Shared and never
 * written through. */
export const EMPTY_HISTORY: UndoHistory<never> = {
  current: undefined,
  steps: [],
  index: 0,
};

/** Whether `live` is the definition `history` stands on — by reference first,
 * which is the common case (the history holds the very objects the page
 * ran). */
function atCurrent<D>(
  history: UndoHistory<D>,
  live: D,
  equals: DefinitionEquals<D>,
): boolean {
  const { current } = history;
  return current !== undefined && (current === live || equals(current, live));
}

/** Records `live` as the working definition. If it differs from the last one
 * recorded, the difference becomes a step. */
export function checkpoint<D>(
  history: UndoHistory<D>,
  live: D,
  equals: DefinitionEquals<D>,
): UndoHistory<D> {
  if (history.current === undefined) return { ...history, current: live };
  if (atCurrent(history, live, equals)) return history;
  return pushStep(history, {
    definition: { before: history.current, after: live },
  });
}

/** Records `step` as just applied. Anything undone is dropped: the history
 * branches here. */
export function pushStep<D>(
  history: UndoHistory<D>,
  step: UndoStep<D>,
): UndoHistory<D> {
  return {
    current: step.definition?.after ?? history.current,
    steps: [...history.steps.slice(0, history.index), step],
    index: history.index + 1,
  };
}

/** The step that undo would unapply, if any. */
export function stepToUndo<D>(
  history: UndoHistory<D>,
): UndoStep<D> | undefined {
  return history.index > 0 ? history.steps[history.index - 1] : undefined;
}

/** The step that redo would reapply, if any. */
export function stepToRedo<D>(
  history: UndoHistory<D>,
): UndoStep<D> | undefined {
  return history.steps[history.index];
}

/** `history` with its last applied step unapplied. */
export function stepBack<D>(history: UndoHistory<D>): UndoHistory<D> {
  const step = stepToUndo(history);
  if (!step) return history;
  return {
    ...history,
    current: step.definition?.before ?? history.current,
    index: history.index - 1,
  };
}

/** `history` with its first undone step reapplied. */
export function stepForward<D>(history: UndoHistory<D>): UndoHistory<D> {
  const step = stepToRedo(history);
  if (!step) return history;
  return {
    ...history,
    current: step.definition?.after ?? history.current,
    index: history.index + 1,
  };
}

/** Whether undo applies to a page whose working definition is `live`: there's
 * a step to unapply, or an edit since the last checkpoint (one still waiting on
 * its debounced run) to step back out of. */
export function canUndo<D>(
  history: UndoHistory<D>,
  live: D,
  equals: DefinitionEquals<D>,
): boolean {
  if (history.current === undefined) return false;
  return history.index > 0 || !atCurrent(history, live, equals);
}

/** Whether redo applies to a page whose working definition is `live`:
 * something has been undone, and nothing edited since. */
export function canRedo<D>(
  history: UndoHistory<D>,
  live: D,
  equals: DefinitionEquals<D>,
): boolean {
  return stepToRedo(history) !== undefined && atCurrent(history, live, equals);
}
