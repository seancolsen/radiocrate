import type { Query } from "../../src/api/rpc";

/** Saved-query fixture for the RPC mock. Names reuse the egui snapshot fixtures
 * ("Lemonade", "Deep Cuts", "Workout Mix"; organizer.rs:1058) so the new frame
 * images stay visually comparable to the old ones. */
export const QUERIES_FIXTURE: Query[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Lemonade",
    created_at: 1_700_000_300,
    modified_at: 1_700_000_300,
    last_play: 0,
    definition: "{}",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Deep Cuts",
    created_at: 1_700_000_200,
    modified_at: 1_700_000_200,
    last_play: 0,
    definition: "{}",
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    name: "Workout Mix",
    created_at: 1_700_000_100,
    modified_at: 1_700_000_100,
    last_play: 0,
    definition: "{}",
  },
];
