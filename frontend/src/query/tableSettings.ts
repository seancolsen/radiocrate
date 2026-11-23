// What the user has customized about each table as a whole — `metadata.table` in
// the database — and what the app does with it. Pure, like the rest of `query/`:
// the app store holds the rows, and everything that lists tables or compiles a
// query goes through these.
//
// A table with no row behaves as in a database that has never been customized:
// listed, in name order, with the app's own defaults for its Querydown. A row can
// also name a table that no longer exists, which nothing here ever asks about.
//
// Two of a table's settings are Querydown definitions the compiler looks for by
// name, which the app builds into the prelude, ahead of the user's own
// (`tablePrelude`):
//
//   #<table>.__querydown_default_text_search:@x = <expression>
//     what a bare string in a filter searches the table's records with;
//   #<table>.__querydown_linked_record_comparison:@x = <expression>
//     what comparing a link to the table with a value compares (`rating:2` for
//     `rating.value:2`).
//
// The user writes only the expression. One they haven't written — or have left
// blank — is the app's default for the table (`BUILT_IN_TABLE_QUERYDOWN`), and a
// table with neither has no definition at all. The prelude's definitions come
// before the user's prelude, and a later definition wins, so a prelude written
// before these settings existed goes on working as it did.
//
// Each table's computed columns (`computedColumns.ts`) go ahead of them, and
// its custom comparisons (`customComparisons.ts`) after: `generatedPrelude` is
// all of it, and with the
// user's prelude after it (`composePrelude`), everything a query is compiled
// under. The app has no prelude of its own beyond that.
//
// The other two are the record picker's sorting and display on the table: what
// it opens with, from then on edited in it or on the Data structure page, and
// generated from the schema until they are (`embeddedRecord.ts`).

import type {
  ComputedColumnRow,
  CustomComparisonRow,
  TableMetadataRow,
  TableOrder,
  TableQuerydownSetting,
} from "api-client";
import { computedPrelude } from "./computedColumns";
import { comparisonPrelude } from "./customComparisons";
import type { Section } from "./definition";
import type { SchemaTable } from "./schema";
import {
  CURRENT_SCHEMA,
  schemaLinks,
  qualifiedTableName,
  splitTableName,
  tableRef,
} from "./schema";
import { byOrder, moveOrders } from "./sortKeys";
import { fromSource, joinMapped, unmapped, type Mapped } from "./sourceMap";

/** What's customized about one table. Every Querydown setting is the user's
 * text as they wrote it, or null to go by the app's default. */
export interface TableSettings {
  visible: boolean;
  /** The table's sort key, or null until the tables are rearranged. */
  order: number | null;
  defaultTextSearch: string | null;
  linkedRecordComparison: string | null;
  recordPickerSorting: string | null;
  recordPickerDisplay: string | null;
}

/** Every table's customizations, by table name. */
export type TableSettingsByTable = Readonly<Record<string, TableSettings>>;

/** A table nothing has been customized about yet. */
export function defaultTableSettings(): TableSettings {
  return {
    visible: true,
    order: null,
    defaultTextSearch: null,
    linkedRecordComparison: null,
    recordPickerSorting: null,
    recordPickerDisplay: null,
  };
}

/** The settings of a table with none — one shared object, so a selector falling
 * back to it returns the same reference every time. */
export const NO_TABLE_SETTINGS: TableSettings = Object.freeze(
  defaultTableSettings(),
);

/** The rows `metadata.table.list` returns, keyed by table. */
export function groupTableSettings(
  rows: readonly TableMetadataRow[],
): TableSettingsByTable {
  const tables: Record<string, TableSettings> = {};
  for (const { schemaName, tableName, ...settings } of rows) {
    tables[qualifiedTableName(schemaName, tableName)] = settings;
  }
  return tables;
}

// ── Querydown settings ──────────────────────────────────────────────────────

/** A table's settings that hold Querydown. */
export type QuerydownSetting = TableQuerydownSetting;

/** Every one of them. */
export const QUERYDOWN_SETTINGS: readonly QuerydownSetting[] = [
  "defaultTextSearch",
  "linkedRecordComparison",
  "recordPickerSorting",
  "recordPickerDisplay",
];

/** The two the app builds into the prelude. */
export type PreludeSetting = "defaultTextSearch" | "linkedRecordComparison";

/** The two the record picker opens with. */
export type PickerSetting = "recordPickerSorting" | "recordPickerDisplay";

export const PRELUDE_SETTINGS: readonly PreludeSetting[] = [
  "defaultTextSearch",
  "linkedRecordComparison",
];

/** The name the compiler looks for each prelude setting's definition by. */
export const PRELUDE_MEMBERS: Record<PreludeSetting, string> = {
  defaultTextSearch: "__querydown_default_text_search",
  linkedRecordComparison: "__querydown_linked_record_comparison",
};

/** The variable a prelude setting's expression gets its value in. */
export const SETTING_VARIABLE = "@x";

/** What each prelude setting is called on the page, and in a problem's place. */
export const PRELUDE_SETTING_LABELS: Record<PreludeSetting, string> = {
  defaultTextSearch: "Text search",
  linkedRecordComparison: "Linked record comparison",
};

/** The record picker's section each picker setting holds. */
export const PICKER_SETTINGS: Record<"sort" | "display", PickerSetting> = {
  sort: "recordPickerSorting",
  display: "recordPickerDisplay",
};

/** The prelude settings of the tables the app knows. The app ships with these
 * tables, but a user can drop or rename them, so a table here that the database
 * hasn't got is passed over. */
export const BUILT_IN_TABLE_QUERYDOWN: Readonly<
  Record<string, Partial<Record<PreludeSetting, string>>>
> = {
  track: {
    defaultTextSearch: `[
  title:@x
  album.title:@x
  ++#artist{name:@x}
  ++#tag{name:@x}
]`,
    linkedRecordComparison: "title:@x",
  },
  album: {
    defaultTextSearch: "[title:@x ++#artist{name:@x}]",
    linkedRecordComparison: "title:@x",
  },
  artist: { linkedRecordComparison: "name:@x" },
  file: { linkedRecordComparison: "path:@x" },
  play: {
    defaultTextSearch: "track[title:@x album.title:@x ++#artist{name:@x}]",
  },
  rating: {
    defaultTextSearch: "[symbol:@x description:@x]",
    linkedRecordComparison: "value:@x",
  },
  role: { linkedRecordComparison: "name:@x" },
  tag: { linkedRecordComparison: "name:@x" },
};

/** The app's default for a table's prelude setting, if it has one. */
export function builtInSetting(
  table: string,
  setting: PreludeSetting,
): string | null {
  return Object.hasOwn(BUILT_IN_TABLE_QUERYDOWN, table)
    ? (BUILT_IN_TABLE_QUERYDOWN[table][setting] ?? null)
    : null;
}

/** Whether the user's text for a prelude setting stands, rather than the
 * default: null and blank both go by the default. */
export function isCustomized(text: string | null | undefined): text is string {
  return text != null && text.trim() !== "";
}

/** The expression a table's prelude setting is in force with: the user's, or
 * the app's default, or none. */
export function effectiveSetting(
  settings: TableSettings | undefined,
  table: string,
  setting: PreludeSetting,
): string | null {
  const own = settings?.[setting];
  return isCustomized(own) ? own : builtInSetting(table, setting);
}

/** The head of a prelude setting's definition, up to its expression:
 * `#track.__querydown_default_text_search:@x = `. */
export function settingDefinitionHead(
  table: string,
  setting: PreludeSetting,
): string {
  return `#${table}.${PRELUDE_MEMBERS[setting]}:${SETTING_VARIABLE} = `;
}

/** A prelude setting's definition, its expression traced to the setting's
 * editor. */
export function settingDefinition(
  table: string,
  setting: PreludeSetting,
  expression: string,
): Mapped {
  return joinMapped(
    [
      settingDefinitionHead(table, setting),
      fromSource(expression, { kind: "tableSetting", table, setting }),
    ],
    "",
  );
}

/** The definitions built from the tables' prelude settings, for the tables
 * the database has, in the schema's order. `except` leaves one setting out: the
 * one an editor is checking on its own. */
export function tablePrelude(
  tables: readonly SchemaTable[],
  settings: TableSettingsByTable,
  except?: { table: string; setting: PreludeSetting },
): Mapped {
  const parts: (Mapped | string)[] = [];
  for (const { name } of tables) {
    for (const setting of PRELUDE_SETTINGS) {
      if (except?.table === name && except.setting === setting) continue;
      const expression = effectiveSetting(settings[name], name, setting);
      if (expression !== null) {
        parts.push(settingDefinition(name, setting, expression));
      }
    }
  }
  return joinMapped(parts, "\n");
}

/** One of the definitions the app builds with an editor of its own: a table's
 * prelude setting, a computed column, or a custom comparison. */
export type GeneratedDefinition =
  | { table: string; setting: PreludeSetting }
  | { table: string; computedColumn: string }
  | { table: string; comparison: string };

/** Everything the app defines ahead of the user's prelude: every table's
 * computed columns (`computedColumns.ts`), then what's built from the tables'
 * settings (`tablePrelude`), then their custom comparisons
 * (`customComparisons.ts`). The order between them is only for reading — a
 * definition can use one that comes after it. `except` leaves one definition
 * out: the one an editor is checking on its own. */
export function generatedPrelude(
  tables: readonly SchemaTable[],
  settings: TableSettingsByTable,
  computed: readonly ComputedColumnRow[],
  comparisons: readonly CustomComparisonRow[],
  except?: GeneratedDefinition,
): Mapped {
  const columns = computedPrelude(
    tables,
    computed,
    except && "computedColumn" in except
      ? { table: except.table, name: except.computedColumn }
      : undefined,
  );
  const fromTables = tablePrelude(
    tables,
    settings,
    except && "setting" in except ? except : undefined,
  );
  const compared = comparisonPrelude(
    tables,
    comparisons,
    except && "comparison" in except
      ? { table: except.table, name: except.comparison }
      : undefined,
  );
  return joinMapped(
    [columns, fromTables, compared].filter((part) => part.text !== ""),
    "\n",
  );
}

/** The prelude in force: the app's definitions (`generatedPrelude`), then the
 * user's prelude, each traced to where it's edited. */
export function composePrelude(generated: Mapped, user: string): Mapped {
  const own = fromSource(user, { kind: "prelude" });
  if (generated.text === "") return own;
  if (user === "") return generated;
  return joinMapped([generated, own], "\n");
}

/** A prelude, as the compile path takes it: the user's text alone (all a test
 * needs), or the whole prelude in force, traced. */
export type Prelude = string | Mapped;

/** `prelude` as traced text: a bare string is the user's prelude. */
export function preludeMapped(prelude: Prelude): Mapped {
  return typeof prelude === "string"
    ? fromSource(prelude, { kind: "prelude" })
    : prelude;
}

export function preludeText(prelude: Prelude): string {
  return typeof prelude === "string" ? prelude : prelude.text;
}

/** How a prelude setting's expression is checked as it's typed: compiled into
 * the definitions of a query that uses it.
 *
 * - The text search: a query on the table searching it for a string
 *   (`#track "test"`).
 * - The linked record comparison: a query on a table linking to it, comparing
 *   that link with a string (`#track album:"test"`). A table nothing links to
 *   has no comparison to use, so only the expression's syntax is checked, on a
 *   query of the table itself.
 *
 * The definition goes after `prelude`, so that it's the one the query uses even
 * where the user's prelude defines one of its own, and so that it can use what
 * the prelude defines. */
export function settingCheck(
  tables: readonly SchemaTable[],
  table: string,
  setting: PreludeSetting,
  expression: string,
  prelude: Prelude,
): { definitions: Mapped; base: string; filter: string; section: Section } {
  const definitions = joinMapped(
    [preludeMapped(prelude), settingDefinition(table, setting, expression)],
    "\n",
  );
  if (setting === "defaultTextSearch") {
    return { definitions, base: table, filter: '"test"', section: "filter" };
  }
  const link = schemaLinks(tables).find((l) => l.toTable === table);
  return link
    ? {
        definitions,
        base: link.fromTable,
        filter: `${link.fromColumn}:"test"`,
        section: "filter",
      }
    : { definitions, base: table, filter: "", section: "filter" };
}

/** An empty prelude, traced to nothing. */
export const NO_PRELUDE: Mapped = unmapped("");

// ── Hiding and ordering ─────────────────────────────────────────────────────

export function isTableHidden(
  settings: TableSettingsByTable,
  table: string,
): boolean {
  return settings[table]?.visible === false;
}

/** Whether any table is hidden. */
export function anyTableHidden(settings: TableSettingsByTable): boolean {
  return Object.values(settings).some((table) => !table.visible);
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

/** `items`, tables or things standing for them, in the order the user has
 * arranged them: those with a sort key by that key, then the rest by name. */
export function orderTables<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  settings: TableSettingsByTable,
): T[] {
  const byDefault = [...items].sort((a, b) => byName(nameOf(a), nameOf(b)));
  return byOrder(byDefault, (item) => settings[nameOf(item)]?.order);
}

/** The tables a list of them shows, in the order it shows them: those the user
 * hasn't hidden (all of them, with `showHidden`), arranged. `keep` names a table
 * that's listed even while hidden: the one a choice already rests on, which
 * would otherwise leave the choice showing nothing chosen. */
export function listedTables(
  tables: readonly SchemaTable[],
  settings: TableSettingsByTable,
  opts: { showHidden?: boolean; keep?: string | null } = {},
): SchemaTable[] {
  const shown = opts.showHidden
    ? tables
    : tables.filter(
        (t) => t.name === opts.keep || !isTableHidden(settings, t.name),
      );
  return orderTables(shown, (t) => t.name, settings);
}

/** One schema's share of a list of tables. */
export interface SchemaGroup<T> {
  /** The schema's name: `main` for the app's own tables. */
  schema: string;
  items: T[];
}

/** `items`, tables or things standing for them, split by schema, each schema's
 * in the order they came in: the current schema's first — always there, if
 * empty, as the list's top level — then each other schema's, by name. What a
 * list of tables shows the other schemas' under, after the app's own. */
export function groupBySchema<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
): SchemaGroup<T>[] {
  const bySchema = new Map<string, T[]>([[CURRENT_SCHEMA, []]]);
  for (const item of items) {
    const { schema } = splitTableName(nameOf(item));
    const list = bySchema.get(schema);
    if (list) list.push(item);
    else bySchema.set(schema, [item]);
  }
  return [...bySchema]
    .map(([schema, items]) => ({ schema, items }))
    .sort((a, b) =>
      a.schema === CURRENT_SCHEMA
        ? -1
        : b.schema === CURRENT_SCHEMA
          ? 1
          : byName(a.schema, b.schema),
    );
}

/** The sort keys that put table `moved` between the tables shown just above and
 * just below where it was dropped (see `moveOrders`). `names` is every table
 * the list could show, hidden ones included. */
export function tableMoveOrders(
  names: readonly string[],
  settings: TableSettingsByTable,
  moved: string,
  above: string | undefined,
  below: string | undefined,
): TableOrder[] {
  const byDefault = [...names].sort(byName);
  return moveOrders(
    byDefault,
    (name) => name,
    (name) => settings[name]?.order,
    moved,
    above,
    below,
  ).map(({ item, order }) => ({ ...tableRef(item), order }));
}
