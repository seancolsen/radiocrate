import type { FieldRef, Preset, Source, SourceKind } from "api-client";
import { settingValue, type SettingKey } from "../../state/settings";
import {
  defsEqual,
  definitionFromStored,
  usesPreset,
  type Section,
  fullQueryBase,
} from "../../query/definition";
import {
  pageDefsEqual,
  PLAYLIST_BASE,
  playlistDefinitionFromStored,
  type Sections,
} from "../../query/playlist";
import { resultToCsv } from "../../query/exportCsv";
import {
  NO_TABLE_METADATA,
  fieldRefKey,
  type EmbedSection,
  type TableMetadata,
} from "../../query/fieldMetadata";
import type { ContextualQuery } from "../../query/contextualQuery";
import { rowEntry } from "../../query/playlistEntries";
import { canRedo, canUndo, hasUnrunEdit } from "../../state/undoHistory";
import { queuePositions } from "../../state/playQueue";
import type { LineageMapping } from "../../query/lineage";
import type { QueryDiagnostic } from "../../query/diagnostics";
import type { QueryResult } from "../../query/result";
import type { RowContext } from "../../query/rowDml";
import {
  EMPTY_SELECTION,
  type AppState,
  type PageTab,
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

/** The table `tabId`'s rows are drawn from: {@link selectPageBase}, or for a
 * full query, whose `base` field goes unused, the one its text names. */
export const selectResultBase = (s: AppState, tabId: string): string => {
  const full = selectQueryTab(s, tabId)?.live.full;
  return full != null ? fullQueryBase(full) : selectPageBase(s, tabId);
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

/** Whether `tabId` is a new query the user hasn't touched yet, whose rows
 * wait for them to (see `QueryTab.pristine`). */
export const selectIsPristine = (s: AppState, tabId: string): boolean =>
  selectQueryTab(s, tabId)?.pristine === true;

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
): ReadonlySet<number> => s.pages[tabId]?.selection?.rows ?? EMPTY_SELECTION;

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

/** The problem with `tabId`'s query that its error strip shows, if any. */
export const selectPageDiagnostic = (
  s: AppState,
  tabId: string,
): QueryDiagnostic | null => s.pages[tabId]?.diagnostic ?? null;

/** Which of `tabId`'s builder sections the problem it shows is in — the
 * section toggle that's marked — or `"full"` for a full query's text. `null`
 * when it shows none, or one that's in no section. */
export const selectDiagnosticSection = (
  s: AppState,
  tabId: string,
): Section | "full" | null => {
  const origin = selectPageDiagnostic(s, tabId)?.origin;
  if (origin?.kind === "custom" || origin?.kind === "preset") {
    return origin.section;
  }
  return origin?.kind === "full" ? "full" : null;
};

/** The problem `tabId` shows, if it's in its own text for `editor`: a
 * section's custom input, or (`"full"`) a full query's editor. */
export const selectEditorDiagnostic = (
  s: AppState,
  tabId: string,
  editor: Section | "full",
): QueryDiagnostic | null => {
  const diagnostic = selectPageDiagnostic(s, tabId);
  const origin = diagnostic?.origin;
  const inEditor =
    editor === "full"
      ? origin?.kind === "full"
      : origin?.kind === "custom" && origin.section === editor;
  return inEditor ? diagnostic : null;
};

/** Whether the problem `tabId` shows is in preset `presetId`. */
export const selectPresetHasDiagnostic = (
  s: AppState,
  tabId: string,
  presetId: string,
): boolean => {
  const origin = selectPageDiagnostic(s, tabId)?.origin;
  return origin?.kind === "preset" && origin.id === presetId;
};

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

/** Whether `tabId`'s multi-select mode is in its range mode (a tap grows a
 * range from an origin, rather than toggling one row). */
export const selectRangeSelect = (s: AppState, tabId: string): boolean =>
  s.pages[tabId]?.rangeSelect ?? false;

/** The row `tabId`'s range-mode taps grow the range from — the selection's
 * anchor, while it's selected (see `rangedSelection`). `undefined` outside
 * range mode, and while the next tap is the one that sets it. */
export const selectRangeOrigin = (
  s: AppState,
  tabId: string,
): number | undefined => {
  const page = s.pages[tabId];
  const selection = page?.selection;
  if (!page?.rangeSelect || !selection?.rows.has(selection.anchor)) {
    return undefined;
  }
  return selection.anchor;
};

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

/** Every record of one table that a menu's rows identify — what that table's
 * entries in the menu act on. */
export interface RecordGroup {
  table: string;
  records: readonly RecordRef[];
}

/** What a menu raised on `rows` acts on: one group per table those rows carry
 * a primary key for, in first-row-first order (a track row joined to its album
 * offers both), each holding every distinct record of that table the rows
 * identify, in row order. Builds a fresh array on every call. */
export function recordGroupsForRows(
  result: QueryResult | undefined,
  lineage: LineageMapping | undefined,
  rows: Iterable<number>,
): RecordGroup[] {
  const byTable = new Map<
    string,
    { seen: Set<string>; records: RecordRef[] }
  >();
  for (const row of rows) {
    for (const record of rowRecords(result, lineage, row)) {
      let group = byTable.get(record.table);
      if (!group) {
        group = { seen: new Set(), records: [] };
        byTable.set(record.table, group);
      }
      // A track on two rows (or joined to itself) is still one track.
      const identity = JSON.stringify(record.key);
      if (group.seen.has(identity)) continue;
      group.seen.add(identity);
      group.records.push(record);
    }
  }
  return [...byTable].map(([table, { records }]) => ({ table, records }));
}

/** {@link recordGroupsForRows} against the whole state. Builds a fresh array
 * on every call. */
export function selectRecordGroupsForRows(
  s: AppState,
  tabId: string,
  rows: Iterable<number>,
): RecordGroup[] {
  return recordGroupsForRows(
    s.pages[tabId]?.result,
    s.pages[tabId]?.lineage,
    rows,
  );
}

/** The Querydown the user has written for a part of a field's embedded records,
 * or null when it goes by what the form generates. */
export const selectFieldQuerydown = (
  s: AppState,
  table: string,
  field: FieldRef,
  section: EmbedSection,
): string | null =>
  s.fieldMetadata.data[table]?.[fieldRefKey(field)]?.[section] ?? null;

/** The customized fields of `table`, or a shared empty object for a table with
 * none. */
export const selectTableMetadata = (
  s: AppState,
  table: string,
): TableMetadata => s.fieldMetadata.data[table] ?? NO_TABLE_METADATA;

/** One contextual query, by id — `undefined` once it's removed. */
export const selectContextualQuery = (
  s: AppState,
  id: string,
): ContextualQuery | undefined =>
  s.contextualQueries.data.find((query) => query.id === id);

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

/** Whether preset `id`'s inline editor is open on page `tabId`. */
export const selectPresetExpanded = (
  s: AppState,
  tabId: string,
  id: string,
): boolean => s.pages[tabId]?.expandedPresets.includes(id) ?? false;

export const selectPresetName = (s: AppState, id: string): string =>
  selectPreset(s, id)?.name ?? "(missing preset)";

/** The presets page `tabId` can pick for `section`: the saved ones for its
 * table, and any unsaved one it uses, which is its own to uncheck. Builds a
 * fresh array on every call. */
export const selectPresetsFor = (
  s: AppState,
  tabId: string,
  section: Section,
): Preset[] => {
  const baseTable = selectPageBase(s, tabId);
  const live = selectPageTab(s, tabId)?.live;
  return [
    ...s.presets.filter(
      (p) => p.section === section && p.baseTable === baseTable,
    ),
    ...s.unsavedPresets.filter(
      (p) => p.section === section && live && usesPreset(live, p.id),
    ),
  ];
};

/** Whether preset `id` is one the backend has never heard of. */
export const selectPresetIsNew = (s: AppState, id: string): boolean =>
  s.unsavedPresets.some((p) => p.id === id);

/** Whether preset `id` needs the user before the backend can have it: it's
 * never been saved, its last write failed, or its name is blank (which can't be
 * stored). Anything else is on its way there by itself. Drives the ✱ marker and
 * the editor's Save and Revert, as `selectIsUnsaved` does a query's. */
export const selectPresetUnsaved = (s: AppState, id: string): boolean => {
  if (selectPresetIsNew(s, id)) return true;
  if (s.presetSaves[id]?.failed) return true;
  return selectPreset(s, id)?.name.trim() === "";
};

/** A query or playlist whose definition uses a preset. `name` is empty for a
 * query that's never been saved. */
export interface PresetUser {
  id: string;
  kind: SourceKind;
  name: string;
}

/** Every query and playlist whose definition uses preset `id` — what deleting
 * it leaves referring to nothing. An open page counts by its working
 * definition (which may hold edits not yet saved, or belong to a query that
 * never was), and any other saved source by its stored one. Open pages first,
 * in tab order, then the rest in list order.
 *
 * Not a selector: it parses every saved definition, so it's called from a
 * component's `useMemo` over `tabs` and `sources.data`. */
export function presetUsers(
  tabs: readonly Tab[],
  sources: readonly Source[],
  id: string,
): PresetUser[] {
  const users: PresetUser[] = [];
  const open = new Set<string>();
  for (const t of tabs) {
    if (t.kind !== "query" && t.kind !== "playlist") continue;
    open.add(t.id);
    if (usesPreset(t.live, id)) {
      users.push({ id: t.id, kind: t.kind, name: t.name });
    }
  }
  for (const source of sources) {
    if (open.has(source.id) || !source.definition.includes(id)) continue;
    const def =
      source.kind === "playlist"
        ? playlistDefinitionFromStored(source.definition)
        : definitionFromStored(source.definition);
    if (usesPreset(def, id)) {
      users.push({ id: source.id, kind: source.kind, name: source.name });
    }
  }
  return users;
}

/** What a preset's editor reports it's used in: "in 5 queries", "in 1 query and
 * 2 playlists". */
export function presetUsageLabel(users: readonly PresetUser[]): string {
  const playlists = users.filter((u) => u.kind === "playlist").length;
  const queries = users.length - playlists;
  const count = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  const parts = [
    ...(queries > 0 || playlists === 0
      ? [count(queries, "query", "queries")]
      : []),
    ...(playlists > 0 ? [count(playlists, "playlist", "playlists")] : []),
  ];
  return `in ${parts.join(" and ")}`;
}

/** The preset with `id`, saved or not — a reference already in state. */
export function selectPreset(s: AppState, id: string): Preset | undefined {
  return (
    s.presets.find((p) => p.id === id) ??
    s.unsavedPresets.find((p) => p.id === id)
  );
}

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

/** The preset list to run/preview against: the saved presets, and the unsaved
 * ones queries can already run with. Builds a fresh array on every call —
 * internal to `actions.ts`'s compile/run path, not meant for a component
 * subscription. */
export function selectEffectivePresets(s: AppState): Preset[] {
  return [...s.presets, ...s.unsavedPresets];
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

/** The row of `tabId`'s results holding track `id` that's nearest `from` in
 * the direction `step` goes (`from` itself included), or `null` when none
 * does. Where an auto-advance or a skip lands: on the row after (or before)
 * the one it left, even when the track is also listed elsewhere. Capped like
 * {@link selectLocateRow}. */
export function selectRowNear(
  s: AppState,
  tabId: string,
  id: string,
  from: number,
  step: 1 | -1,
): number | null {
  const count = s.pages[tabId]?.result?.rowCount ?? 0;
  for (let i = 0, row = from; i < 1000; i++, row += step) {
    if (row < 0 || row >= count) return null;
    if (selectTrackIdAt(s, tabId, row) === id) return row;
  }
  return null;
}

/** The tracks rows `rows` hold, in the order shown, each once. Builds a fresh
 * array on every call. */
export function trackIdsOfRows(
  result: QueryResult | undefined,
  lineage: LineageMapping | undefined,
  rows: Iterable<number>,
): string[] {
  const col = lineage?.trackIdColumn;
  if (!result || col === undefined) return [];
  const ids = new Set<string>();
  for (const row of [...rows].sort((a, b) => a - b)) {
    const id = result.keyText(row, col);
    if (id !== "") ids.add(id);
  }
  return [...ids];
}

/** {@link trackIdsOfRows} against the whole state. Builds a fresh array on
 * every call. */
export function selectTrackIdsOfRows(
  s: AppState,
  tabId: string,
  rows: Iterable<number>,
): string[] {
  return trackIdsOfRows(s.pages[tabId]?.result, s.pages[tabId]?.lineage, rows);
}

/** How many tracks are queued. */
export function selectQueueLength(s: AppState): number {
  return s.queuedTracks.length;
}

/** Every row of `tabId`'s results holding a queued track, with that track's
 * place in the queue (from 1). Builds a fresh map, scanning every row: for the
 * results grid's subscription, which re-reads it only when the queue or the
 * rows change, not for a component. */
export function queuedRowPositions(
  s: AppState,
  tabId: string,
): ReadonlyMap<number, number> {
  const rows = new Map<number, number>();
  if (s.queuedTracks.length === 0) return rows;
  const positions = queuePositions(s.queuedTracks);
  const count = s.pages[tabId]?.result?.rowCount ?? 0;
  for (let row = 0; row < count; row++) {
    const id = selectTrackIdAt(s, tabId, row);
    const position = id === undefined ? undefined : positions.get(id);
    if (position !== undefined) rows.set(row, position);
  }
  return rows;
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
  for (const row of selectRowSelection(s, tabId)) {
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
