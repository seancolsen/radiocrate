import type { Preset, Query } from "api-client";

// The wire is camelCase (the server renames via serde), so these mock fixtures —
// fulfilled verbatim by the Playwright routes below — are the generated client
// types directly.

/** Saved-query fixture for the RPC mock. */
export const QUERIES_FIXTURE: Query[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Lemonade",
    createdAt: 1_700_000_300,
    modifiedAt: 1_700_000_300,
    lastPlay: 0,
    definition: "{}",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Deep Cuts",
    createdAt: 1_700_000_200,
    modifiedAt: 1_700_000_200,
    lastPlay: 0,
    definition: "{}",
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    name: "Workout Mix",
    createdAt: 1_700_000_100,
    modifiedAt: 1_700_000_100,
    lastPlay: 0,
    definition: "{}",
  },
];

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
    definition: "rating:>=4 !genre:duplicate file.deletion:@null",
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
 * fragment `jazz playcount:<100` AND the "vetted" preset. */
export const FILTER_DEF = {
  base: "track",
  filter: { custom: "jazz playcount:<100", presets: [VETTED_PRESET_ID] },
  sort: { custom: "" },
  display: { custom: "" },
};

/** {@link FILTER_DEF} after the "Full Querydown" conversion: the same query as
 * one hand-written string, which is all a full-mode query carries. */
export const FULL_DEF = {
  ...FILTER_DEF,
  full: "#track\njazz playcount:<100\nrating:>=4 !genre:duplicate file.deletion:@null\n$title $album.title",
};
