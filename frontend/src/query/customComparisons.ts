// Custom comparisons: Querydown conditions named on a table, so that a filter
// on its records can compare them by that name. With
//
//   #track.artist:@x = ++#artist{name:@x}
//
// the filter `artist:prince`, on tracks, finds the tracks crediting an artist
// whose name contains "prince": the condition, with `@x` standing for the value
// compared. Pure, like the rest of `query/`: the app store holds the user's rows
// (`metadata.custom_comparison` in the database) and writes them.
//
// As with computed columns (`computedColumns.ts`), there are two kinds:
//
// - the app's own (`BUILT_IN_COMPARISONS`), defined here, in code, for the
//   tables the app ships with. The user can't rename or remove one, but can
//   write their own condition for it: a row of the same table and name, whose
//   condition stands in place of the app's until it's null or blank again.
// - the user's: every other row.
//
// The app builds a definition for each into the prelude, ahead of the user's
// own prelude (`comparisonPrelude`), where a definition of the same name in the
// user's prelude still wins.

import type { CustomComparisonRow } from "api-client";
import { availableIdentifier } from "./identifiers";
import { type SchemaTable, rowTable, tableRef } from "./schema";
import { fromSource, joinMapped, type Mapped } from "./sourceMap";

/** The variable a comparison's condition gets the value compared in. */
export const COMPARED_VARIABLE = "@x";

/** One of the app's own custom comparisons. */
export interface BuiltInComparison {
  name: string;
  expression: string;
}

/** The custom comparisons the app defines, by table, in the order a table's
 * list shows them. The app ships with these tables, but a user can drop or
 * rename them, so a table here that the database hasn't got is passed over. */
export const BUILT_IN_COMPARISONS: Readonly<
  Record<string, readonly BuiltInComparison[]>
> = {
  track: [{ name: "artist", expression: "++#artist{name:@x}" }],
  // An album and an artist are tied two ways, through its tracks' credits
  // and through its ignored album's artists (migration 0022), so `#artist`
  // from an album and `#album` from an artist are ambiguous: these go
  // through `#credit`, which only the tracks reach.
  album: [
    { name: "artist", expression: "++#credit{artist.name:@x}" },
    { name: "tag", expression: "++#tag{name:@x}" },
  ],
  artist: [
    { name: "album", expression: "++#credit{track.album.title:@x}" },
    { name: "tag", expression: "++#tag{name:@x}" },
  ],
  play: [{ name: "artist", expression: "++#artist{name:@x}" }],
};

/** The app's own custom comparisons on `table`. */
export function builtInComparisons(
  table: string,
): readonly BuiltInComparison[] {
  return Object.hasOwn(BUILT_IN_COMPARISONS, table)
    ? BUILT_IN_COMPARISONS[table]
    : [];
}

/** The app's condition for its comparison `name` on `table`, or null when it
 * has no such comparison: the comparison, if there is one, is the user's. */
export function builtInComparison(table: string, name: string): string | null {
  return (
    builtInComparisons(table).find((c) => c.name === name)?.expression ?? null
  );
}

/** Whether `text` is a condition to go by, rather than none: null and blank
 * both leave one of the app's comparisons to the app's condition, and one of
 * the user's with no definition at all. */
export function hasCondition(text: string | null | undefined): text is string {
  return text != null && text.trim() !== "";
}

/** One custom comparison on a table, as it stands. */
export interface CustomComparison {
  table: string;
  name: string;
  /** The condition in force: the user's, or the app's. Blank for one of the
   * user's they haven't written yet, which defines nothing. */
  expression: string;
  /** Whether it's one of the app's own. */
  builtIn: boolean;
  /** Whether the user's condition is the one in force. */
  customized: boolean;
}

/** The row holding the user's side of `table`'s comparison `name`. */
export function findComparisonRow(
  rows: readonly CustomComparisonRow[],
  table: string,
  name: string,
): CustomComparisonRow | undefined {
  return rows.find((row) => rowTable(row) === table && row.name === name);
}

/** The custom comparisons on `table`: the app's, as they're listed here, then
 * the user's, by name. */
export function tableComparisons(
  table: string,
  rows: readonly CustomComparisonRow[],
): CustomComparison[] {
  const own = rows.filter((row) => rowTable(row) === table);
  const builtIn = builtInComparisons(table);
  const comparisons: CustomComparison[] = builtIn.map((c) => {
    const stored = own.find((row) => row.name === c.name)?.expression;
    const customized = hasCondition(stored);
    return {
      table,
      name: c.name,
      expression: customized ? stored : c.expression,
      builtIn: true,
      customized,
    };
  });
  const users = own
    .filter((row) => !builtIn.some((c) => c.name === row.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const row of users) {
    comparisons.push({
      table,
      name: row.name,
      expression: row.expression ?? "",
      builtIn: false,
      customized: hasCondition(row.expression),
    });
  }
  return comparisons;
}

/** Whether the user's condition is the one in force for `table`'s comparison
 * `name`. */
export function isComparisonCustomized(
  rows: readonly CustomComparisonRow[],
  table: string,
  name: string,
): boolean {
  return hasCondition(findComparisonRow(rows, table, name)?.expression);
}

// ── Names ───────────────────────────────────────────────────────────────────

/** What a custom comparison is called until the user names it. */
export const DEFAULT_COMPARISON_NAME = "comparison";

/** The names a new comparison on `table` can't take, lowercased: its other
 * comparisons, the app's included. `except` leaves one out: the one being
 * renamed. */
export function takenComparisonNames(
  rows: readonly CustomComparisonRow[],
  table: string,
  except?: string,
): Set<string> {
  const taken = new Set<string>();
  for (const c of tableComparisons(table, rows)) {
    if (c.name !== except) taken.add(c.name.toLowerCase());
  }
  return taken;
}

/** The name a comparison gets for what the user `typed`: an identifier a
 * filter can say, numbered when it's `taken` (`artist_2`). */
export function availableComparisonName(
  typed: string,
  taken: ReadonlySet<string>,
): string {
  return availableIdentifier(typed, taken, DEFAULT_COMPARISON_NAME);
}

// ── Definitions ─────────────────────────────────────────────────────────────

/** The head of a comparison's definition, up to its condition:
 * `#track.artist:@x = `. */
export function comparisonDefinitionHead(table: string, name: string): string {
  return `#${table}.${name}:${COMPARED_VARIABLE} = `;
}

/** A comparison's definition, its condition traced to the comparison's
 * editor. */
export function comparisonDefinition(
  table: string,
  name: string,
  expression: string,
): Mapped {
  return joinMapped(
    [
      comparisonDefinitionHead(table, name),
      fromSource(expression, { kind: "customComparison", table, name }),
    ],
    "",
  );
}

/** The definitions of every comparison that has a condition, for the tables
 * the database has, in the schema's order. `except` leaves one out: the one an
 * editor is checking on its own. */
export function comparisonPrelude(
  tables: readonly SchemaTable[],
  rows: readonly CustomComparisonRow[],
  except?: { table: string; name: string },
): Mapped {
  const parts: Mapped[] = [];
  for (const { name: table } of tables) {
    for (const c of tableComparisons(table, rows)) {
      if (except?.table === table && except.name === c.name) continue;
      if (!hasCondition(c.expression)) continue;
      parts.push(comparisonDefinition(table, c.name, c.expression));
    }
  }
  return joinMapped(parts, "\n");
}

/** The rows after the user's condition for `table`'s comparison `name` becomes
 * `expression` — a new array, with a row made for a comparison that had none
 * (one of the app's, customized for the first time). */
export function withComparisonExpression(
  rows: readonly CustomComparisonRow[],
  table: string,
  name: string,
  expression: string | null,
): CustomComparisonRow[] {
  const at = rows.findIndex(
    (row) => rowTable(row) === table && row.name === name,
  );
  if (at === -1) {
    return [...rows, { ...tableRef(table), name, expression }];
  }
  const next = [...rows];
  next[at] = { ...next[at], expression };
  return next;
}
