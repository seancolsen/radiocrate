// Working out what deleting some records takes.
//
// The database declares no foreign keys, so nothing in it cascades: the links
// between tables are rows of `metadata.relationship`, and the DML API refuses a
// delete that would leave one of them pointing at nothing. So the whole
// deletion is assembled here, before anything is written, and sent as one
// request. This module follows every relationship from the records being
// deleted, in both directions, as far as they lead, loading the records it
// finds as it goes:
//
// - **Records that refer to a deleted record** (a track's credits, an album's
//   tracks). Where the column that refers to it can't be empty, they have to
//   go too. Where it can, there's a choice: delete them, or keep them with the
//   column emptied. Keeping them is the default.
// - **Records a deleted record referred to** (a track's file, its album), where
//   the deletion leaves one with nothing referring to it through that
//   relationship any more: an orphan. That's a choice too: delete it, or leave
//   it. Leaving it is the default.
//
// Each choice is made once per relationship, not per record, and whatever it
// adds to the deletion is followed in turn: tracks deleted with their album
// take their credits along, and may orphan their files.
//
// A plan can also keep the records asked for, emptying them instead
// ({@link PlanOptions}): that's how an album is ignored, its tracks deleted
// while the album stays on record.
//
// Nothing here knows a table by name. The tables and relationships come from
// introspection, so a table the user made is followed like any other, in
// whatever schema it is.
//
// The module is pure but for the loader it's handed, which runs the SQL it
// writes. A planner keeps what it has loaded, so planning again with another
// choice asks only for what that choice newly reaches.

import type { DmlOperation } from "api-client";
import type { RecordKey } from "../query/recordForm";
import {
  dmlTable,
  primaryKey,
  splitTableName,
  type SchemaRelationship,
  type SchemaTable,
} from "../query/schema";

/** A relationship as the planner follows it. */
export interface Relationship extends SchemaRelationship {
  /** What a choice about it is remembered by: the field it starts from, and
   * the table it leads to. */
  id: string;
  /** Whether the referring column can't be empty, so a record that refers to a
   * deleted one has to be deleted with it. */
  required: boolean;
}

/** The user's choices, by {@link Relationship.id}. A relationship that isn't
 * here has its default, which deletes nothing more. */
export interface DeleteChoices {
  /** Whether the records referring to a deleted record through the
   * relationship are deleted, rather than kept with the column emptied. */
  referencing: Readonly<Record<string, boolean>>;
  /** Whether a record the relationship leads to is deleted once nothing refers
   * to it through it. */
  orphans: Readonly<Record<string, boolean>>;
}

export const NO_CHOICES: DeleteChoices = { referencing: {}, orphans: {} };

/** Which of a relationship's two choices: about the records that refer to a
 * deleted record, or about the records left orphaned. */
export type ChoiceKind = keyof DeleteChoices;

/** How a plan treats what it starts from, beyond the choices. */
export interface PlanOptions {
  /** Keep the records asked for, and deal only with what's tied to them. What
   * refers to them through a column that can be emptied is dealt with as
   * their deletion would have it (deleted, or kept with the column emptied, as
   * chosen). What refers to them through a column that can't stays with them,
   * since they stay, and nothing they refer to is left orphaned by them. */
  keep?: boolean;
  /** Records never deleted as orphans, by table, as the values of the column
   * a relationship leads to (its primary key): records something about to be
   * written will refer to, so that they aren't orphans after all. */
  spare?: Readonly<Record<string, ReadonlySet<string>>>;
}

/** A question the planner asks of the database. It comes as data rather than
 * as SQL, so a test can answer it from tables held in memory;
 * {@link planQuerySql} writes the SQL. */
export type PlanQuery =
  | {
      /** The records of `table` that match, as their `columns`. */
      kind: "rows";
      table: string;
      columns: readonly string[];
      where: PlanCondition;
    }
  | {
      /** How many records of `table` hold each of `values` in `column`: a
       * `[value, count]` row for each value that any holds. */
      kind: "counts";
      table: string;
      column: string;
      values: readonly string[];
    };

/** Which records a {@link PlanQuery} wants: those holding one of `values` in
 * `column`, or those `keys` identify. */
export type PlanCondition =
  | { column: string; values: readonly string[] }
  | { keys: readonly RecordKey[] };

/** Answers a {@link PlanQuery}: every cell as text, `null` for NULL. */
export type RowLoader = (
  query: PlanQuery,
) => Promise<readonly (readonly (string | null)[])[]>;

/** One line of the confirmation: some records the deletion reaches through a
 * relationship, and what becomes of them. */
export interface PlanItem {
  /** Stable for a relationship and kind, whatever is chosen. */
  id: string;
  kind: ChoiceKind;
  relationship: Relationship;
  /** The table of the records the line is about: the relationship's source
   * for `referencing`, its target for `orphans`. */
  table: string;
  /** How many records the choice is about. */
  count: number;
  /** Whether they're deleted. */
  checked: boolean;
  /** Whether there's no choice: they refer to a deleted record through a
   * column that can't be emptied. */
  required: boolean;
  /** The {@link id} of the line whose records led here: the line that deletes
   * the records these refer to, or that these would be left without. `null`
   * for a line the records asked for lead to. A line reached from several
   * places is put under the first, in the order the plan met them. The parent
   * is always among the plan's lines, so they make a tree. */
  parent: string | null;
}

/** Records that refer to a deleted record and can be neither deleted nor
 * changed, because their table has nothing that identifies one of them. The
 * deletion can't go ahead while there are any. */
export interface BlockedItem {
  relationship: Relationship;
  count: number;
}

/** A plan's outline: what the confirmation shows. */
export interface DeleteSummary {
  /** The table the deletion started from. */
  table: string;
  /** How many of the records asked for are there to delete. */
  found: number;
  /** How many of those are kept ({@link PlanOptions.keep}): all of them, or
   * none. */
  kept: number;
  items: readonly PlanItem[];
  blocked: readonly BlockedItem[];
  /** How many records are deleted in all, the ones asked for among them
   * unless they're kept. */
  deleteCount: number;
  /** How many records of each table are deleted, by table. */
  deletedByTable: Readonly<Record<string, number>>;
  /** How many records are kept, with a column emptied. */
  updateCount: number;
}

/** Everything a deletion takes. */
export interface DeletePlan {
  summary: DeleteSummary;
  /** The request: one transaction, ordered so that no delete leaves a
   * reference dangling. */
  operations: DmlOperation[];
  /** The key of every deleted record, by table. */
  deleted: ReadonlyMap<string, readonly RecordKey[]>;
  /** The keys of the records asked for that are kept, as the database spells
   * them ({@link PlanOptions.keep}). */
  kept: readonly RecordKey[];
}

export interface DeletePlanner {
  /** Plans the deletion of the records of `table` that `keys` identify, under
   * `choices`. Rejects when a query fails. */
  plan: (
    table: string,
    keys: readonly RecordKey[],
    choices: DeleteChoices,
    options?: PlanOptions,
  ) => Promise<DeletePlan>;
}

/** A row's cells, positioned as its table's {@link TableInfo.columns}. */
type Row = readonly (string | null)[];

/** What the planner needs to know of a table. */
interface TableInfo {
  name: string;
  /** The columns a DML `where` identifies one of its records by. Empty when it
   * has none, which leaves its records beyond reach. */
  key: readonly string[];
  /** The columns loaded for each record: its key, the columns that refer to
   * other tables, and the columns other tables refer to. */
  columns: readonly string[];
  at: ReadonlyMap<string, number>;
  /** The relationships starting from this table. */
  outgoing: Relationship[];
  /** The relationships leading to it. */
  incoming: Relationship[];
}

/** How many values one query's `IN (…)` lists. A deletion that reaches tens of
 * thousands of records asks in several queries rather than one enormous one. */
const CHUNK = 1000;

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function tableSql(name: string): string {
  const { schema, table } = splitTableName(name);
  return `${ident(schema)}.${ident(table)}`;
}

const inList = (column: string, values: readonly string[]): string =>
  `${ident(column)} IN (${values.map(literal).join(", ")})`;

/** The SQL asking `query`. Every column is read as text, which is the form a
 * key goes back to the DML API in, and a value is compared as a literal, which
 * DuckDB casts to the column's type. */
export function planQuerySql(query: PlanQuery): string {
  const table = tableSql(query.table);
  if (query.kind === "counts") {
    const column = ident(query.column);
    return (
      `SELECT ${column}::text AS c0, count(*)::text AS c1 FROM ${table} ` +
      `WHERE ${inList(query.column, query.values)} GROUP BY ${column}`
    );
  }
  const columns = query.columns
    .map((column, i) => `${ident(column)}::text AS c${i}`)
    .join(", ");
  const condition =
    "keys" in query.where
      ? query.where.keys
          .map(
            (key) =>
              `(${key
                .map((p) => `${ident(p.column)} = ${literal(p.value)}`)
                .join(" AND ")})`,
          )
          .join(" OR ")
      : inList(query.where.column, query.where.values);
  return `SELECT ${columns} FROM ${table} WHERE ${condition}`;
}

/** The columns of `table` a DML operation can address one record by: its
 * primary key, or else another unique constraint whose columns all hold a
 * value, which is what the API asks of a `where`. */
function addressingColumns(table: SchemaTable): readonly string[] {
  const pk = primaryKey(table);
  if (pk !== undefined) return [pk];
  const filled = (name: string) =>
    table.columns.some((c) => c.name === name && !c.nullable);
  return table.uniqueConstraints.find((cols) => cols.every(filled)) ?? [];
}

/** The relationships among `tables`, each with its id and whether its column
 * must hold a value. One naming a table or a column that isn't there is left
 * out. */
export function relationshipsAmong(
  tables: readonly SchemaTable[],
  declared: readonly SchemaRelationship[],
): Relationship[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  return declared.flatMap((link) => {
    const column = byName
      .get(link.fromTable)
      ?.columns.find((c) => c.name === link.fromColumn);
    const target = byName.get(link.toTable);
    if (!column || !target?.columns.some((c) => c.name === link.toColumn)) {
      return [];
    }
    return [
      {
        ...link,
        id: `${link.fromTable}.${link.fromColumn}>${link.toTable}`,
        required: !column.nullable,
      },
    ];
  });
}

function tableInfos(
  tables: readonly SchemaTable[],
  relationships: readonly Relationship[],
): Map<string, TableInfo> {
  const infos = new Map<string, TableInfo>();
  for (const table of tables) {
    const outgoing = relationships.filter((r) => r.fromTable === table.name);
    const incoming = relationships.filter((r) => r.toTable === table.name);
    const key = addressingColumns(table);
    const columns = [
      ...new Set([
        ...key,
        ...outgoing.map((r) => r.fromColumn),
        ...incoming.map((r) => r.toColumn),
      ]),
    ];
    infos.set(table.name, {
      name: table.name,
      key,
      columns,
      at: new Map(columns.map((column, i) => [column, i])),
      outgoing,
      incoming,
    });
  }
  return infos;
}

/** A record's identity within its table. */
const signature = (info: TableInfo, row: Row): string =>
  JSON.stringify(info.key.map((column) => row[info.at.get(column)!]));

const recordKey = (info: TableInfo, row: Row): RecordKey =>
  info.key.map((column) => ({
    column,
    value: row[info.at.get(column)!] ?? "",
  }));

const where = (info: TableInfo, row: Row): Record<string, string> =>
  Object.fromEntries(recordKey(info, row).map((p) => [p.column, p.value]));

function* chunks<T>(values: readonly T[]): Generator<readonly T[]> {
  for (let i = 0; i < values.length; i += CHUNK) {
    yield values.slice(i, i + CHUNK);
  }
}

/** `fill`'s value for `key`, made on first asking. */
function ensure<K, V>(map: Map<K, V>, key: K, fill: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = fill();
    map.set(key, value);
  }
  return value;
}

/** A planner over `tables` (every schema's) and the relationships declared
 * among them, loading through `load`. */
export function createDeletePlanner(
  tables: readonly SchemaTable[],
  declared: readonly SchemaRelationship[],
  load: RowLoader,
): DeletePlanner {
  const infos = tableInfos(tables, relationshipsAmong(tables, declared));

  // What's been loaded, kept between plans. Rows are interned by identity, so
  // one record is one object however it was reached.
  const interned = new Map<string, Map<string, Row>>();
  /** By relationship, then by the value referred to: the rows referring to it. */
  const referrers = new Map<string, Map<string, Row[]>>();
  /** By relationship, then by the value referred to: how many rows refer to it. */
  const totals = new Map<string, Map<string, number>>();
  /** By table and column, then by value: the row holding it, if there is one. */
  const holders = new Map<string, Map<string, Row | null>>();

  const rowsWhere = (info: TableInfo, where: PlanCondition) =>
    load({ kind: "rows", table: info.name, columns: info.columns, where });

  const intern = (info: TableInfo, row: Row): Row => {
    if (info.key.length === 0) return row;
    return ensure(
      ensure(interned, info.name, () => new Map<string, Row>()),
      signature(info, row),
      () => row,
    );
  };

  /** The rows referring to any of `values` through `rel`. */
  const loadReferrers = async (
    rel: Relationship,
    values: readonly string[],
  ): Promise<Row[]> => {
    const info = infos.get(rel.fromTable)!;
    const known = ensure(referrers, rel.id, () => new Map<string, Row[]>());
    const at = info.at.get(rel.fromColumn)!;
    const missing = values.filter((value) => !known.has(value));
    for (const chunk of chunks(missing)) {
      for (const value of chunk) known.set(value, []);
      const rows = await rowsWhere(info, {
        column: rel.fromColumn,
        values: chunk,
      });
      for (const row of rows) {
        const value = row[at];
        if (value != null) known.get(value)?.push(intern(info, row));
      }
    }
    return values.flatMap((value) => known.get(value) ?? []);
  };

  /** How many rows refer to each of `values` through `rel`. */
  const loadTotals = async (
    rel: Relationship,
    values: readonly string[],
  ): Promise<ReadonlyMap<string, number>> => {
    const known = ensure(totals, rel.id, () => new Map<string, number>());
    const missing = values.filter((value) => !known.has(value));
    for (const chunk of chunks(missing)) {
      for (const value of chunk) known.set(value, 0);
      const rows = await load({
        kind: "counts",
        table: rel.fromTable,
        column: rel.fromColumn,
        values: chunk,
      });
      for (const [value, count] of rows) {
        if (value != null) known.set(value, Number(count));
      }
    }
    return known;
  };

  /** The rows of `info`'s table whose `column` is one of `values`. */
  const loadHolders = async (
    info: TableInfo,
    column: string,
    values: readonly string[],
  ): Promise<Row[]> => {
    const known = ensure(
      holders,
      JSON.stringify([info.name, column]),
      () => new Map<string, Row | null>(),
    );
    const at = info.at.get(column)!;
    const missing = values.filter((value) => !known.has(value));
    for (const chunk of chunks(missing)) {
      for (const value of chunk) known.set(value, null);
      const rows = await rowsWhere(info, { column, values: chunk });
      for (const row of rows) {
        const value = row[at];
        if (value != null) known.set(value, intern(info, row));
      }
    }
    const held: Row[] = [];
    for (const value of values) {
      const row = known.get(value);
      if (row) held.push(row);
    }
    return held;
  };

  /** The rows the records `keys` identify, those that are still there. Asked
   * afresh for every plan, and never looked up by the values asked for: a key
   * comes from a result row, whose text for a value needn't be the text the
   * database gives it back as. */
  const loadByKeys = async (
    info: TableInfo,
    keys: readonly RecordKey[],
  ): Promise<Row[]> => {
    const named = keys.filter((key) => key.length > 0);
    const rows = new Map<string, Row>();
    for (const chunk of chunks(named)) {
      // A single-column key is asked for as a list of values, which the
      // database answers from the key's index.
      const column = chunk[0]![0]!.column;
      const single = chunk.every(
        (key) => key.length === 1 && key[0]!.column === column,
      );
      const where: PlanCondition = single
        ? { column, values: chunk.map((key) => key[0]!.value) }
        : { keys: chunk };
      for (const row of await rowsWhere(info, where)) {
        rows.set(signature(info, row), intern(info, row));
      }
    }
    return [...rows.values()];
  };

  const plan = async (
    table: string,
    keys: readonly RecordKey[],
    choices: DeleteChoices,
    options: PlanOptions = {},
  ): Promise<DeletePlan> => {
    const root = infos.get(table);
    if (!root) throw new Error(`There's no table "${table}".`);
    if (root.key.length === 0) {
      throw new Error(
        `Nothing identifies one record of "${table}", so its records can't be deleted.`,
      );
    }

    /** The records to delete, by table then identity, in the order found. */
    const deleted = new Map<string, Map<string, Row>>();
    /** For each column a relationship leads to: its values among `deleted`. */
    const gone = new Map<string, Set<string>>();
    const goneOf = (name: string, column: string): Set<string> =>
      ensure(gone, JSON.stringify([name, column]), () => new Set<string>());
    /** Deleted records whose own relationships haven't been followed yet. */
    const pending: [TableInfo, Row[]][] = [];
    const isDeleted = (info: TableInfo, row: Row): boolean =>
      deleted.get(info.name)?.has(signature(info, row)) ?? false;
    /** For each deleted record (interned, so one object per record): the
     * line whose choice deleted it, `null` for the records asked for. */
    const causes = new Map<Row, string | null>();
    /** For each line, by its id: the line whose records first led to it. */
    const parents = new Map<string, string | null>();
    const remove = (
      info: TableInfo,
      rows: readonly Row[],
      cause: string | null,
    ) => {
      const records = ensure(deleted, info.name, () => new Map<string, Row>());
      const fresh: Row[] = [];
      for (const row of rows) {
        const sig = signature(info, row);
        if (records.has(sig)) continue;
        records.set(sig, row);
        causes.set(row, cause);
        fresh.push(row);
        for (const rel of info.incoming) {
          const value = row[info.at.get(rel.toColumn)!];
          if (value != null) goneOf(info.name, rel.toColumn).add(value);
        }
      }
      if (fresh.length > 0) pending.push([info, fresh]);
    };

    /** By relationship: the records found referring to a deleted record, less
     * those already being deleted when they were found. */
    const referencing = new Map<string, Map<string, Row>>();
    /** By relationship: the values of the records found orphaned, likewise. */
    const orphaned = new Map<string, Set<string>>();
    const blocked = new Map<string, number>();
    const relationships = new Map<string, Relationship>();
    const deletesReferrers = (rel: Relationship): boolean =>
      rel.required || choices.referencing[rel.id] === true;

    const found = await loadByKeys(root, keys);
    // Kept records are followed as deleted ones are, for what refers to them,
    // and are left out of what's written.
    const kept = new Set<Row>(options.keep ? found : []);
    remove(root, found, null);

    for (;;) {
      // Whatever refers to a record that's going.
      for (let next = pending.shift(); next; next = pending.shift()) {
        const [info, rows] = next;
        // One batch is one removal, so its rows share a cause.
        const cause = causes.get(rows[0]!) ?? null;
        for (const rel of info.incoming) {
          const at = info.at.get(rel.toColumn)!;
          const values = rows.flatMap((row) =>
            // What can't be kept without them stays with the records kept.
            rel.required && kept.has(row) ? [] : (row[at] ?? []),
          );
          if (values.length === 0) continue;
          const from = infos.get(rel.fromTable)!;
          const referring = await loadReferrers(rel, values);
          if (referring.length === 0) continue;
          relationships.set(rel.id, rel);
          if (from.key.length === 0) {
            blocked.set(rel.id, (blocked.get(rel.id) ?? 0) + referring.length);
            continue;
          }
          const seen = ensure(
            referencing,
            rel.id,
            () => new Map<string, Row>(),
          );
          const id = `referencing:${rel.id}`;
          for (const row of referring) {
            if (isDeleted(from, row)) continue;
            seen.set(signature(from, row), row);
            if (!parents.has(id)) parents.set(id, cause);
          }
          if (deletesReferrers(rel)) remove(from, referring, id);
        }
      }

      // Whatever a record that's going was the last to refer to.
      for (const [name, records] of [...deleted]) {
        const info = infos.get(name)!;
        for (const rel of info.outgoing) {
          const at = info.at.get(rel.fromColumn)!;
          const going = goneOf(rel.toTable, rel.toColumn);
          const seen = orphaned.get(rel.id);
          // How many of the records going refer to each record that isn't,
          // and isn't known to be orphaned already.
          const leaving = new Map<string, number>();
          /** What deleted the first of them to refer to each. */
          const leavingCause = new Map<string, string | null>();
          const spared = options.spare?.[rel.toTable];
          for (const row of records.values()) {
            if (kept.has(row)) continue;
            const value = row[at];
            if (value == null || going.has(value) || seen?.has(value)) continue;
            if (spared?.has(value)) continue;
            leaving.set(value, (leaving.get(value) ?? 0) + 1);
            if (!leavingCause.has(value)) {
              leavingCause.set(value, causes.get(row) ?? null);
            }
          }
          if (leaving.size === 0) continue;
          const all = await loadTotals(rel, [...leaving.keys()]);
          const target = infos.get(rel.toTable)!;
          const fresh: string[] = [];
          for (const [value, count] of leaving) {
            if (count >= (all.get(value) ?? 0)) fresh.push(value);
          }
          if (fresh.length === 0) continue;
          const found = ensure(orphaned, rel.id, () => new Set<string>());
          for (const value of fresh) found.add(value);
          relationships.set(rel.id, rel);
          const id = `orphans:${rel.id}`;
          if (!parents.has(id)) parents.set(id, leavingCause.get(fresh[0]!)!);
          if (choices.orphans[rel.id] === true && target.key.length > 0) {
            remove(target, await loadHolders(target, rel.toColumn, fresh), id);
          }
        }
      }
      if (pending.length === 0) break;
    }

    // The lines of the confirmation, in the order the relationships were met.
    const items: PlanItem[] = [];
    /** The records kept with a column emptied: by table and identity. */
    const emptied = new Map<
      string,
      { info: TableInfo; row: Row; columns: Set<string> }
    >();
    const empty = (info: TableInfo, row: Row, column: string) =>
      ensure(
        emptied,
        JSON.stringify([info.name, signature(info, row)]),
        () => ({
          info,
          row,
          columns: new Set<string>(),
        }),
      ).columns.add(column);

    for (const rel of relationships.values()) {
      const referring = referencing.get(rel.id);
      if (referring && referring.size > 0) {
        const from = infos.get(rel.fromTable)!;
        const checked = deletesReferrers(rel);
        const kept = checked
          ? []
          : [...referring.values()].filter((row) => !isDeleted(from, row));
        for (const row of kept) empty(from, row, rel.fromColumn);
        const count = checked ? referring.size : kept.length;
        if (count > 0) {
          items.push({
            id: `referencing:${rel.id}`,
            kind: "referencing",
            relationship: rel,
            table: rel.fromTable,
            count,
            checked,
            required: rel.required,
            parent: parents.get(`referencing:${rel.id}`) ?? null,
          });
        }
      }
      const values = orphaned.get(rel.id);
      if (values && values.size > 0) {
        const checked = choices.orphans[rel.id] === true;
        const going = goneOf(rel.toTable, rel.toColumn);
        const count = checked
          ? values.size
          : [...values].filter((value) => !going.has(value)).length;
        if (count > 0) {
          items.push({
            id: `orphans:${rel.id}`,
            kind: "orphans",
            relationship: rel,
            table: rel.toTable,
            count,
            checked,
            required: false,
            parent: parents.get(`orphans:${rel.id}`) ?? null,
          });
        }
      }
    }
    // A line whose parent isn't shown (one that leaves nothing to say, like
    // records all deleted some other way) goes under the nearest one that is.
    const shown = new Set(items.map((item) => item.id));
    for (const item of items) {
      let parent = item.parent;
      while (parent !== null && !shown.has(parent)) {
        parent = parents.get(parent) ?? null;
      }
      item.parent = parent;
    }

    // The deletes, ordered so that a record goes only after everything that
    // refers to it has: the API checks each one as it runs.
    const nodes: { info: TableInfo; row: Row }[] = [];
    /** For each column a relationship leads to: the node holding each value. */
    const nodeAt = new Map<string, Map<string, number>>();
    for (const [name, records] of deleted) {
      const info = infos.get(name)!;
      for (const row of records.values()) {
        if (kept.has(row)) continue;
        const index = nodes.push({ info, row }) - 1;
        for (const rel of info.incoming) {
          const value = row[info.at.get(rel.toColumn)!];
          if (value == null) continue;
          ensure(
            nodeAt,
            JSON.stringify([name, rel.toColumn]),
            () => new Map<string, number>(),
          ).set(value, index);
        }
      }
    }
    /** For each node: the deleted records it refers to, and through what. */
    const targets = nodes.map(({ info, row }) =>
      info.outgoing.flatMap((rel) => {
        const value = row[info.at.get(rel.fromColumn)!];
        const target =
          value == null
            ? undefined
            : nodeAt
                .get(JSON.stringify([rel.toTable, rel.toColumn]))
                ?.get(value);
        return target === undefined ? [] : [{ rel, target }];
      }),
    );
    /** How many deleted records still refer to each node. */
    const waiting = new Int32Array(nodes.length);
    for (const edges of targets)
      for (const { target } of edges) waiting[target]!++;
    const order: number[] = [];
    const placed = new Uint8Array(nodes.length);
    /** Places every node of `ready`, and each node that frees in turn. One
     * table's records go together, as many as are free, before the next
     * table's: a run of deletes from one table is one the API can make in a
     * single statement. */
    const drain = (ready: readonly number[]) => {
      const queues = new Map<string, number[]>();
      const enqueue = (node: number) =>
        ensure(queues, nodes[node]!.info.name, () => []).push(node);
      ready.forEach(enqueue);
      for (let moved = true; moved;) {
        moved = false;
        for (const queue of queues.values()) {
          // The queue grows as it's drained, when a record frees another of
          // its own table.
          for (let i = 0; i < queue.length; i++) {
            const node = queue[i]!;
            if (placed[node]) continue;
            placed[node] = 1;
            order.push(node);
            moved = true;
            for (const { target } of targets[node]!) {
              if (--waiting[target]! === 0) enqueue(target);
            }
          }
          queue.length = 0;
        }
      }
    };
    drain(nodes.flatMap((_, i) => (waiting[i] === 0 ? [i] : [])));
    if (order.length < nodes.length) {
      // What's left refers to itself, directly or in a ring. Emptying the
      // columns that close the ring, where they can be, lets it go.
      const ready: number[] = [];
      nodes.forEach(({ info, row }, node) => {
        if (placed[node]) return;
        for (const { rel, target } of targets[node]!) {
          if (rel.required || placed[target]) continue;
          empty(info, row, rel.fromColumn);
          if (--waiting[target]! === 0) ready.push(target);
        }
      });
      drain(ready);
      // A ring of columns that can't be emptied is sent as it is, for the API
      // to refuse.
      nodes.forEach((_, node) => {
        if (!placed[node]) order.push(node);
      });
    }

    const operations: DmlOperation[] = [];
    for (const { info, row, columns } of emptied.values()) {
      operations.push({
        operation: "update",
        id: `u${operations.length}`,
        ...dmlTable(info.name),
        where: where(info, row),
        values: Object.fromEntries(
          [...columns].map((column) => [column, null]),
        ),
      });
    }
    const updateCount = operations.length;
    for (const node of order) {
      const { info, row } = nodes[node]!;
      operations.push({
        operation: "delete",
        id: `d${operations.length}`,
        ...dmlTable(info.name),
        where: where(info, row),
      });
    }

    return {
      summary: {
        table,
        found: found.length,
        kept: kept.size,
        items,
        blocked: [...blocked].map(([id, count]) => ({
          relationship: relationships.get(id)!,
          count,
        })),
        deleteCount: nodes.length,
        deletedByTable: Object.fromEntries(
          [...deleted].flatMap(([name, records]) => {
            const count =
              name === root.name ? records.size - kept.size : records.size;
            return count > 0 ? [[name, count]] : [];
          }),
        ),
        updateCount,
      },
      operations,
      deleted: new Map(
        [...deleted].flatMap(([name, records]) => {
          const info = infos.get(name)!;
          const keys = [...records.values()]
            .filter((row) => !kept.has(row))
            .map((row) => recordKey(info, row));
          return keys.length > 0 ? [[name, keys] as const] : [];
        }),
      ),
      kept: [...kept].map((row) => recordKey(root, row)),
    };
  };

  return { plan };
}
