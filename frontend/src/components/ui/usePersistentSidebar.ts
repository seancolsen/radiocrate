import { useSyncExternalStore } from "react";

/** Viewport width at/above which a sidebar can sit beside the main content;
 * narrower, it's a modal drawer over it (PERSISTENT_ORGANIZER_MIN_WIDTH). */
const PERSISTENT_MIN_WIDTH = 500;
const QUERY = `(min-width: ${PERSISTENT_MIN_WIDTH}px)`;

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Whether the viewport is wide enough for a persistent sidebar — the one thing
 * that decides the explorer's layout, and what's worth showing inside it. */
export function usePersistentSidebar(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
  );
}
