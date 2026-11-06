// The decisions a swipe-to-close makes, apart from the events that feed them:
// whether a touch is a swipe at all, how fast it was going when it let go, and
// whether that closes the panel. `useSwipeToClose` is the event side.

/** How far (px) a touch travels before it's judged a horizontal swipe or a
 * vertical scroll. Small, so a swipe answers the finger almost at once; a
 * browser that sits on a touch's first few px anyway may reach this on its very
 * first move. */
const AXIS_LOCK_DISTANCE = 6;
/** The release speed (px/s) that decides the outcome on its own, whichever way
 * it's going and however far the panel has come. */
const FLICK_VELOCITY = 300;
/** How much of the panel's width a slow drag has to cover to close it. */
const CLOSE_FRACTION = 0.4;
/** How far back (ms) a release looks to judge its speed: long enough to smooth
 * over the jitter between any two moves, short enough that a finger which
 * stopped before lifting counts as stopped. */
const VELOCITY_WINDOW_MS = 100;

/** A touch's position at a moment: `x` in px, `t` in ms. */
export interface SwipeSample {
  x: number;
  t: number;
}

/** Which way a touch that has moved (`dx`, `dy`) from where it started is
 * heading, or `null` while it's too soon to say. */
export function swipeAxis(
  dx: number,
  dy: number,
): "horizontal" | "vertical" | null {
  if (Math.hypot(dx, dy) < AXIS_LOCK_DISTANCE) return null;
  return Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
}

/** The speed (px/s, negative leftward) of a touch released at time `now`, from
 * its samples, oldest first. */
export function releaseVelocity(
  samples: readonly SwipeSample[],
  now: number,
): number {
  const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? ((last.x - first.x) / dt) * 1000 : 0;
}

/** Whether a panel `width` wide, released `offset` px from open (negative:
 * toward closed) at `velocity`, closes rather than springing back. A flick wins
 * outright in its own direction; without one, it's how far the panel has come. */
export function shouldClose(
  offset: number,
  width: number,
  velocity: number,
): boolean {
  if (velocity <= -FLICK_VELOCITY) return true;
  if (velocity >= FLICK_VELOCITY) return false;
  return -offset >= width * CLOSE_FRACTION;
}
