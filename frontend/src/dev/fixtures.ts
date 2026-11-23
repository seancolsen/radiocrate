import type { Preset, Source, TableSummary } from "api-client";
import type { QueryDefinition } from "../query/definition";
import { splitTableName } from "../query/schema";

// The canned backend answers shared by the visual-test harness (`dev/harness/`,
// which fulfills them from a stubbed `fetch`) and by the Playwright specs that
// still drive the whole app. The wire is camelCase (the server renames via
// serde), so these are the generated client types directly.
//
// Dev/test only: nothing in `main.tsx`'s import graph reaches this file, so it
// never ships.

/** Saved-source fixture for the RPC mock: three queries. Each wraps a query
 * row whose id differs from the source's, as a newly added query's does. */
export const SOURCES_FIXTURE: Source[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    kind: "query",
    parent: null,
    position: 0,
    name: "Lemonade",
    createdAt: 1_700_000_300,
    modifiedAt: 1_700_000_300,
    lastPlay: 0,
    definition: "{}",
    queryId: "00000000-0000-0000-0000-0000000000e1",
    playlistId: null,
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    kind: "query",
    parent: null,
    position: 1,
    name: "Deep Cuts",
    createdAt: 1_700_000_200,
    modifiedAt: 1_700_000_200,
    lastPlay: 0,
    definition: "{}",
    queryId: "00000000-0000-0000-0000-0000000000e2",
    playlistId: null,
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    kind: "query",
    parent: null,
    position: 2,
    name: "Workout Mix",
    createdAt: 1_700_000_100,
    modifiedAt: 1_700_000_100,
    lastPlay: 0,
    definition: "{}",
    queryId: "00000000-0000-0000-0000-0000000000e3",
    playlistId: null,
  },
];

/** A saved playlist, kept out of {@link SOURCES_FIXTURE} so that the explorer
 * and whole-app snapshots don't change with it: the playlist stories install
 * it themselves. */
export const PLAYLIST_SOURCE: Source = {
  id: "00000000-0000-0000-0000-000000000004",
  kind: "playlist",
  parent: null,
  position: 3,
  name: "Road Trip",
  createdAt: 1_700_000_000,
  modifiedAt: 1_700_000_000,
  lastPlay: 0,
  definition: JSON.stringify({
    filter: { custom: "", presets: [] },
    sort: { builtin: { preset: "playlist_order" } },
    display: { custom: "" },
  }),
  queryId: null,
  playlistId: "00000000-0000-0000-0000-0000000000d4",
};

/** A stable id for the "vetted" filter preset used by the builder snapshots. */
export const VETTED_PRESET_ID = "00000000-0000-0000-0000-0000000000a1";

/** A stable id for the album sort preset the base-switching test lands on. */
export const ALBUM_SORT_PRESET_ID = "00000000-0000-0000-0000-0000000000a2";

/** Preset fixture for the RPC mock: a "vetted" filter preset, plus an
 * apply-by-default sort preset on *another* base table — what switching the base
 * to `album` is expected to seed its sorting with. Being scoped to `album`, it
 * stays invisible to every track-based snapshot. */
export const PRESETS_FIXTURE: Preset[] = [
  {
    id: VETTED_PRESET_ID,
    name: "vetted",
    baseTable: "track",
    section: "filter",
    definition: "rating.value:>=4 !++#tag{name:duplicate}",
    isDefault: false,
    createdAt: 1_700_000_000,
    modifiedAt: 1_700_000_000,
  },
  {
    id: ALBUM_SORT_PRESET_ID,
    name: "newest first",
    baseTable: "album",
    section: "sort",
    definition: "\\\\year%desc",
    isDefault: true,
    createdAt: 1_700_000_000,
    modifiedAt: 1_700_000_000,
  },
];

/** The working definition behind the filter-builder snapshots: the custom
 * fragment `jazz play_count:<100` AND the "vetted" preset. */
export const FILTER_DEF: QueryDefinition = {
  base: "track",
  filter: { custom: "jazz play_count:<100", presets: [VETTED_PRESET_ID] },
  sort: { custom: "" },
  display: { custom: "" },
};

/** {@link FILTER_DEF} after the "Full Querydown" conversion: the same query as
 * one hand-written string, which is all a full-mode query carries. */
export const FULL_DEF: QueryDefinition = {
  ...FILTER_DEF,
  full: "#track\njazz play_count:<100\nrating.value:>=4 !++#tag{name:duplicate}\n$title $album.title",
};

/** A sort section holding the built-in Shuffle preset (fixed seed → stable). */
export const SHUFFLE_DEF: QueryDefinition = {
  base: "track",
  filter: { custom: "", presets: [] },
  sort: { builtin: { preset: "shuffle", seed: "TESTSEED0000000000AA" } },
  display: { custom: "" },
};

/** One table's `table.summarize` answer: its row count, and for each column
 * how many distinct values it holds and the share of its rows that are NULL. */
const summary = (
  name: string,
  rowCount: number,
  columns: [string, number, number][],
): TableSummary => ({
  schema: splitTableName(name).schema,
  name: splitTableName(name).table,
  rowCount,
  columns: columns.map(([column, approxUnique, nullPercentage]) => ({
    name: column,
    approxUnique,
    nullPercentage,
  })),
});

/** `table.summarize` for the tables of the record fixture's schema
 * (`recordFixture.ts`): a collection of some twelve thousand tracks. Its
 * other schemas' (`FIXTURE_SCHEMAS_JSON`) come last; the stories without them
 * never ask for theirs. */
export const TABLE_SUMMARIES_FIXTURE: TableSummary[] = [
  summary("album", 1204, [
    ["id", 1204, 0],
    ["title", 1187, 0.42],
    ["year", 71, 18.6],
  ]),
  summary("artist", 2318, [
    ["id", 2318, 0],
    ["name", 2318, 0],
  ]),
  summary("credit", 15872, [
    ["track", 12480, 0],
    ["artist", 2301, 0],
    ["order", 9, 0],
    ["role", 6, 81.25],
  ]),
  summary("file", 12509, [
    ["id", 12509, 0],
    ["path", 12509, 0],
    ["size", 12466, 0],
    ["format", 4, 0],
    ["duration", 9120, 0],
    ["added", 3055, 0],
  ]),
  summary("play", 48211, [
    ["track", 9876, 0],
    ["timestamp", 48211, 0],
  ]),
  summary("rating", 11, [
    ["id", 11, 0],
    ["value", 11, 0],
    ["symbol", 11, 0],
    ["description", 4, 63.64],
  ]),
  summary("role", 6, [
    ["id", 6, 0],
    ["name", 6, 0],
  ]),
  summary("tag", 37, [
    ["id", 37, 0],
    ["name", 37, 0],
  ]),
  summary("track", 12509, [
    ["id", 12509, 0],
    ["file", 12509, 0],
    ["title", 11876, 0],
    ["album", 1198, 4.21],
    ["disc_number", 4, 71.3],
    ["track_number", 45, 20],
    ["rating", 9, 38.07],
  ]),
  summary("track_tag", 3105, [
    ["track", 2764, 0],
    ["tag", 37, 0],
  ]),
  // The other schemas of `FIXTURE_SCHEMAS_JSON`.
  summary("/lastfm/artist", 812, [
    ["mbid", 812, 0],
    ["name", 809, 0],
  ]),
  summary("/lastfm/scrobble", 30544, [
    ["id", 30544, 0],
    ["track", 7210, 12.5],
    ["artist", 790, 0],
    ["title", 8102, 0],
    ["played_at", 30544, 0],
  ]),
  summary("/metadata/computed_column", 2, [
    ["schema_name", 1, 0],
    ["table_name", 1, 0],
    ["name", 2, 0],
    ["expression", 2, 0],
  ]),
  summary("/metadata/table", 3, [
    ["schema_name", 1, 0],
    ["table_name", 3, 0],
    ["visible", 2, 0],
    ["order", 2, 33.33],
  ]),
];
