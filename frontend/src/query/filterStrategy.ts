// How a filter's text is read. Querydown is read as it's written; basic text is
// a line of words the user would type into any search box, turned into
// Querydown search terms here before anything compiles it. The query page's
// filter, a filter preset and the record picker's search box offer both, and a
// query or preset remembers which its text is in (`FilterParts.strategy`, and
// `Preset.filterStrategy`, migration 0021).

import type { FilterStrategy } from "api-client";
import { quoteValue } from "./recordForm";

export type { FilterStrategy };

/** A word Querydown reads, standing alone, as a default text search term: an
 * ASCII letter followed by ASCII letters and digits. Anything else — a digit
 * first, punctuation, a letter outside ASCII — would be read as something else
 * (a number, a column, an operator), or not parse at all. */
const BARE_WORD = /^[A-Za-z][A-Za-z0-9]*$/;

/** Basic text as Querydown: each whitespace-separated word a text search term,
 * bare when Querydown reads it as one and quoted otherwise (see `quoteValue`,
 * which falls back to an escaped `^e"…"` for a word holding both quotes). The
 * terms are space-separated, so they AND together. No basic text can make
 * Querydown that doesn't parse.
 *
 * ```
 * can't go      →  "can't" go
 * "it's cool"   →  ^e"\"it's" 'cool"'
 * ``` */
export function basicTextToQuerydown(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => (BARE_WORD.test(word) ? word : quoteValue(word)))
    .join(" ");
}

/** Filter text written in `strategy`, as the Querydown it stands for. */
export function filterQuerydown(
  text: string,
  strategy: FilterStrategy | undefined,
): string {
  return strategy === "basic_text" ? basicTextToQuerydown(text) : text;
}

/** Filter text written in `from`, rewritten for an input switching to `to`.
 * Basic text becomes the Querydown it already stood for, so what it finds stays
 * the same. Querydown is kept as it's written, to be read as words from now on:
 * that can change what it finds, which is the user's to accept. */
export function convertFilterText(
  text: string,
  from: FilterStrategy,
  to: FilterStrategy,
): string {
  return from === "basic_text" && to === "querydown"
    ? basicTextToQuerydown(text)
    : text;
}

/** The strategy a strategy toggle switches to. */
export function otherStrategy(strategy: FilterStrategy): FilterStrategy {
  return strategy === "basic_text" ? "querydown" : "basic_text";
}

/** A strategy's name, as the toggle's menu lists it. */
export function strategyName(strategy: FilterStrategy): string {
  return strategy === "basic_text" ? "Basic text" : "Querydown";
}

/** What a filter input says while it's empty. */
export function filterPlaceholder(strategy: FilterStrategy): string {
  return strategy === "basic_text" ? "Basic text filter" : "Querydown filter";
}
