import { describe, expect, it } from "vitest";
import { entityNames, nounFor, pluralOrRaw } from "./entityNames";

describe("entityNames", () => {
  it("maps irregular and multi-word tables", () => {
    expect(entityNames("rating")).toEqual(["rating", "ratings"]);
    expect(entityNames("track_tag")).toEqual(["track tag", "track tags"]);
  });

  it("names the app's own tables by their schema", () => {
    expect(entityNames("/app/query")).toEqual(["query", "queries"]);
    expect(entityNames("/app/playlist_track")).toEqual([
      "playlist track",
      "playlist tracks",
    ]);
    // `main` has none of them since migration 0018.
    expect(entityNames("playlist_track")).toBeUndefined();
  });

  it("picks the noun by count", () => {
    expect(nounFor("track", 1)).toBe("track");
    expect(nounFor("track", 0)).toBe("tracks");
    expect(nounFor("artist", 10)).toBe("artists");
  });

  it("copes with unknown, empty and prototype-ish names", () => {
    expect(entityNames("my_table")).toBeUndefined();
    expect(entityNames("")).toBeUndefined();
    expect(entityNames("constructor")).toBeUndefined();
    expect(nounFor("my_table", 2)).toBeUndefined();
    expect(pluralOrRaw("my_table")).toBe("my_table");
    expect(pluralOrRaw("credit")).toBe("credits");
  });
});
