import { createEffect } from "solid-js";
import type { AppStore } from "../state/store";
import {
  emptyDefinition,
  type QueryDefinition,
  type Section,
} from "../query/definition";
import { lemonadeGridResult } from "./gridFixture";

// Prod-safe seeding seam. Reads URL params on startup and applies them to the
// store, so Playwright (and manual dev) can reach a deterministic UI state
// without a backend write path for session state (open tabs live only here).
//
//   ?sidebar=open&tabs=Lemonade,Deep%20Cuts
//   ?grid=lemonade   ← a small canned structured result for the active tab,
//                      bypassing Querydown / /api/query so the grid snapshot
//                      stays deterministic without a backend
//
// Toolbar/builder harness params (all optional), applied to the active tab:
//   ?def=<json>      ← the active tab's working definition (URL-encoded JSON);
//                      the saved baseline is left empty so the tab reads as
//                      unsaved, unless `clean=1` makes saved == working
//   ?clean=1         ← save the given `def` as the baseline too (no Save button)
//   ?count=12        ← seed an empty result of N rows ("12 results")
//   ?section=filter  ← open a builder section (filter|sort|display)
//   ?expand=<id>     ← expand a preset's inline editor
//   ?editName=base   ← rename the expanded preset (makes it dirty)
//   ?editDefault=1   ← toggle the expanded preset's "Apply by default" (dirty)
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

  const grid = params.get("grid");
  const defParam = params.get("def");
  const expand = params.get("expand");
  const section = params.get("section") as Section | null;
  // A preset editor seeds its buffer from the loaded preset on mount, so wait
  // for `preset.list` before expanding one; other params don't need it.
  const needPresets = expand != null;

  // Open tabs once the saved-query list resolves, mapping each seeded name to
  // its query (falling back to the name as a synthetic id if unmatched).
  let seeded = false;
  createEffect(() => {
    const queries = store.queries();
    const presetsLoaded = store.state.presets.length > 0;
    if (seeded || queries === undefined) return;
    if (needPresets && !presetsLoaded) return;
    seeded = true;
    for (const name of names) {
      const match = queries.find((q) => q.name === name);
      store.openTab(match ?? { id: name, name, definition: "" });
    }
    // Make the first seeded tab active (deterministic highlight).
    const first = names[0];
    const firstMatch = queries.find((q) => q.name === first);
    const activeId = firstMatch ? firstMatch.id : first;
    store.selectTab(activeId);
    // Drop a canned structured result straight into the active tab, bypassing
    // the compile / fetch / decode path so snapshots stay deterministic.
    if (grid === "lemonade") store.setResults(activeId, lemonadeGridResult());

    // Override the active tab's working definition (unsaved unless `clean=1`).
    if (defParam) {
      const def = JSON.parse(defParam) as QueryDefinition;
      const saved = params.get("clean") === "1" ? def : emptyDefinition();
      store.setTabDefinitions(activeId, saved, def);
    }
    const count = params.get("count");
    if (count)
      store.setResults(activeId, { rowCount: Number(count), columns: [] });
    // Open a builder section before expanding a preset (toggling a section
    // clears the expansion).
    if (section) store.toggleBuilderSection(activeId, section);
    if (expand) {
      store.toggleExpandPreset(activeId, expand);
      const editName = params.get("editName");
      if (editName) store.patchPresetEdit(expand, { name: editName });
      if (params.get("editDefault") === "1")
        store.patchPresetEdit(expand, { is_default: true });
    }
  });
}
