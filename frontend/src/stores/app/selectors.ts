import type { Preset } from "api-client";
import { settingValue, type SettingKey } from "../../state/settings";
import { defsEqual, type Section } from "../../query/definition";
import type { RowContext } from "../../query/rowDml";
import {
  EMPTY_SELECTION,
  type AppState,
  type PresetEdit,
  type QueryTab,
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

/** Whether a tab has unsaved changes: an ephemeral (never-saved) query tab
 * always, else a persisted one whose working def differs from its saved def.
 * Never true for a non-query tab — the shortcuts editor writes its bindings
 * through immediately. */
export const selectIsUnsaved = (s: AppState, tabId: string): boolean => {
  const t = selectQueryTab(s, tabId);
  return t ? !t.persisted || !defsEqual(t.saved, t.live) : false;
};

/** Whether "Revert changes" applies: a persisted tab with edits to discard (an
 * ephemeral tab has no saved baseline to revert to). */
export const selectCanRevert = (s: AppState, tabId: string): boolean => {
  const t = selectQueryTab(s, tabId);
  return t ? t.persisted && !defsEqual(t.saved, t.live) : false;
};

export const selectResultCount = (
  s: AppState,
  tabId: string,
): number | undefined => s.resultsByTab[tabId]?.rowCount;

export const selectRowSelection = (
  s: AppState,
  tabId: string,
): ReadonlySet<number> => s.selectionByTab[tabId] ?? EMPTY_SELECTION;

/** The records result row `index` identifies — one per table whose primary key
 * the row carries in full, in result-column order. Empty when the lineage
 * analysis found none (or hasn't finished), which is what leaves the row's
 * context menu with nothing to offer. Builds a fresh array on every call. */
export function selectRowRecords(
  s: AppState,
  tabId: string,
  index: number,
): RecordRef[] {
  const result = s.resultsByTab[tabId];
  const targets = s.lineageByTab[tabId]?.records ?? [];
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

export const selectRecordEditor = (
  s: AppState,
  tabId: string,
): RecordEditorTarget | null => s.recordEditorByTab[tabId] ?? null;

export const selectBuilderSection = (
  s: AppState,
  tabId: string,
): Section | null => s.builderSectionByTab[tabId] ?? null;

/** Whether a tab's working query is one hand-written Querydown query rather
 * than the four builder sections. */
export const selectIsFullQuery = (s: AppState, tabId: string): boolean =>
  selectQueryTab(s, tabId)?.live.full != null;

export const selectFullEditorOpen = (s: AppState, tabId: string): boolean =>
  s.fullEditorByTab[tabId] ?? false;

export const selectExpandedPreset = (
  s: AppState,
  tabId: string,
): string | null => s.expandedPresetByTab[tabId] ?? null;

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
  const result = s.resultsByTab[tabId];
  const col = s.lineageByTab[tabId]?.trackIdColumn;
  if (!result || col === undefined) return undefined;
  const id = result.keyText(index, col);
  return id === "" ? undefined : id;
}

/** Reads `tabId`'s results around row `index` into the play context the
 * engine navigates. `preceding` is every playable id before `index` (nearest
 * last, for "previous"); `upcoming` is the contiguous run of ids after it,
 * stopping at the first row without one (mirrors `playlist_around`). */
export function selectPlaylistAround(
  s: AppState,
  tabId: string,
  index: number,
): { preceding: string[]; upcoming: string[] } {
  const result = s.resultsByTab[tabId];
  const col = s.lineageByTab[tabId]?.trackIdColumn;
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
  const result = s.resultsByTab[tabId];
  const col = s.lineageByTab[tabId]?.trackIdColumn;
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
  for (const row of s.selectionByTab[tabId] ?? []) {
    if (identifies(row)) return row;
  }
  const limit = Math.min(s.resultsByTab[tabId]?.rowCount ?? 0, 1000);
  for (let row = 0; row < limit; row++) if (identifies(row)) return row;
  return undefined;
}

/** What re-reading row `index` of `tabId` takes: the query as the user built
 * it, and what the row stands for. `undefined` — which runs the write with no
 * refresh at all — when the tab holds no query, the schema hasn't loaded, or
 * the row identifies no record to narrow the query to. */
export function selectRowContext(
  s: AppState,
  tabId: string,
  index: number,
): RowContext | undefined {
  const t = selectQueryTab(s, tabId);
  const schemaJson = s.schema.json;
  if (!t || schemaJson === undefined) return undefined;
  const records = selectRowRecords(s, tabId, index);
  if (records.length === 0) return undefined;
  // The *working* definition: it's the one the displayed rows came from.
  return {
    definition: t.live,
    presets: selectEffectivePresets(s),
    schemaJson,
    prelude: selectPrelude(s),
    records,
  };
}
