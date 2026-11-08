// Contextual queries: queries the user writes to run in the context of one record,
// shown in the record editor as fields of every record of one table
// (`contextual_query` in the database, migration 0012). The query reaches the
// record it's shown on through `@id`, which is defined as the record's primary
// key ahead of running it — so `artist:=@id`, written on a query of credits shown
// on artists, lists the artist's credits.
//
// Pure, like the rest of `query/`: the app store holds the queries and writes
// them, and the record form runs them (`stores/recordForm/model.ts`).

import type { Preset } from "api-client";
import {
  assemble,
  emptyDefinition,
  toFullQuery,
  type QueryDefinition,
  type Section,
} from "./definition";
import { defaultEmbedSections, embedSpec } from "./embeddedRecord";
import type { ContextQueryField, RecordQuery } from "./recordForm";
import { identifyingColumns, primaryKey, type SchemaTable } from "./schema";

/** One contextual query, as the app holds it. */
export interface ContextualQuery {
  id: string;
  /** The table on whose records the query shows. */
  tableName: string;
  /** The field's label. */
  name: string;
  /** What it runs. Its base is the table it lists, not {@link tableName}. */
  definition: QueryDefinition;
}

/** What a contextual query is called until the user names it. */
export const DEFAULT_CONTEXTUAL_QUERY_NAME = "query";

/** The variable the query reaches its record through. */
export const ID_VARIABLE = "@id";

/** The key a contextual query's field goes by within a record's form. Columns are
 * named like identifiers and a multi-record field's key starts with `#`, so this
 * can't collide with either. */
export function contextFieldKey(queryId: string): string {
  return `@${queryId}`;
}

/** The column `@id` holds the value of for a record of `table`: its single-column
 * primary key. Undefined for a table without one, whose records can't have
 * contextual queries — there would be no one value for `@id` to be. */
export function contextKeyColumn(
  tables: readonly SchemaTable[],
  table: string,
): string | undefined {
  const found = tables.find((t) => t.name === table);
  return found && primaryKey(found);
}

/** The fields `queries` add to the form of a record of `table`, in their default
 * order: by name. None for a table whose records can't have any. */
export function contextFields(
  tables: readonly SchemaTable[],
  table: string,
  queries: readonly ContextualQuery[],
): ContextQueryField[] {
  if (contextKeyColumn(tables, table) === undefined) return [];
  return queries
    .filter((query) => query.tableName === table)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((query) => {
      const base = query.definition.base.trim();
      const listed = tables.find((t) => t.name === base);
      return {
        kind: "contextQuery",
        key: contextFieldKey(query.id),
        label: query.name,
        queryId: query.id,
        table: base,
        keyColumns: listed ? identifyingColumns(listed) : [],
      };
    });
}

/** The tables a contextual query can list: those whose records can be told apart,
 * which is what lets each of them open into its own form. */
export function listableTables(
  tables: readonly SchemaTable[],
): readonly SchemaTable[] {
  return tables.filter((t) => identifyingColumns(t).length > 0);
}

/** `value` as a single-quoted Querydown string, backslash-escaped. */
function quoteSingle(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** The definitions a contextual query runs under, on the record whose key is
 * `value`: the user's prelude, then `@id`. Defined last, so that it wins over a
 * prelude defining an `@id` of its own. */
export function contextDefinitions(prelude: string, value: string): string {
  const id = `${ID_VARIABLE} = ${quoteSingle(value)}`;
  return prelude.trim() === "" ? id : `${prelude}\n${id}`;
}

/** Whether a contextual query has a filter to run with. One without would list
 * every record of its table, which is never what a query about one record wants,
 * and could be a great many — so it doesn't run at all. */
export function isRunnable(def: QueryDefinition): boolean {
  return def.filter.custom.trim() !== "" || def.filter.presets.length > 0;
}

/** The Querydown its editor shows for one section: the filter's own conditions,
 * or a sort or display written out. A section holding a preset shows empty —
 * writing replaces it. */
export function sectionText(def: QueryDefinition, section: Section): string {
  if (section === "filter") return def.filter.custom;
  const content = def[section];
  return "custom" in content ? content.custom : "";
}

/** `def` with one section's Querydown replaced by `text`. */
export function withSectionText(
  def: QueryDefinition,
  section: Section,
  text: string,
): QueryDefinition {
  if (section === "filter") {
    return { ...def, filter: { ...def.filter, custom: text } };
  }
  return { ...def, [section]: { custom: text } };
}

/** A new contextual query's definition on `base`: no filter, which is the user's
 * to write, and the sort and display a multi-record field of that table would
 * start from. */
export function seedDefinition(
  tables: readonly SchemaTable[],
  base: string,
): QueryDefinition {
  const table = tables.find((t) => t.name === base);
  const sections = defaultEmbedSections(
    embedSpec(tables, base),
    table ? identifyingColumns(table) : [],
  );
  return {
    ...emptyDefinition(),
    base,
    sort: { custom: sections.sorting },
    display: { custom: sections.display },
  };
}

/** The query listing a contextual query's records: its own filter and sort, with
 * the key of each record displayed ahead of what the query displays — which is
 * what each row's embedded record shows — so the row can be opened into the
 * record's form. A query displaying nothing shows `fallbackDisplay`, which is what
 * an embedded record of that table shows by default.
 *
 * The result's columns are positional: `keyColumns` first, then the rest. The
 * preview is on a line of its own, so a `//` comment ending what the user wrote
 * doesn't swallow the keys.
 *
 * Throws, as `assemble` does, on a definition with no base or a dangling preset,
 * and on a full-mode definition, which has no sections to add the keys to. */
export function contextRowsQuery(
  def: QueryDefinition,
  presets: readonly Preset[],
  keyColumns: readonly string[],
  definitions: string,
  fallbackDisplay: string,
): RecordQuery {
  const a = assemble(def, [...presets]);
  if (a.kind === "full") {
    throw new Error("A contextual query can't be a full Querydown query.");
  }
  const display = a.display.text.trim() || fallbackDisplay;
  return {
    base: a.base,
    filter: a.filter.text,
    sort: a.sort.text,
    display: [keyColumns.map((c) => `$${c}`).join(" "), display]
      .filter((part) => part !== "")
      .join("\n"),
    definitions,
  };
}

/** A contextual query as a query of its own, for a query tab: the whole query
 * written out, with `@id` defined ahead of it as the record's key. A tab has no
 * definitions of its own to hold `@id` in, which is why this is one full Querydown
 * query rather than sections. */
export function contextTabDefinition(
  def: QueryDefinition,
  presets: readonly Preset[],
  value: string,
): QueryDefinition {
  return {
    ...emptyDefinition(),
    base: def.base,
    full: `${contextDefinitions("", value)}\n${toFullQuery(def, presets)}`,
  };
}
