// What the record editor offers for a field in its autocomplete mode: the
// distinct values the column holds across every record of the table, the
// commonest first. Pure, like the rest of `query/`: the query to run, what to
// make of its rows, and where the keyboard goes in the pages they fill.

import {
  quoteValue,
  type PrimitiveField,
  type RecordQuery,
} from "./recordForm";
import type { RecordRows } from "./recordData";

/** How many values one page of suggestions holds. They're all fetched at once;
 * paging only spares the list from drawing thousands of rows. */
export const SUGGESTIONS_PER_PAGE = 50;

/** One value a column holds, and how many records hold it. */
export interface ValueSuggestion {
  value: string;
  count: number;
}

/** The query behind the suggestions for `search`: one row per distinct value of
 * the column, with its count.
 *
 * Only a text column can be searched by the query, since that's the only type
 * Querydown's `:` means "contains" on. On any other it compiles to `=`, which
 * finds whole values only, and is an error for a string that won't cast (`ab`
 * against a number). So those columns come back whole, and
 * {@link parseSuggestions} does the searching. */
export function suggestionsQuery(
  table: string,
  field: Pick<PrimitiveField, "column" | "valueType">,
  search: string,
): RecordQuery {
  return {
    base: table,
    filter:
      field.valueType === "text" && search !== ""
        ? `${field.column}:${quoteValue(search)}`
        : "",
    sort: "",
    display: `$${field.column} \\gs2 $%count \\sd1`,
  };
}

/** What {@link suggestionsQuery} returned, as a list to offer: no NULL or empty
 * value, since neither is anything to pick, and the search applied if the query
 * couldn't apply it.
 *
 * The query sorts too, but its tie-break is by byte, which puts every capital
 * ahead of every lowercase letter, so ties are put in alphabetical order here. */
export function parseSuggestions(
  rows: RecordRows,
  field: Pick<PrimitiveField, "valueType">,
  search: string,
): ValueSuggestion[] {
  const needle = search.toLowerCase();
  const suggestions: ValueSuggestion[] = [];
  for (const [value, count] of rows) {
    if (value == null || value === "") continue;
    if (field.valueType !== "text" && !value.toLowerCase().includes(needle)) {
      continue;
    }
    suggestions.push({ value, count: Number(count) });
  }
  return suggestions.sort(
    (a, b) =>
      b.count - a.count ||
      a.value.localeCompare(b.value, undefined, { numeric: true }),
  );
}

/** Where the user is in the list: the page on show, and the highlighted value
 * (an index into the whole list), if any. Nothing is highlighted to begin with,
 * so that Enter goes on meaning what it means in the box until the user reaches
 * for a suggestion. */
export interface SuggestionCursor {
  page: number;
  highlight: number | null;
}

export const START_CURSOR: SuggestionCursor = { page: 0, highlight: null };

/** How many pages `total` values fill. */
export function pageCount(total: number): number {
  return Math.ceil(total / SUGGESTIONS_PER_PAGE);
}

/** The cursor after an arrow key: the highlight one value along, wrapping at
 * either end of the whole list and taking the page with it. With nothing
 * highlighted yet, it starts at the near end of the page on show. */
export function moveHighlight(
  cursor: SuggestionCursor,
  delta: 1 | -1,
  total: number,
): SuggestionCursor {
  if (total === 0) return cursor;
  const highlight =
    cursor.highlight !== null
      ? (cursor.highlight + delta + total) % total
      : delta > 0
        ? cursor.page * SUGGESTIONS_PER_PAGE
        : Math.min((cursor.page + 1) * SUGGESTIONS_PER_PAGE, total) - 1;
  return { page: Math.floor(highlight / SUGGESTIONS_PER_PAGE), highlight };
}

/** The cursor after a turn of the page, stopping at the first and the last. A
 * highlight comes along, to the top of the new page. */
export function movePage(
  cursor: SuggestionCursor,
  delta: 1 | -1,
  total: number,
): SuggestionCursor {
  const page = Math.max(0, Math.min(cursor.page + delta, pageCount(total) - 1));
  if (page === cursor.page) return cursor;
  return {
    page,
    highlight: cursor.highlight === null ? null : page * SUGGESTIONS_PER_PAGE,
  };
}
