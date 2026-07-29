import * as arrow from "apache-arrow";
import { createEffect } from "solid-js";
import type { CommandStore } from "../state/commands";
import type { AppStore } from "../state/store";
import { defaultColumnMetadata } from "../query/columns";
import {
  emptyDefinition,
  type QueryDefinition,
  type Section,
} from "../query/definition";
import { buildResultFromCells } from "../query/result";
import { lemonadeGridResult, ROW_COUNT } from "./gridFixture";
import { FIXTURE_SCHEMA_JSON, installRecordFixture } from "./recordFixture";

// Prod-safe seeding seam. Reads URL params on startup and applies them to the
// store, so Playwright (and manual dev) can reach a deterministic UI state
// without a backend write path for session state (open tabs live only here).
//
//   ?sidebar=open&tabs=Lemonade,Deep%20Cuts
//   ?shortcuts=1     ← also open the keyboard-shortcuts editor tab, active
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
//   ?full=1          ← open the whole-query Querydown editor (full-mode `def`s)
//   ?expand=<id>     ← expand a preset's inline editor
//   ?editName=base   ← rename the expanded preset (makes it dirty)
//   ?editDefault=1   ← toggle the expanded preset's "Apply by default" (dirty)
//   ?tracks=id1,id2  ← per-row track ids for the seeded grid, so double-click
//                      plays without the lineage analysis having run
//   ?records=track,album
//                    ← tables whose (single-column `id`) primary key the seeded
//                      rows carry, standing in for the lineage analysis so a
//                      right-click offers "Edit track" / "Edit album"
//   ?recordFixture=1 ← install the canned schema + record data (see
//                      `recordFixture.ts`), so the record editor's form renders
//                      without a backend; `&recordDelay=<ms>` slows every answer
//                      so its loading states can be seen
//   ?playing=Title|Artist%20A,Artist%20B
//                    ← fill the now-playing bar with a frozen transport (no
//                      audio element, no stream request)
//
// A no-op when the params are absent, so it never affects production.
export function applySeed(store: AppStore): void {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }

  // Expose the store to the page (test-only, gated on a param) so a Playwright
  // test can drive a second `setResults` and assert the canvas repaints on a
  // result *replace* — the reload path — without a resize forcing the draw.
  // `__emptyResult` rides along: `QueryResult` is a class (private fields), so
  // a test driving `setResults` from `page.evaluate` needs a real instance
  // rather than a bare object literal — this hands it one.
  if (params.get("expose") === "1") {
    const w = window as unknown as {
      __appStore: AppStore;
      __emptyResult: typeof emptyCountResult;
    };
    w.__appStore = store;
    w.__emptyResult = emptyCountResult;
  }

  // The record editor's stand-in backend, installed before anything opens a tab
  // so the form finds a schema the moment it's asked for one.
  if (params.get("recordFixture") !== null) {
    store.setSchemaJson(FIXTURE_SCHEMA_JSON);
    installRecordFixture(Number(params.get("recordDelay") ?? 0) || 0);
  }

  const sidebar = params.get("sidebar");
  if (sidebar === "open") store.setSidebarOpen(true);
  else if (sidebar === "closed") store.setSidebarOpen(false);

  // The keyboard-shortcuts editor is a tab like any other, so it's opened last —
  // after the seeded query tabs below have picked their active one — leaving the
  // editor showing. With no query tabs to wait for, it can open right away.
  const shortcuts = params.get("shortcuts") === "1";

  const tabsParam = params.get("tabs");
  const names =
    tabsParam
      ?.split(",")
      .map((n) => n.trim())
      .filter(Boolean) ?? [];
  if (names.length === 0) {
    if (shortcuts) store.openShortcutsTab();
    return;
  }

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
    // `tracks=` stands in for the WASM lineage analysis, so the seeded rows are
    // playable (double-click) without compiling a real query — the ids become a
    // hidden column of the seeded table, same as a real lineage-mapped column.
    if (grid === "lemonade") {
      const { result, lineage } = lemonadeGridResult({
        trackIds: params.get("tracks")?.split(","),
        recordKeys: recordKeys(params.get("records")),
      });
      store.setResults(activeId, result, lineage);
    }

    // Override the active tab's working definition (unsaved unless `clean=1`).
    if (defParam) {
      const def = JSON.parse(defParam) as QueryDefinition;
      const saved = params.get("clean") === "1" ? def : emptyDefinition();
      store.setTabDefinitions(activeId, saved, def);
    }
    const count = params.get("count");
    if (count) store.setResults(activeId, emptyCountResult(Number(count)));
    // Open a builder section before expanding a preset (toggling a section
    // clears the expansion).
    if (section) store.toggleBuilderSection(activeId, section);
    if (params.get("full") === "1") store.toggleFullEditor(activeId);
    // Fill the now-playing bar without an audio element or a backend: the
    // title/artists come straight from the param, the transport is frozen.
    //
    // The track is deliberately left unlocated in the seeded rows (`rowIndex:
    // null`, so the bar's "Locate" reads disabled): the playing row's marker is
    // canvas paint, and Playwright's screenshot capture reproduces it in dark
    // mode but not light — even though the canvas itself carries it in both (a
    // `page.screenshot` of the same page shows it). Rather than bake that
    // asymmetry into a pair of baselines, these snapshots stay about the bar and
    // the marker is asserted against canvas pixels in playback.spec.ts.
    const playing = params.get("playing");
    if (playing) {
      const [title, artistList] = playing.split("|");
      store.seedNowPlaying(
        {
          sourceTabId: activeId,
          id: "seeded-track",
          rowIndex: null,
          title,
          artists: artistList ? artistList.split(",") : [],
        },
        { playing: true, position: 74, duration: 255, hasNext: true },
      );
    }
    if (expand) {
      store.toggleExpandPreset(activeId, expand);
      const editName = params.get("editName");
      if (editName) store.patchPresetEdit(expand, { name: editName });
      if (params.get("editDefault") === "1")
        store.patchPresetEdit(expand, { isDefault: true });
    }
    if (shortcuts) store.openShortcutsTab();
  });
}

// The command-system half of the seed seam (the params the app store knows
// nothing about), applied on startup like `applySeed`:
//
//   ?palette=1        ← open the command palette
//   ?palette=<text>   ← …with `<text>` already typed into its search field
//
// A no-op when the params are absent, so it never affects production.
export function applyCommandSeed(commands: CommandStore): void {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }

  const palette = params.get("palette");
  if (palette) {
    commands.togglePalette();
    if (palette !== "1") commands.setPaletteQuery(palette);
  }
}

/** Builds the per-row identity `?records=` asks for: one named table's worth of
 * `<table>-<row>` values, fed to `lemonadeGridResult` as an extra hidden
 * column. Stands in for the lineage analysis, which needs a real compile and
 * the introspected schema. */
function recordKeys(
  param: string | null,
): Record<string, readonly string[]> | undefined {
  const tables = param
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tables || tables.length === 0) return undefined;
  const keys: Record<string, readonly string[]> = {};
  for (const table of tables) {
    keys[table] = Array.from(
      { length: ROW_COUNT },
      (_, r) => `${table}-${r + 1}`,
    );
  }
  return keys;
}

/** An empty result of `rowCount` rows and no visible columns — `?count=`'s
 * stand-in for "N results" without a real compile. A real `Table` (one hidden
 * `Null`-typed column, so `numRows` is honest) rather than a bare object
 * literal: `QueryResult` is a class with private fields, so nothing but a real
 * instance satisfies its type. */
function emptyCountResult(rowCount: number) {
  const table = new arrow.Table({
    seed_count: arrow.vectorFromArray(new Array<null>(rowCount).fill(null)),
  });
  return buildResultFromCells(table, [
    { ...defaultColumnMetadata(), hide: true },
  ]);
}
