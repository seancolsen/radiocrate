import { describe, expect, it } from "vitest";
import {
  mostCommonRatingId,
  parseRatings,
  ratingLabel,
  RATINGS_QUERY,
  stepRating,
} from "./ratings";

describe("RATINGS_QUERY", () => {
  it("asks for the whole rating table, lowest value first", () => {
    expect(RATINGS_QUERY).toEqual({
      base: "rating",
      filter: "",
      // Two literal backslashes — Querydown's ascending sort.
      sort: "\\\\value",
      display: "$id $value $symbol $description",
    });
  });
});

describe("parseRatings", () => {
  it("reads the display columns positionally", () => {
    expect(
      parseRatings([
        ["r1", "1", "🗑️", "Skip"],
        ["r4", "4", "❤️", "Love"],
      ]),
    ).toEqual([
      { id: "r1", value: "1", symbol: "🗑️", description: "Skip" },
      { id: "r4", value: "4", symbol: "❤️", description: "Love" },
    ]);
  });

  it("keeps a rating whose nullable columns are NULL", () => {
    expect(parseRatings([["r1", "1", null, null]])).toEqual([
      { id: "r1", value: "1", symbol: null, description: null },
    ]);
  });

  it("drops a row with no id — it names no record to point a track at", () => {
    expect(
      parseRatings([
        [null, "1", "🗑️", "Skip"],
        ["", "2", null, null],
      ]),
    ).toEqual([]);
  });
});

describe("ratingLabel", () => {
  const rating = {
    id: "r4",
    value: "4",
    symbol: "❤️",
    description: "Love",
  };

  it("reads value, symbol and description", () => {
    expect(ratingLabel(rating)).toBe("4: ❤️ (Love)");
  });

  it("drops the parts a rating hasn't got", () => {
    expect(ratingLabel({ ...rating, symbol: null })).toBe("4 (Love)");
    expect(ratingLabel({ ...rating, description: null })).toBe("4: ❤️");
    expect(ratingLabel({ ...rating, symbol: null, description: null })).toBe(
      "4",
    );
  });
});

describe("mostCommonRatingId", () => {
  it("picks the rating the most tracks hold, the lowest on a tie", () => {
    expect(
      mostCommonRatingId([
        ["a", "3"],
        ["b", "10"],
        ["c", "10"],
      ]),
    ).toBe("b");
  });

  it("is undefined when no track is rated", () => {
    expect(mostCommonRatingId([["a", "0"]])).toBeUndefined();
    expect(mostCommonRatingId([])).toBeUndefined();
  });
});

describe("stepRating", () => {
  const ratings = ["a", "b", "c"].map((id) => ({
    id,
    value: id,
    symbol: null,
    description: null,
  }));

  it("steps along the vocabulary and stops at the ends", () => {
    expect(stepRating(ratings, "b", 1)).toBe("c");
    expect(stepRating(ratings, "b", -1)).toBe("a");
    expect(stepRating(ratings, "c", 1)).toBeUndefined();
    expect(stepRating(ratings, "a", -1)).toBeUndefined();
  });

  it("steps an unrated track up to the lowest rating, and not down", () => {
    expect(stepRating(ratings, null, 1)).toBe("a");
    expect(stepRating(ratings, null, -1)).toBeUndefined();
  });
});
