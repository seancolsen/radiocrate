// Computed columns: Querydown expressions named as columns of a table, so that
// `lastplay` on a track is `#play.timestamp%max` wherever a query says it. Each
// is a field of its table's record editor form too, showing what it computes
// for the record. Pure, like the rest of `query/`: the app store holds the
// user's rows (`metadata.computed_column` in the database) and writes them.
//
// There are two kinds:
//
// - the app's own (`BUILT_IN_COMPUTED_COLUMNS`), defined here, in code, for the
//   tables the app ships with. The user can't rename or remove one, but can
//   write their own expression for it: a row of the same table and name, whose
//   expression stands in place of the app's until it's null or blank again.
// - the user's: every other row.
//
// The app builds a definition for each into the prelude, ahead of the user's
// own prelude (`computedPrelude`):
//
//   #<table>.<name> = <expression>
//
// The user writes only the name and the expression. Because the app's columns
// are kept apart from the user's, and from the user's prelude, a release can
// add one, or change what one computes, without touching anything the user has
// written.
//
// A field's metadata — where it sits in the form, whether it's hidden — is
// keyed by the column's name (`fieldRef`), so renaming a column renames that
// key with it: the store's `renameComputedColumn` here, and the backend's
// `metadata.computed_column.rename` in the database.

import type { ComputedColumnRow } from "api-client";
import type { ComputedField } from "./recordForm";
import type { SchemaTable } from "./schema";
import { fromSource, joinMapped, type Mapped } from "./sourceMap";

/** One of the app's own computed columns. */
export interface BuiltInComputedColumn {
  name: string;
  expression: string;
}

/** The computed columns the app defines, by table, in the order a table's form
 * lists them. The app ships with these tables, but a user can drop or rename
 * them, so a table here that the database hasn't got is passed over. */
export const BUILT_IN_COMPUTED_COLUMNS: Readonly<
  Record<string, readonly BuiltInComputedColumn[]>
> = {
  track: [
    { name: "firstplay", expression: "#play.timestamp%min" },
    { name: "lastplay", expression: "#play.timestamp%max" },
    {
      name: "artists",
      expression: "#credit.artist.name%list_all(\\\\order \\\\artist.name)",
    },
    { name: "year", expression: "album.year" },
    { name: "added", expression: "file.added" },
    { name: "duration", expression: "file.duration" },
    { name: "playcount", expression: "#play" },
    { name: "number", expression: "track_number" },
  ],
};

/** The app's own computed columns of `table`. */
export function builtInComputedColumns(
  table: string,
): readonly BuiltInComputedColumn[] {
  return Object.hasOwn(BUILT_IN_COMPUTED_COLUMNS, table)
    ? BUILT_IN_COMPUTED_COLUMNS[table]
    : [];
}

/** The app's expression for its computed column `name` of `table`, or null
 * when it has no such column: the column, if there is one, is the user's. */
export function builtInExpression(table: string, name: string): string | null {
  return (
    builtInComputedColumns(table).find((column) => column.name === name)
      ?.expression ?? null
  );
}

/** Whether `text` is an expression to go by, rather than none: null and blank
 * both leave one of the app's columns to the app's expression, and one of the
 * user's with no definition at all. */
export function hasExpression(text: string | null | undefined): text is string {
  return text != null && text.trim() !== "";
}

/** One computed column of a table, as it stands. */
export interface ComputedColumn {
  table: string;
  name: string;
  /** The expression in force: the user's, or the app's. Blank for a column of
   * the user's they haven't written one for yet, which defines nothing. */
  expression: string;
  /** Whether it's one of the app's own. */
  builtIn: boolean;
  /** Whether the user's expression is the one in force. Always true of a column
   * of the user's that has one. */
  customized: boolean;
}

/** The row holding the user's side of `table`'s computed column `name`. */
export function findComputedRow(
  rows: readonly ComputedColumnRow[],
  table: string,
  name: string,
): ComputedColumnRow | undefined {
  return rows.find((row) => row.tableName === table && row.name === name);
}

/** The computed columns of `table`, in their default order: the app's, as
 * they're listed here, then the user's, by name. */
export function tableComputedColumns(
  table: string,
  rows: readonly ComputedColumnRow[],
): ComputedColumn[] {
  const own = rows.filter((row) => row.tableName === table);
  const builtIn = builtInComputedColumns(table);
  const columns: ComputedColumn[] = builtIn.map((column) => {
    const stored = own.find((row) => row.name === column.name)?.expression;
    const customized = hasExpression(stored);
    return {
      table,
      name: column.name,
      expression: customized ? stored : column.expression,
      builtIn: true,
      customized,
    };
  });
  const users = own
    .filter((row) => !builtIn.some((column) => column.name === row.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const row of users) {
    columns.push({
      table,
      name: row.name,
      expression: row.expression ?? "",
      builtIn: false,
      customized: hasExpression(row.expression),
    });
  }
  return columns;
}

/** Whether the user's expression is the one in force for `table`'s computed
 * column `name`: they've written one, and not left it blank. */
export function isComputedCustomized(
  rows: readonly ComputedColumnRow[],
  table: string,
  name: string,
): boolean {
  return hasExpression(findComputedRow(rows, table, name)?.expression);
}

/** Whether `table`'s computed column `name` has an expression to compute
 * anything with: the user's, or the app's. */
export function isComputedDefined(
  rows: readonly ComputedColumnRow[],
  table: string,
  name: string,
): boolean {
  return (
    isComputedCustomized(rows, table, name) ||
    builtInExpression(table, name) !== null
  );
}

/** One computed column of a table, by name. */
export function computedColumn(
  table: string,
  rows: readonly ComputedColumnRow[],
  name: string,
): ComputedColumn | undefined {
  return tableComputedColumns(table, rows).find(
    (column) => column.name === name,
  );
}

// ── Fields ──────────────────────────────────────────────────────────────────

/** The key a computed column's field goes by within a record's form. A column
 * is named like an identifier, a multi-record field's key starts with `#` and
 * a contextual query's with `@`, so this can't collide with any of them. */
export function computedFieldKey(name: string): string {
  return `=${name}`;
}

/** The fields `table`'s computed columns add to the form of one of its
 * records, in their default order. None for a table the schema hasn't got. */
export function computedFields(
  tables: readonly SchemaTable[],
  table: string,
  rows: readonly ComputedColumnRow[],
): ComputedField[] {
  if (!tables.some((t) => t.name === table)) return [];
  return tableComputedColumns(table, rows).map((column) => ({
    kind: "computed",
    key: computedFieldKey(column.name),
    label: column.name,
    name: column.name,
    builtIn: column.builtIn,
  }));
}

// ── Names ───────────────────────────────────────────────────────────────────

/** What a computed column is called until the user names it. */
export const DEFAULT_COMPUTED_COLUMN_NAME = "computed";

/** `typed` as a name a definition can be written with: Querydown's unquoted
 * identifier, which begins with a letter or an underscore and holds only
 * letters, digits and underscores. Anything else in it becomes an underscore
 * ("last play" is `last_play`), and nothing at all is the default name. */
export function legalComputedName(typed: string): string {
  const name = typed
    .split(/[^A-Za-z0-9_]+/)
    .filter((part) => part !== "")
    .join("_");
  if (name === "") return DEFAULT_COMPUTED_COLUMN_NAME;
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** The names a new computed column of `table` can't take, lowercased: its real
 * columns — one of which a computed column of the same name would never be
 * reached past — and its other computed columns, the app's included. `except`
 * leaves one computed column out: the one being renamed. */
export function takenComputedNames(
  tables: readonly SchemaTable[],
  rows: readonly ComputedColumnRow[],
  table: string,
  except?: string,
): Set<string> {
  const taken = new Set<string>();
  for (const column of tables.find((t) => t.name === table)?.columns ?? []) {
    taken.add(column.name.toLowerCase());
  }
  for (const column of tableComputedColumns(table, rows)) {
    if (column.name !== except) taken.add(column.name.toLowerCase());
  }
  return taken;
}

/** The name a computed column gets for what the user `typed`: that, made legal
 * (`legalComputedName`), and numbered when it's `taken` (`year_2`). */
export function availableComputedName(
  typed: string,
  taken: ReadonlySet<string>,
): string {
  const base = legalComputedName(typed);
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// ── Definitions ─────────────────────────────────────────────────────────────

/** The head of a computed column's definition, up to its expression:
 * `#track.lastplay = `. */
export function computedDefinitionHead(table: string, name: string): string {
  return `#${table}.${name} = `;
}

/** A computed column's definition, its expression traced to the column's
 * editor. */
export function computedDefinition(
  table: string,
  name: string,
  expression: string,
): Mapped {
  return joinMapped(
    [
      computedDefinitionHead(table, name),
      fromSource(expression, { kind: "computedColumn", table, name }),
    ],
    "",
  );
}

/** The definitions of every computed column that has an expression, for the
 * tables the database has, in the schema's order. `except` leaves one out: the
 * one an editor is checking on its own. */
export function computedPrelude(
  tables: readonly SchemaTable[],
  rows: readonly ComputedColumnRow[],
  except?: { table: string; name: string },
): Mapped {
  const parts: Mapped[] = [];
  for (const { name: table } of tables) {
    for (const column of tableComputedColumns(table, rows)) {
      if (except?.table === table && except.name === column.name) continue;
      if (!hasExpression(column.expression)) continue;
      parts.push(computedDefinition(table, column.name, column.expression));
    }
  }
  return joinMapped(parts, "\n");
}

/** The rows after the user's expression for `table`'s computed column `name`
 * becomes `expression` — a new array, with a row made for a column that had
 * none (one of the app's, customized for the first time). */
export function withComputedExpression(
  rows: readonly ComputedColumnRow[],
  table: string,
  name: string,
  expression: string | null,
): ComputedColumnRow[] {
  const at = rows.findIndex(
    (row) => row.tableName === table && row.name === name,
  );
  if (at === -1) return [...rows, { tableName: table, name, expression }];
  const next = [...rows];
  next[at] = { ...next[at], expression };
  return next;
}

// ── The record editor's values ──────────────────────────────────────────────

/** The display section loading computed columns `names` for some records: the
 * records' key columns, to match each row to its record by, then the columns. */
export function computedDisplay(
  keyColumns: readonly string[],
  names: readonly string[],
): string {
  return [...keyColumns, ...names].map((name) => `$${name}`).join(" ");
}
