import { describe, expect, it } from "vitest";
import {
  movePage,
  moveHighlight,
  pageCount,
  parseSuggestions,
  START_CURSOR,
  SUGGESTIONS_PER_PAGE,
  suggestionsQuery,
} from "./valueSuggestions";

const TEXT = { column: "title", valueType: "text" } as const;
const NUMBER = { column: "year", valueType: "number" } as const;

describe("suggestionsQuery", () => {
  it("groups by the column, the commonest first, then by value", () => {
    expect(suggestionsQuery("album", TEXT, "")).toEqual({
      base: "album",
      filter: "",
      sort: "",
      display: "$title \\gs2 $%count \\sd1",
    });
  });

  it("searches a text column in the query, with what's typed quoted", () => {
    expect(suggestionsQuery("album", TEXT, 'a "b"').filter).toBe(
      'title:"a \\"b\\""',
    );
  });

  it("leaves a column of any other type for the rows to be searched", () => {
    expect(suggestionsQuery("album", NUMBER, "19").filter).toBe("");
  });
});

describe("parseSuggestions", () => {
  it("drops NULL and empty values, which are nothing to pick", () => {
    const rows = [
      [null, "9"],
      ["", "8"],
      ["Rock", "1"],
    ];
    expect(parseSuggestions(rows, TEXT, "")).toEqual([
      { value: "Rock", count: 1 },
    ]);
  });

  it("sorts by count, then alphabetically whatever the case", () => {
    const rows = [
      ["Zebra", "2"],
      ["apple", "2"],
      ["Mango", "3"],
      ["Banana", "2"],
    ];
    expect(parseSuggestions(rows, TEXT, "").map((s) => s.value)).toEqual([
      "Mango",
      "apple",
      "Banana",
      "Zebra",
    ]);
  });

  it("leaves a text column's search to the query, accents and all", () => {
    expect(parseSuggestions([["Beyoncé", "1"]], TEXT, "beyonce")).toHaveLength(
      1,
    );
  });

  it("searches any other column here, by what the value contains", () => {
    const rows = [
      ["1999", "1"],
      ["2019", "1"],
      ["2024", "1"],
    ];
    expect(parseSuggestions(rows, NUMBER, "19").map((s) => s.value)).toEqual([
      "1999",
      "2019",
    ]);
  });
});

describe("moving through the list", () => {
  const PAGE = SUGGESTIONS_PER_PAGE;
  const TOTAL = PAGE * 2 + 3;

  it("counts the pages, a partly filled one included", () => {
    expect(pageCount(0)).toBe(0);
    expect(pageCount(PAGE)).toBe(1);
    expect(pageCount(TOTAL)).toBe(3);
  });

  it("starts the highlight at the near end of the page on show", () => {
    const second = { page: 1, highlight: null };
    expect(moveHighlight(START_CURSOR, 1, TOTAL).highlight).toBe(0);
    expect(moveHighlight(second, 1, TOTAL).highlight).toBe(PAGE);
    expect(moveHighlight(second, -1, TOTAL).highlight).toBe(PAGE * 2 - 1);
    // The last page isn't a full one.
    expect(
      moveHighlight({ page: 2, highlight: null }, -1, TOTAL).highlight,
    ).toBe(TOTAL - 1);
  });

  it("takes the page along when the highlight crosses into another", () => {
    expect(moveHighlight({ page: 0, highlight: PAGE - 1 }, 1, TOTAL)).toEqual({
      page: 1,
      highlight: PAGE,
    });
    expect(moveHighlight({ page: 1, highlight: PAGE }, -1, TOTAL)).toEqual({
      page: 0,
      highlight: PAGE - 1,
    });
  });

  it("wraps at either end of the whole list", () => {
    expect(moveHighlight({ page: 0, highlight: 0 }, -1, TOTAL)).toEqual({
      page: 2,
      highlight: TOTAL - 1,
    });
    expect(moveHighlight({ page: 2, highlight: TOTAL - 1 }, 1, TOTAL)).toEqual({
      page: 0,
      highlight: 0,
    });
  });

  it("does nothing with no values to move through", () => {
    expect(moveHighlight(START_CURSOR, 1, 0)).toEqual(START_CURSOR);
    expect(movePage(START_CURSOR, 1, 0)).toEqual(START_CURSOR);
  });

  it("turns the page, stopping at the first and the last", () => {
    expect(movePage(START_CURSOR, -1, TOTAL)).toEqual(START_CURSOR);
    expect(movePage(START_CURSOR, 1, TOTAL)).toEqual({
      page: 1,
      highlight: null,
    });
    const last = { page: 2, highlight: TOTAL - 1 };
    expect(movePage(last, 1, TOTAL)).toEqual(last);
  });

  it("brings a highlight to the top of the new page", () => {
    expect(movePage({ page: 0, highlight: 7 }, 1, TOTAL)).toEqual({
      page: 1,
      highlight: PAGE,
    });
  });
});
