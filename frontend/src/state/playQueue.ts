// The play queue: the tracks the user has lined up to play next, by hand.
//
// It's an ordered list of tracks, each at most once, which the user adds to
// ("Queue track", Alt+click, a swipe right) and takes from ("Remove from
// queue"), and which playback takes from as each queued track comes up. What
// the store keeps for each entry beyond its track id (the row it was queued
// from) rides along untouched.
//
// Everything here is pure: each function returns a new list, never mutating
// its input, so the store can replace the queue wholesale on every change.

/** Where queued tracks go: ahead of everything already queued, or after it. */
export type QueuePlace = "next" | "last";

/** `queue` with `tracks` put at `place`, in their order. A track already
 * queued moves there rather than appearing twice, and a track given more than
 * once (several rows of one track) is queued once, where it first appears. */
export function enqueue<T extends { id: string }>(
  queue: readonly T[],
  tracks: readonly T[],
  place: QueuePlace,
): T[] {
  const adding = new Map<string, T>();
  for (const track of tracks) {
    if (!adding.has(track.id)) adding.set(track.id, track);
  }
  const rest = queue.filter((track) => !adding.has(track.id));
  return place === "next"
    ? [...adding.values(), ...rest]
    : [...rest, ...adding.values()];
}

/** `queue` without the tracks `ids` names. */
export function dequeue<T extends { id: string }>(
  queue: readonly T[],
  ids: Iterable<string>,
): T[] {
  const removing = new Set(ids);
  return queue.filter((track) => !removing.has(track.id));
}

/** Each queued track's place in `queue`, counting from 1. */
export function queuePositions(
  queue: readonly { id: string }[],
): Map<string, number> {
  return new Map(queue.map((track, i) => [track.id, i + 1]));
}
