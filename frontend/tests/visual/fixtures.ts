import type { Preset, Query } from "api-client";

// The wire is camelCase (the server renames via serde), so these mock fixtures —
// fulfilled verbatim by the Playwright routes below — are the generated client
// types directly.

/** Saved-query fixture for the RPC mock. Names reuse the egui snapshot fixtures
 * ("Lemonade", "Deep Cuts", "Workout Mix"; organizer.rs:1058) so the new frame
 * images stay visually comparable to the old ones. */
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

/** Preset fixture for the RPC mock — mirrors the "vetted" filter preset shown in
 * the egui `filter_builder/*.png` snapshots (same name and definition). */
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
];

/** The working definition behind the filter-builder snapshots: the custom
 * fragment `jazz playcount:<100` AND the "vetted" preset (matching the egui
 * `filter_builder` images). */
export const FILTER_DEF = {
  base: "track",
  filter: { custom: "jazz playcount:<100", presets: [VETTED_PRESET_ID] },
  sort: { custom: "" },
  display: { custom: "" },
};
