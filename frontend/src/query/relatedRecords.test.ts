import { describe, expect, it } from "vitest";
import {
  artistAlbumsFilter,
  artistTracksFilter,
  creditedArtists,
  creditsQuery,
  trackAlbumIds,
  trackAlbumsQuery,
} from "./relatedRecords";

describe("creditsQuery", () => {
  it("asks for a track's credits, in credit order then by name", () => {
    expect(creditsQuery("track", ["t1"])).toEqual({
      base: "credit",
      filter: `track:="t1"`,
      // Two literal backslashes per term — Querydown's ascending sort.
      sort: "\\\\order \\\\artist.name",
      display: "$artist.id $artist.name $order",
    });
  });

  it("reaches an album's credits through its tracks", () => {
    expect(creditsQuery("album", ["a1", "a2"]).filter).toBe(
      `[\n  track.album:="a1"\n  track.album:="a2"\n]`,
    );
  });
});

describe("creditedArtists", () => {
  it("lists one track's artists in credit order, then by name", () => {
    expect(
      creditedArtists([
        ["x", "Xavier", "1"],
        ["b", "Bea", "2"],
        ["a", "Ann", "2"],
      ]),
    ).toEqual([
      { id: "x", name: "Xavier" },
      { id: "a", name: "Ann" },
      { id: "b", name: "Bea" },
    ]);
  });

  it("puts a credit with no order after every ordered one", () => {
    expect(
      creditedArtists([
        ["z", "Zed", null],
        ["y", "Yan", "9"],
        ["a", "Ann", null],
      ]).map((a) => a.id),
    ).toEqual(["y", "a", "z"]);
  });

  it("takes each artist once, most credits first, then by lowest total order", () => {
    expect(
      creditedArtists([
        // Lead on three tracks.
        ["lead", "Lead", "1"],
        ["lead", "Lead", "1"],
        ["lead", "Lead", "1"],
        // Featured on two, as second and as third…
        ["feat", "Feat", "2"],
        ["feat", "Feat", "3"],
        // …and on two as second each: the lower total.
        ["guest", "Guest", "2"],
        ["guest", "Guest", "2"],
        ["once", "Once", "1"],
      ]).map((a) => a.id),
    ).toEqual(["lead", "guest", "feat", "once"]);
  });

  it("drops a row with no artist id", () => {
    expect(creditedArtists([[null, "Nobody", "1"]])).toEqual([]);
  });
});

describe("trackAlbumsQuery", () => {
  it("asks for the tracks' album column", () => {
    expect(trackAlbumsQuery(["t1", "t2"])).toEqual({
      base: "track",
      filter: `[\n  id:="t1"\n  id:="t2"\n]`,
      sort: "",
      display: "$album",
    });
  });
});

describe("trackAlbumIds", () => {
  it("takes each album once, skipping tracks on none", () => {
    expect(trackAlbumIds([["a1"], [null], ["a2"], ["a1"], [""]])).toEqual([
      "a1",
      "a2",
    ]);
  });
});

describe("artist filters", () => {
  it("finds an artist's tracks through their credits", () => {
    expect(artistTracksFilter(["22fb40e1"])).toBe(
      `++#credit{artist.id:="22fb40e1"}`,
    );
  });

  it("finds an artist's albums through their tracks' credits", () => {
    expect(artistAlbumsFilter(["22fb40e1"])).toBe(
      `++#track{++#credit{artist.id:="22fb40e1"}}`,
    );
  });

  it("finds several artists' tracks as alternatives", () => {
    expect(artistTracksFilter(["a", "b"])).toBe(
      `++#credit{[\n  artist.id:="a"\n  artist.id:="b"\n]}`,
    );
  });
});
