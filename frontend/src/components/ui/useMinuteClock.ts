import { useSyncExternalStore } from "react";

// The time, in minutes: what a `relativeTime` cell in the DOM counts back from, so
// "3 minutes ago" keeps advancing on a still page, as the results grid's ticker
// keeps it advancing on the canvas. One timer however many cells are watching,
// and none while nothing is or the page is hidden.

const TICK_MS = 60_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function tick() {
  if (document.hidden) return;
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    // Nothing has kept the time since the last watcher left.
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearInterval(timer);
    timer = undefined;
    document.removeEventListener("visibilitychange", tick);
  };
}

const subscribeToNothing = () => () => {};
const getNow = () => now;

/** The current time, re-rendering each minute while `active`. */
export function useMinuteClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : subscribeToNothing, getNow);
}
