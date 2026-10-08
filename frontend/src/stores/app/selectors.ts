import type { Preset } from "api-client";
import { settingValue, type SettingKey } from "../../state/settings";
import { defsEqual, type Section } from "../../query/definition";
import {
  pageDefsEqual,
  PLAYLIST_BASE,
  type Sections,
} from "../../query/playlist";
import { resultToCsv } from "../../query/exportCsv";
import { rowEntry } from "../../query/playlistEntries";
import { canRedo, canUndo, hasUnrunEdit } from "../../state/undoHistory";
import type { LineageMapping } from "../../query/lineage";
import type { QueryResult } from "../../query/result";
import type { RowContext } from "../../query/rowDml";
import {
  EMPTY_SELECTION,
  type AppState,
  type PageTab,
  type PresetEdit,
  type QueryTab,
  type Rating,
  type RecordEditorTarget,
  type RecordRef,
  type Tab,
} from "./state";

// Pure functions of `AppState` (plus whatever extra arguments they need) — the
// read half of what today's `AppStore` interface mixes with writes (state
// management rule 1). None of these mutate or call the backend; `actions.ts`
// is where every write lives, and reuses several of these internally.
//
// Rule 2: a selector returns a primitive, a reference already in state, or a
// shared constant. One that builds a fresh array or object (`selectPresetsFor`,
// `selectRowRecords`, …) is documented as such below — wrap it in `useShallow`
// or a component-level `useMemo` rather than subscribing to it directly.

export const selectTab = (s: AppState, tabId: string): Tab | undefined =>
  s.tabs.find((t) => t.id === tabId);

/** The tab with `id` when it's a *query* tab — the narrowing every consumer of
 * a query's definitions goes through, so a non-query tab reads as absent
 * rather than as an empty query. */
export const selectQueryTab = (
  s: AppState,
  tabId: string,
): QueryTab | undefined => {
  const t = selectTab(s, tabId);
  return t?.kind === "query" ? t : undefined;
};

/** The tab with `id` when it holds a results page — a query's or a
 * playlist's: what runs, the builders, the results, undo and the record editor
 * all go through. A shortcuts tab reads as absent. */
export const selectPageTab = (
  s: AppState,
  tabId: string,
): PageTab | undefined => {
  const t = selectTab(s, tabId);
  return t?.kind === "query" || t?.kind === "playlist" ? t : undefined;
};

/** The sections a page tab's builders edit — its working definition, as the
 * builders see it. */
export const selectPageSections = (
  s: AppState,
  tabId: string,
): Sections | undefined => selectPageTab(s, tabId)?.live;

/** The table a page tab's sections are written against: a query's base, or
 * `track` for a playlist (its sections are scoped to each entry's track).
 * Empty for a query with no base chosen, and for a tab that isn't a page. */
export const selectPageBase = (s: AppState, tabId: string): string => {
  const t = selectPageTab(s, tabId);
  if (!t) return "";
  return t.kind === "playlist" ? PLAYLIST_BASE : t.live.base.trim();
};

/** Whether a tab has changes the backend doesn't: an unsaved query always, and
 * a saved one whose last save failed. What shows the Save button and the ✱. A
 * saved query's edits waiting to be written lazily don't count — they're on
 * their way. Never true for a non-query tab — the shortcuts editor writes its
 * bindings through immediately. */
export const selectIsUnsaved = (s: AppState, tabId: string): boolean => {
  const t = selectQueryTab(s, tabId);
  return t ? !t.persisted || t.saveFailed : false;
};

/** Whether `tabId` is a saved source — one with a name to rename: a saved
 * query, or any playlist (which is saved from the moment it exists). */
export const selectIsPersisted = (s: AppState, tabId: string): boolean => {
  const t = selectPageTab(s, tabId);
  return t?.kind === "playlist" || (t?.persisted ?? false);
};

/** Whether "Revert changes" applies: a saved query whose working definition
 * couldn't be saved, and so differs from what the backend holds. (An unsaved
 * query has nothing to revert to.) */
export const selectCanRevert = (s: AppState, tabId: string): boolean => {
  const t = selectQueryTab(s, tabId);
  return t ? t.persisted && t.saveFailed && !defsEqual(t.saved, t.live) : false;
};

/** Whether `tabId`'s Undo applies: there's a step to unapply, or an edit made
 * since the last run (a debounced one, still waiting) to step back out of.
 * While a write is in flight ({@link selectIsWriting}) it still applies, but
 * has to wait. */
export const selectCanUndo = (s: AppState, tabId: string): boolean => {
  const t = selectPageTab(s, tabId);
  const undo = s.pages[tabId]?.undo;
  return t && undo ? canUndo(undo, t.live, pageDefsEqual) : false;
};

/** Whether `tabId`'s Redo applies: something has been undone, and nothing
 * edited since. Waits on a write in flight, as Undo does. */
export const selectCanRedo = (s: AppState, tabId: string): boolean => {
  const t = selectPageTab(s, tabId);
  const undo = s.pages[tabId]?.undo;
  return t && undo ? canRedo(undo, t.live, pageDefsEqual) : false;
};

/** Whether a write to `tabId`'s playlist entries is in flight or waiting. */
export const selectIsWriting = (s: AppState, tabId: string): boolean =>
  s.pages[tabId]?.writing ?? false;

export const selectResultCount = (
  s: AppState,
  tabId: string,
): number | undefined => s.pages[tabId]?.result?.rowCount;

export const selectRowSelection = (
  s: AppState,
  tabId: string,
): ReadonlySet<number> => s.pages[tabId]?.selection ?? EMPTY_SELECTION;

/** The rows and columns the open "Export results data" dialog would write out,
 * as tab-separated text — `undefined` while it's closed or its page has no
 * result yet. Builds a fresh string: for the actions, never subscribe to it. */
export const selectExportText = (s: AppState): string | undefined => {
  const pending = s.exportData;
  const result = pending && s.pages[pending.tabId]?.result;
  if (!pending || !result) return undefined;
  return resultToCsv(result, {
    rows:
      pending.rows === "selected"
        ? selectRowSelection(s, pending.tabId)
        : undefined,
    excluded: pending.excludedColumns,
    raw: pending.rawColumns,
  });
};

/** Whether the open export dialog has something to write out: its page has a
 * result, at least one column is left in, and — exporting the selected rows —
 * some are selected. */
export const selectCanExport = (s: AppState): boolean => {
  const pending = s.exportData;
  const result = pending && s.pages[pending.tabId]?.result;
  if (!pending || !result) return false;
  if (result.visible.every((c) => pending.excludedColumns.includes(c.index))) {
    return false;
  }
  return (
    pending.rows === "all" || selectRowSelection(s, pending.tabId).size > 0
  );
};

/** Whether a run of `tabId`'s query is in flight — what spins the toolbar's
 * Refresh icon. */
export const selectRunning = (s: AppState, tabId: string): boolean =>
  s.pages[tabId]?.running ?? false;

/** Whether "Query: Convert to playlist" applies to `tabId`: a query tab
 * whose rows are tracks (they carry a track id column — what makes them
 * playable), and whose last run neither is still going nor failed, so that the
 * rows on screen are its definition's. */
export const selectCanConvertToPlaylist = (
  s: AppState,
  tabId: string,
): boolean => {
  const page = s.pages[tabId];
  return (
    selectQueryTab(s, tabId) !== undefined &&
    page?.result !== undefined &&
    page.lineage?.trackIdColumn !== undefined &&
    !page.running &&
    !page.runFailed
  );
};

/** Whether page `tabId`'s filter applies any condition: custom text, or at
 * least one preset. On a playlist, what puts "Remove these tracks" and "Keep
 * only these tracks" under the filter builder. */
export const selectFilterApplied = (s: AppState, tabId: string): boolean => {
  const filter = selectPageSections(s, tabId)?.filter;
  return filter
    ? filter.custom.trim() !== "" || filter.presets.length > 0
    : false;
};

/** Whether page `tabId`'s sort applies any condition: anything but "Playlist
 * order" or an empty custom sort, both of which leave a playlist's entries in
 * their stored order. On a playlist, what puts "Commit this track order to
 * playlist" under the sort builder. */
export const selectSortApplied = (s: AppState, tabId: string): boolean => {
  const sort = selectPageSections(s, tabId)?.sort;
  if (!sort) return false;
  if ("custom" in sort) return sort.custom.trim() !== "";
  return !("builtin" in sort && sort.builtin.preset === "playlist_order");
};

/** Whether playlist page `tabId` can start a write worked out from the rows on
 * screen ("Remove these tracks", "Keep only these tracks", committing a sort):
 * its rows have landed, and they're its working definition's — its last run is
 * neither still going nor failed, and no edit is waiting on a debounced run —
 * and no write to its entries is in flight or waiting (which would reload the
 * rows under it). */
export const selectCanWriteFromRows = (s: AppState, tabId: string): boolean => {
  const t = selectPageTab(s, tabId);
  const page = s.pages[tabId];
  return (
    t?.kind === "playlist" &&
    page?.result !== undefined &&
    !page.running &&
    !page.runFailed &&
    !page.writing &&
    !hasUnrunEdit(page.undo, t.live, pageDefsEqual)
  );
};

/** Where rows being dragged would drop among page `tabId`'s own rows, for the
 * grid's drop line: `undefined` unless rows picked up on this page, a
 * playlist's, are in hand, and then the drag's `gap` (`null` for nowhere). */
export const selectRowDropGap = (
  s: AppState,
  tabId: string,
): number | null | undefined => {
  const drag = s.rowDrag;
  if (drag?.fromTabId !== tabId) return undefined;
  return selectPageTab(s, tabId)?.kind === "playlist" ? drag.gap : undefined;
};

/** Whether the result `tabId` is showing arrived as a refresh of the one before
 * it (see `QueryPageState.resultIsRefresh`) — read by the results grid as it's
 * handed the swap, to decide whether the scroll position survives it. */
export const selectResultIsRefresh = (s: AppState, tabId: string): boolean =>
  s.pages[tabId]?.resultIsRefresh ?? false;

/** Where `tabId`'s results were scrolled to when the tab was last left. */
export const selectResultsScroll = (s: AppState, tabId: string): number =>
  s.pages[tabId]?.scrollOffset ?? 0;

/** Whether `tabId`'s results pane is in multi-select mode (the floating
 * multi-select toolbar, and click-to-toggle rows). */
export const selectMultiSelect = (s: AppState, tabId: string): boolean =>
  s.pages[tabId]?.multiSelect ?? false;

/** The records result row `index` identifies — one per table whose primary key
 * the row carries in full, in result-column order. Empty when the lineage
 * analysis found none (or hasn't finished), which is what leaves the row's
 * context menu with nothing to offer. Builds a fresh array on every call. */
export function selectRowRecords(
  s: AppState,
  tabId: string,
  index: number,
): RecordRef[] {
  return rowRecords(s.pages[tabId]?.result, s.pages[tabId]?.lineage, index);
}

/** {@link selectRowRecords} over the pieces of page state it reads, for a
 * component that has selected those references out of the store and derives
 * from them in a `useMemo` (rule 2) rather than subscribing to a selector that
 * builds a fresh array. */
export function rowRecords(
  result: QueryResult | undefined,
  lineage: LineageMapping | undefined,
  index: number,
): RecordRef[] {
  const targets = lineage?.records ?? [];
  if (!result) return [];
  const records: RecordRef[] = [];
  for (const target of targets) {
    const values = target.keyIndices.map((i) => result.value(index, i));
    // A row that's NULL in any key column doesn't identify a record there —
    // an outer join with nothing on the far side, say.
    if (values.some((v) => v == null || v === "")) continue;
    records.push({
      table: target.table,
      key: target.keyColumns.map((column, i) => ({
        column,
        value: result.keyText(index, target.keyIndices[i]),
      })),
    });
  }
  return records;
}

/** What a menu raised on `rows` offers to edit: one record per table those
 * rows carry a primary key for, in first-row-first order (a track row joined
 * to its album offers both). Builds a fresh array on every call. */
export function recordsForRows(
  result: QueryResult | undefined,
  lineage: LineageMapping | undefined,
  rows: Iterable<number>,
): RecordRef[] {
  const byTable = new Map<string, RecordRef>();
  for (const row of rows) {
    for (const record of rowRecords(result, lineage, row)) {
      if (!byTable.has(record.table)) byTable.set(record.table, record);
    }
  }
  return [...byTable.values()];
}

/** {@link recordsForRows} against the whole state. Builds a fresh array on
 * every call. */
export function selectRecordsForRows(
  s: AppState,
  tabId: string,
  rows: Iterable<number>,
): RecordRef[] {
  return recordsForRows(s.pages[tabId]?.result, s.pages[tabId]?.lineage, rows);
}

/** Every record of `table` that `rows` identify, in row order — what opening
 * the editor on a (possibly multi-row) selection edits. Duplicates are left in;
 * `setRecordEditorRecords` takes each record once. Builds a fresh array on
 * every call. */
export function selectTableRecordsForRows(
  s: AppState,
  tabId: string,
  rows: Iterable<number>,
  table: string,
): RecordRef[] {
  const records: RecordRef[] = [];
  for (const row of rows) {
    for (const record of selectRowRecords(s, tabId, row)) {
      if (record.table === table) records.push(record);
    }
  }
  return records;
}

export const selectRecordEditor = (
  s: AppState,
  tabId: string,
): RecordEditorTarget | null => s.pages[tabId]?.recordEditor ?? null;

export const selectBuilderSection = (
  s: AppState,
  tabId: string,
): Section | null => s.pages[tabId]?.builderSection ?? null;

/** Whether a tab's working query is one hand-written Querydown query rather
 * than the four builder sections. Never true of a playlist. */
export const selectIsFullQuery = (s: AppState, tabId: string): boolean =>
  selectQueryTab(s, tabId)?.live.full != null;

export const selectFullEditorOpen = (s: AppState, tabId: string): boolean =>
  s.pages[tabId]?.fullEditorOpen ?? false;

export const selectExpandedPreset = (
  s: AppState,
  tabId: string,
): string | null => s.pages[tabId]?.expandedPreset ?? null;

export const selectPresetName = (s: AppState, id: string): string =>
  s.presets.find((p) => p.id === id)?.name ?? "(missing preset)";

/** Builds a fresh array on every call. */
export const selectPresetsFor = (
  s: AppState,
  baseTable: string,
  section: Section,
): Preset[] =>
  s.presets.filter((p) => p.section === section && p.baseTable === baseTable);

export const selectPresetDirty = (s: AppState, id: string): boolean => {
  const edit = s.presetEdits[id];
  if (!edit) return false;
  const saved = s.presets.find((p) => p.id === id);
  if (!saved) return true;
  return (
    saved.name !== edit.name ||
    saved.definition !== edit.definition ||
    saved.isDefault !== edit.isDefault
  );
};

export const selectPresetEdit = (
  s: AppState,
  id: string,
): PresetEdit | undefined => s.presetEdits[id];

/** The introspection schema having loaded (compiles can proceed): a dev/test
 * override (`setSchemaJson`) counts too, independently of `schema.status`. */
export const selectSchemaReady = (s: AppState): boolean =>
  s.schema.json !== undefined;

/** The rating vocabulary the "Rate track" submenu lists, in `value` order — a
 * reference already in state, safe to subscribe to directly. Empty until
 * `loadRatings` has landed (and after a load that failed). */
export const selectRatings = (s: AppState): readonly Rating[] => s.ratings.data;

/** Whether the rating vocabulary is still on its way — what the submenu shows a
 * note instead of rows for. */
export const selectRatingsLoading = (s: AppState): boolean =>
  s.ratings.status === "loading";

/** Whether presets have loaded (compiles can proceed without spuriously
 * throwing "this query references a preset that no longer exists"). */
export const selectPresetsReady = (s: AppState): boolean =>
  s.presetsStatus === "ready";

/** A setting's value in force: the user's customization, or its default. */
export const selectSettingValue = (s: AppState, key: SettingKey): string =>
  settingValue(s.settingOverrides, key);

/** The Querydown prepended to every compiled query, as the user has it. */
export const selectPrelude = (s: AppState): string =>
  selectSettingValue(s, "querydown_prelude");

/** The preset list to run/preview against: each saved preset overlaid with any
 * in-progress edit, so results reflect pending preset changes before they're
 * committed. Builds a fresh array on every call — internal to `actions.ts`'s
 * compile/run path, not meant for a component subscription. */
export function selectEffectivePresets(s: AppState): Preset[] {
  return s.presets.map((p) => {
    const edit = s.presetEdits[p.id];
    return edit
      ? {
          ...p,
          name: edit.name,
          definition: edit.definition,
          isDefault: edit.isDefault,
        }
      : p;
  });
}

/** Whether two references name the same database row. */
export function sameRecord(a: RecordRef, b: RecordRef): boolean {
  return (
    a.table === b.table &&
    a.key.length === b.key.length &&
    a.key.every(
      (part, i) =>
        part.column === b.key[i].column && part.value === b.key[i].value,
    )
  );
}

/** The playable track id at `index` of `tabId`'s results, if the rows are
 * tracks and that one carries an id. Read from the result on demand, not
 * cached — the value is as fresh as the row it comes from. */
export function selectTrackIdAt(
  s: AppState,
  tabId: string,
  index: number,
): string | undefined {
  const result = s.pages[tabId]?.result;
  const col = s.pages[tabId]?.lineage?.trackIdColumn;
  if (!result || col === undefined) return undefined;
  const id = result.keyText(index, col);
  return id === "" ? undefined : id;
}

/** Reads `tabId`'s results around row `index` into the play context the
 * engine navigates. `preceding` is every playable id before `index` (nearest
 * last, for "previous"); `upcoming` is the contiguous run of ids after it,
 * stopping at the first row without one. */
export function selectQueueAround(
  s: AppState,
  tabId: string,
  index: number,
): { preceding: string[]; upcoming: string[] } {
  const result = s.pages[tabId]?.result;
  const col = s.pages[tabId]?.lineage?.trackIdColumn;
  if (!result || col === undefined) return { preceding: [], upcoming: [] };
  const preceding: string[] = [];
  for (let i = 0; i < Math.min(index, result.rowCount); i++) {
    const id = selectTrackIdAt(s, tabId, i);
    if (id !== undefined) preceding.push(id);
  }
  const upcoming: string[] = [];
  for (let i = index + 1; i < result.rowCount; i++) {
    const id = selectTrackIdAt(s, tabId, i);
    if (id === undefined) break;
    upcoming.push(id);
  }
  return { preceding, upcoming };
}

/** Finds the row index of `id` within `tabId`'s current results, if present.
 * Capped so a huge result set can't stall a transition. */
export function selectLocateRow(
  s: AppState,
  tabId: string,
  id: string,
): number | null {
  const result = s.pages[tabId]?.result;
  const col = s.pages[tabId]?.lineage?.trackIdColumn;
  if (!result || col === undefined) return null;
  const limit = Math.min(result.rowCount, 1000);
  for (let i = 0; i < limit; i++)
    if (selectTrackIdAt(s, tabId, i) === id) return i;
  return null;
}

/** The result row of `tabId` that identifies `record`, preferring a selected
 * one: a record can occupy several rows (the same album across all of its
 * tracks), and the row the user has selected is the one they opened the editor
 * from. `undefined` when no row does — the results have moved on, or the
 * lineage analysis never found the record. Scanning is capped like
 * {@link selectLocateRow}, so a huge result set can't stall a save. */
export function selectRowForRecord(
  s: AppState,
  tabId: string,
  record: RecordRef,
): number | undefined {
  const identifies = (row: number) =>
    selectRowRecords(s, tabId, row).some((r) => sameRecord(r, record));
  for (const row of s.pages[tabId]?.selection ?? []) {
    if (identifies(row)) return row;
  }
  const limit = Math.min(s.pages[tabId]?.result?.rowCount ?? 0, 1000);
  for (let row = 0; row < limit; row++) if (identifies(row)) return row;
  return undefined;
}

/** What re-reading row `index` of `tabId` takes: the query as the user built
 * it, and what the row stands for (on a playlist page, the entry it lists too).
 * `undefined` — which runs the write with no refresh at all — when the tab
 * holds no page, the schema hasn't loaded, or the row identifies no record to
 * narrow the query to (no entry, on a playlist page). */
export function selectRowContext(
  s: AppState,
  tabId: string,
  index: number,
): RowContext | undefined {
  const t = selectPageTab(s, tabId);
  const schemaJson = s.schema.json;
  if (!t || schemaJson === undefined) return undefined;
  const records = selectRowRecords(s, tabId, index);
  if (records.length === 0) return undefined;
  const common = {
    presets: selectEffectivePresets(s),
    schemaJson,
    prelude: selectPrelude(s),
    records,
  };
  // The *working* definition: it's the one the displayed rows came from.
  if (t.kind === "query")
    return { ...common, kind: "query", definition: t.live };
  const result = s.pages[tabId]?.result;
  const entry = result && rowEntry(result, index);
  if (!entry) return undefined;
  return {
    ...common,
    kind: "playlist",
    playlistId: t.playlistId,
    definition: t.live,
    entryId: entry.id,
  };
}
