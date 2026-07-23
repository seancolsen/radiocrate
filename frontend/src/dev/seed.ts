import { createEffect } from "solid-js";
import type { AppStore } from "../state/store";

// Prod-safe seeding seam. Reads URL params on startup and applies them to the
// store, so Playwright (and manual dev) can reach a deterministic UI state
// without a backend write path for session state (open tabs live only here).
//
//   ?sidebar=open&tabs=Lemonade,Deep%20Cuts
//
// A no-op when the params are absent, so it never affects production.
export function applySeed(store: AppStore): void {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }

  const sidebar = params.get("sidebar");
  if (sidebar === "open") store.setSidebarOpen(true);
  else if (sidebar === "closed") store.setSidebarOpen(false);

  const tabsParam = params.get("tabs");
  if (!tabsParam) return;
  const names = tabsParam
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return;

  // Open tabs once the saved-query list resolves, mapping each seeded name to
  // its query (falling back to the name as a synthetic id if unmatched).
  let seeded = false;
  createEffect(() => {
    const queries = store.queries();
    if (seeded || queries === undefined) return;
    seeded = true;
    for (const name of names) {
      const match = queries.find((q) => q.name === name);
      store.openTab(match ?? { id: name, name });
    }
    // Make the first seeded tab active (deterministic highlight).
    const first = names[0];
    const firstMatch = queries.find((q) => q.name === first);
    store.selectTab(firstMatch ? firstMatch.id : first);
  });
}
