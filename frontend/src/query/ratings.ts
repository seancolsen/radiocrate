// The rating vocabulary: every record of the `rating` table, which is what the
// results row menu offers as the ratings a track can be given.
//
// The list is a whole small table rather than anything derived from a result
// row, so it's one fixed Querydown query with no conditions — run through the
// record editor's runner (`recordData.ts`), which already turns a Querydown
// query into rows of strings and carries the dev/test seam that lets the
// harness answer it without a backend.
//
// Migration 0003 seeds the table with four standard ratings, but nothing holds
// it to four: the menu shows whatever rows come back, in `value` order.

import { runRecordQuery, type RecordRows } from "./recordData";
import type { RecordQuery } from "./recordForm";

/** One rating record, as the menu reads it. Every value arrives as the string
 * the column formats to — `value` included, which is what the label shows, so
 * the frontend never re-renders a number the database already rendered.
 * `symbol` and `description` are nullable columns. */
export interface Rating {
  id: string;
  value: string;
  symbol: string | null;
  description: string | null;
}

/** Every rating, lowest value first. The display order is the columns of
 * {@link Rating} in order, which is how {@link parseRatings} reads them back. */
export const RATINGS_QUERY: RecordQuery = {
  base: "rating",
  filter: "",
  // Two literal backslashes: Querydown's ascending sort.
  sort: "\\\\value",
  display: "$id $value $symbol $description",
};

/** The rows of {@link RATINGS_QUERY} as ratings. A row with no `id` names no
 * record to point a track at, so it's dropped rather than offered. */
export function parseRatings(rows: RecordRows): Rating[] {
  const ratings: Rating[] = [];
  for (const row of rows) {
    const id = row[0];
    if (id == null || id === "") continue;
    ratings.push({
      id,
      value: row[1] ?? "",
      symbol: row[2],
      description: row[3],
    });
  }
  return ratings;
}

/** Loads the rating vocabulary. Throws whatever the runner throws. */
export async function fetchRatings(schemaJson: string): Promise<Rating[]> {
  return parseRatings(await runRecordQuery(RATINGS_QUERY, schemaJson));
}

/** One rating as the menu says it: `4: ❤️ (Love)`. A rating missing its symbol
 * or its description simply drops that part — both columns are nullable, and a
 * row that carries neither still reads as its value. */
export function ratingLabel(rating: Rating): string {
  const head = rating.symbol
    ? `${rating.value}: ${rating.symbol}`
    : rating.value;
  return rating.description ? `${head} (${rating.description})` : head;
}
