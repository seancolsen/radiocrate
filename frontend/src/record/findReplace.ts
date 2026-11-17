// Find and replace over a text field's values: what the user typed into the
// record editor's Find box, under the three toggles beside it, made into one
// pattern that both the preview (where it matches) and the replacement (what
// it makes of each value) run.
//
// Framework-free: no React, no store.

/** The toggles beside the Find box. The user's choices outlive any one form
 * (the app store keeps them, in localStorage). */
export interface FindOptions {
  /** Whether "a" finds only "a", not "A" too. */
  matchCase: boolean;
  /** Whether a match must be a whole word, not part of a longer one. */
  wholeWord: boolean;
  /** Whether the Find text is a regular expression, and the Replace text may
   * name what it captured (`$1`, `$<name>`, `$&`). */
  regex: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  matchCase: false,
  wholeWord: false,
  regex: false,
};

/** What the Find text comes to, under the options:
 *
 *  - `null`: nothing typed, so nothing to find.
 *  - `{ error }`: a regular expression that doesn't parse, with why.
 *  - `{ pattern }`: something to find, global (it finds every match). `literal`
 *    says the replacement is to be taken as written, `$` and all. */
export type Finder =
  null | { error: string } | { pattern: RegExp; literal: boolean };

/** One match, as offsets into the text it was found in. */
export interface MatchRange {
  start: number;
  end: number;
}

/** Escapes everything a regular expression reads as syntax, under the `u` flag
 * (which refuses escapes of anything else). */
const escapeRegExp = (text: string): string =>
  text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** What counts as part of a word, for "Match whole word": letters (with their
 * accents), digits, and the underscore — in any script, as music metadata is. */
const WORD_CHAR = String.raw`[\p{L}\p{M}\p{N}_]`;

/** The Find text and the toggles beside it, made into one pattern. */
export function compileFind(find: string, options: FindOptions): Finder {
  if (find === "") return null;
  let source = options.regex ? find : escapeRegExp(find);
  if (options.wholeWord) {
    source = `(?<!${WORD_CHAR})(?:${source})(?!${WORD_CHAR})`;
  }
  const flags = options.matchCase ? "gu" : "giu";
  try {
    return { pattern: new RegExp(source, flags), literal: !options.regex };
  } catch (err) {
    return { error: regexError(err) };
  }
}

/** Why a pattern didn't parse, without the engine's preamble repeating the
 * pattern back ("Invalid regular expression: /(/giu: Unterminated group"). */
function regexError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, "");
}

/** Where `pattern` matches in `text`, in order. A match of no characters (`^`,
 * `a*` between the a's) has nothing to highlight, and is left out. */
export function matchRanges(text: string, pattern: RegExp): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const m of text.matchAll(pattern)) {
    if (m[0].length === 0) continue;
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

/** `text` with every match replaced. A literal replacement goes in as written;
 * a regular expression's may name its captures. */
export function replaceMatches(
  text: string,
  finder: { pattern: RegExp; literal: boolean },
  replacement: string,
): string {
  return finder.literal
    ? text.replace(finder.pattern, () => replacement)
    : text.replace(finder.pattern, replacement);
}

/** Whether `pattern` finds anything in `text` — a match of no characters
 * included, since replacing one still changes the text. */
export function hasMatch(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  const found = pattern.test(text);
  pattern.lastIndex = 0;
  return found;
}

/** Splits `text` into runs, each marked whether it was matched and where it
 * starts — for drawing the matches highlighted. */
export function splitByMatches(
  text: string,
  ranges: readonly MatchRange[],
): { start: number; text: string; matched: boolean }[] {
  const runs: { start: number; text: string; matched: boolean }[] = [];
  let at = 0;
  for (const { start, end } of ranges) {
    if (start > at) {
      runs.push({ start: at, text: text.slice(at, start), matched: false });
    }
    runs.push({ start, text: text.slice(start, end), matched: true });
    at = end;
  }
  if (at < text.length) {
    runs.push({ start: at, text: text.slice(at), matched: false });
  }
  return runs;
}

/** The options as stored, or the defaults for anything missing or unreadable. */
export function parseFindOptions(raw: string | null): FindOptions {
  if (raw === null) return DEFAULT_FIND_OPTIONS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_FIND_OPTIONS;
    }
    const read = (key: keyof FindOptions): boolean => {
      const v = (parsed as Record<string, unknown>)[key];
      return typeof v === "boolean" ? v : DEFAULT_FIND_OPTIONS[key];
    };
    return {
      matchCase: read("matchCase"),
      wholeWord: read("wholeWord"),
      regex: read("regex"),
    };
  } catch {
    return DEFAULT_FIND_OPTIONS;
  }
}
