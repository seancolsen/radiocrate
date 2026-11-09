// What a touch on the results can do besides scroll them, apart from the events
// that feed it: pull down past the top to refresh, and swipe a row left or
// right to act on it. The results grid (`canvasGrid.ts`) feeds the numbers in
// and paints what comes out, so the decisions are plain code a unit test can
// drive. Which way a touch is heading, and how fast it let go, are
// `gestures/swipe.ts`'s.

import { FLICK_VELOCITY } from "../gestures/swipe";

/** How far the rows come per px of finger travel: they lag behind it, so a pull
 * reads as stretching something rather than as a scroll. */
const PULL_RESISTANCE = 0.5;
/** The furthest (px) the rows can be pulled. */
const PULL_MAX = 96;
/** How far (px) the rows have to be pulled for letting go to refresh them. */
export const PULL_TRIGGER = 64;
/** Where (px) the rows wait for a refresh under way. Short of the trigger, so
 * that a touch on them while they wait and let go isn't another pull. */
export const PULL_HOLD = 44;

/** How far a row travels (px) before letting go of it, slowly, commits. */
export const ROW_SWIPE_DISTANCE = 96;

/** How quickly a row or a pull goes home once let go (ms, a time constant). */
const SETTLE_TAU = 60;
/** Close enough to home (px) to call it there. */
const SETTLE_EPSILON = 0.5;

/** How far (px) `finger` px of travel past the top pulls the rows. */
export function pullDistance(finger: number): number {
  return Math.min(PULL_MAX, Math.max(0, finger) * PULL_RESISTANCE);
}

/** The finger travel that pulls the rows `pull` px: {@link pullDistance}
 * backward, so a finger taking over rows already pulled doesn't move them. */
export function fingerForPull(pull: number): number {
  return pull / PULL_RESISTANCE;
}

/** Whether a row swiped in `direction` (`-1` leftward, `1` rightward) and
 * released `offset` px from home (negative: leftward) at `velocity` commits,
 * rather than springing back. A flick wins outright in its own direction;
 * without one, it's how far the row has come. */
export function rowSwipeCommits(
  offset: number,
  velocity: number,
  direction: -1 | 1,
): boolean {
  if (velocity * direction >= FLICK_VELOCITY) return true;
  if (velocity * direction <= -FLICK_VELOCITY) return false;
  return offset * direction >= ROW_SWIPE_DISTANCE;
}

/** `value` after `dt` ms more of settling toward `target`, frame-rate
 * independent, arriving exactly once it's close. */
export function settle(value: number, target: number, dt: number): number {
  const next = target + (value - target) * Math.exp(-dt / SETTLE_TAU);
  return Math.abs(next - target) < SETTLE_EPSILON ? target : next;
}
