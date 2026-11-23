// A canned database for the record editor, so the form can be driven — and
// snapshotted — without a backend. Two halves, matching the two things the form
// needs from one: an introspection document (its whole structure comes from
// there) and answers to the Querydown queries it builds (its data).
//
// The schema is RadioCrate's own, as the migrations leave it
// (`backend/src/migrations/`), trimmed to the tables and columns the form has
// something to show for. The rows continue the seeded "Lemonade" grid:
// `?records=track,album` gives its rows the keys `track-1` … `track-5`, which is
// what the ids below are.
//
// The fake query runner interprets only the shapes `query/recordForm.ts`,
// `query/embeddedRecord.ts` and `query/relatedRecords.ts` generate —
// `col:="value"` / `link.col:="value"` conditions, `[{…} {…}]`
// alternatives, `$col` / `$link.col` / `$#table` display expressions, `\\col` /
// `\\col \d` sorting, and the distinct values `query/valueSuggestions.ts` asks
// for — rather than being a SQL engine. If the generators learn a
// new shape, this learns it too.

import { addInferredLinks } from "../query/schema";
import { compile_sections } from "querydown-js";
import { querydownReady } from "../query/querydown";
import { columnMetadataFromAnnotation } from "../query/columns";
import { setRecordQueryRunner } from "../query/recordData";
import type { RecordQuery } from "../query/recordForm";

const T = (
  name: string,
  columns: [string, string, boolean?][],
  uniques: string[][],
) => ({
  name,
  columns: columns.map(([n, type, nullable]) => ({
    name: n,
    type,
    nullable: nullable ?? false,
  })),
  unique_constraints: uniques,
});

/** The enriched introspection JSON — RadioCrate's schema, with the links the
 * compiler and the form both read inferred into it. */
export const FIXTURE_SCHEMA_JSON = addInferredLinks(
  JSON.stringify({
    tables: [
      T(
        "album",
        [
          ["id", "UUID"],
          ["title", "VARCHAR", true],
          ["year", "USMALLINT", true],
        ],
        [["id"]],
      ),
      T(
        "artist",
        [
          ["id", "UUID"],
          ["name", "VARCHAR"],
        ],
        [["id"], ["name"]],
      ),
      T(
        "credit",
        [
          ["track", "UUID"],
          ["artist", "UUID"],
          ["order", "FLOAT", true],
          // Dropped and re-added as a link by migration 0003, which is why it
          // trails the columns it used to sit among.
          ["role", "UUID", true],
        ],
        [["track", "artist"]],
      ),
      T(
        "file",
        [
          ["id", "UUID"],
          ["path", "VARCHAR"],
          ["size", "UINTEGER"],
          ["format", "format"],
          ["duration", "INTERVAL"],
          ["added", "TIMESTAMP"],
        ],
        [["id"], ["path"]],
      ),
      T(
        "play",
        [
          ["track", "UUID"],
          ["timestamp", "TIMESTAMP_S"],
        ],
        [["track", "timestamp"]],
      ),
      T(
        "rating",
        [
          ["id", "UUID"],
          ["value", "FLOAT"],
          ["symbol", "VARCHAR", true],
          ["description", "VARCHAR", true],
        ],
        [["id"], ["value"]],
      ),
      T(
        "role",
        [
          ["id", "UUID"],
          ["name", "VARCHAR"],
        ],
        [["id"], ["name"]],
      ),
      T(
        "tag",
        [
          ["id", "UUID"],
          ["name", "VARCHAR"],
        ],
        [["id"], ["name"]],
      ),
      T(
        "track",
        [
          ["id", "UUID"],
          ["file", "UUID"],
          ["title", "VARCHAR"],
          ["album", "UUID", true],
          ["disc_number", "UTINYINT", true],
          ["track_number", "UTINYINT", true],
          ["rating", "UUID", true],
        ],
        [["id"]],
      ),
      T(
        "track_tag",
        [
          ["track", "UUID"],
          ["tag", "UUID"],
        ],
        [["track", "tag"]],
      ),
    ],
    links: [],
  }),
);

/** The fixture's schema with two more beside `main`, as a database has them
 * once the user has added a schema of their own: the app's `metadata`, and the
 * user's `lastfm`, whose `scrobble` links to the app's `track` and whose
 * `artist` shares its name with the app's. For the stories about other
 * schemas; the rest keep to the app's own tables. */
export const FIXTURE_SCHEMAS_JSON = addInferredLinks(
  JSON.stringify({
    tables: [
      ...(JSON.parse(FIXTURE_SCHEMA_JSON) as { tables: unknown[] }).tables,
      {
        ...T(
          "artist",
          [
            ["mbid", "VARCHAR"],
            ["name", "VARCHAR"],
          ],
          [["mbid"]],
        ),
        schema: ["lastfm"],
      },
      {
        ...T(
          "scrobble",
          [
            ["id", "UUID"],
            ["track", "UUID", true],
            ["artist", "VARCHAR"],
            ["title", "VARCHAR"],
            ["played_at", "TIMESTAMP"],
          ],
          [["id"]],
        ),
        schema: ["lastfm"],
      },
      {
        ...T(
          "computed_column",
          [
            ["table_schema", "VARCHAR"],
            ["table_name", "VARCHAR"],
            ["name", "VARCHAR"],
            ["expression", "VARCHAR", true],
          ],
          [["table_schema", "table_name", "name"]],
        ),
        schema: ["metadata"],
      },
      {
        ...T(
          "table",
          [
            ["table_schema", "VARCHAR"],
            ["table_name", "VARCHAR"],
            ["visible", "BOOLEAN"],
            ["order", "DOUBLE", true],
          ],
          [["table_schema", "table_name"]],
        ),
        schema: ["metadata"],
      },
    ],
    links: [],
  }),
);

/** One fixture row: column → value, `null` for NULL. */
type Row = Record<string, string | null>;

const TITLES = [
  "Pray You Catch Me",
  "Hold Up",
  "Don't Hurt Yourself",
  "Sorry",
  "6 Inch",
];

/** A title long enough to overflow the sidebar's width — and carrying a
 * linebreak, which makes a value expandable whatever its width — so the
 * expandable-text behavior has something to expand.
 *
 * It lives on `title` because that is the only free text `track` has left: the
 * long value used to be `genre`, which migration 0003 replaced with the `tag`
 * table. A track whose title runs this long is not a contrivance — a live
 * recording that names its medley is exactly this shape. */
const LONG_TITLE =
  'Don\'t Hurt Yourself — Live at the Superdome, with the full horn\nsection, running into a reprise of "Ring the Alarm" nobody had rehearsed.';

const TABLE_ROWS: Record<string, Row[]> = {
  // One album per grid row, so a row's `album-N` key (from `?records=`) resolves
  // to a record whichever row the editor is opened on.
  album: TITLES.map((_, i) => ({
    id: `album-${i + 1}`,
    title: "Lemonade",
    year: "2016",
  })),
  artist: [
    { id: "artist-1", name: "Beyoncé" },
    { id: "artist-2", name: "Jack White" },
    { id: "artist-3", name: "The Weeknd" },
  ],
  file: TITLES.map((title, i) => ({
    id: `file-${i + 1}`,
    path: `./Beyoncé/Lemonade/Beyoncé - ${i + 1} - ${title}.flac`,
    size: `${34_000_000 + i * 1_000_000}`,
    format: "flac",
    duration: ["00:03:16", "00:03:41", "00:03:54", "00:03:53", "00:04:20"][i],
    added: "2016-04-23 19:04:00",
  })),
  // Ratings and roles are shared values as of migration 0003: a handful of
  // records the tracks and credits point at, rather than a number and a string
  // repeated down each column.
  rating: [
    { id: "rating-35", value: "3.5" },
    { id: "rating-4", value: "4" },
    { id: "rating-45", value: "4.5" },
  ],
  role: [{ id: "role-featured", name: "Featured" }],
  tag: [
    { id: "tag-rnb", name: "R&B" },
    { id: "tag-neo-soul", name: "Neo soul" },
    { id: "tag-rock", name: "Rock" },
    { id: "tag-trap-soul", name: "Trap soul" },
  ],
  track: TITLES.map((title, i) => ({
    id: `track-${i + 1}`,
    file: `file-${i + 1}`,
    // The third track's title is the long one, so the expandable-text behavior
    // is reachable on a record that also has credits, plays and tags to show.
    title: i === 2 ? LONG_TITLE : title,
    // The last track is left unfiled, so a NULL scalar linked record field (and
    // its pencil button) is on screen.
    album: i === 4 ? null : `album-${i + 1}`,
    disc_number: "1",
    // The last track's number is left off, so a NULL *primitive* field — whose
    // pencil activates a text box, unlike a link's, which opens the record
    // picker — is on screen beside that NULL `album` link.
    track_number: i === 4 ? null : `${i + 1}`,
    rating: ["rating-35", "rating-4", "rating-4", "rating-4", "rating-45"][i],
  })),
  // Several tags on one track — the thing the old comma-joined `genre` string
  // could not represent, and the reason `track_tag` exists.
  track_tag: [
    { track: "track-1", tag: "tag-rnb" },
    { track: "track-1", tag: "tag-neo-soul" },
    { track: "track-3", tag: "tag-rnb" },
    { track: "track-3", tag: "tag-rock" },
    { track: "track-5", tag: "tag-trap-soul" },
  ],
  credit: [
    { track: "track-1", artist: "artist-1", order: "1", role: null },
    { track: "track-3", artist: "artist-1", order: "1", role: null },
    { track: "track-3", artist: "artist-2", order: "2", role: "role-featured" },
    { track: "track-5", artist: "artist-1", order: "1", role: null },
    { track: "track-5", artist: "artist-3", order: "2", role: "role-featured" },
  ],
  play: [
    { track: "track-1", timestamp: "2016-04-24 08:12:00" },
    { track: "track-1", timestamp: "2016-05-02 21:47:00" },
    { track: "track-3", timestamp: "2016-06-11 10:05:00" },
  ],
};

/** One parsed filter line: a column path, a value, and whether the match is
 * exact (`:=`) or a substring (`:`). */
interface Condition {
  path: string;
  value: string;
  exact: boolean;
}

/** A Querydown string literal as `quoteValue` writes them: raw in either quote,
 * or `^e`-flagged with backslash escapes when the value holds both quotes. */
const STRING_LITERAL = String.raw`\^e"(?:[^"\\]|\\.)*"|\^e'(?:[^'\\]|\\.)*'|"[^"]*"|'[^']*'`;

/** The text of a literal {@link STRING_LITERAL} matched. */
function unquote(literal: string): string {
  return literal.startsWith("^e")
    ? literal.slice(3, -1).replace(/\\(.)/g, "$1")
    : literal.slice(1, -1);
}

/** One condition per line: `col:="value"` as `keyConditions` writes them (or
 * `link.col:="value"`, one hop through a link), and
 * the looser `col:value` / `col:"value"` substring form a user types into the
 * record picker's search box. */
function parseConditions(filter: string): Condition[] {
  const conditions: Condition[] = [];
  const pattern = new RegExp(
    String.raw`^([\w.]+):(=?)\s*(?:(${STRING_LITERAL})|(\S+))$`,
  );
  for (const line of filter.split("\n")) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    conditions.push({
      path: match[1],
      value: match[3] !== undefined ? unquote(match[3]) : match[4],
      exact: match[2] === "=",
    });
  }
  return conditions;
}

/** `filter` with the `@name = '…'` variables `definitions` defines written in as
 * the values they stand for — a contextual query's `@id`, which the compiler
 * resolves the same way. */
function substituteVariables(filter: string, definitions = ""): string {
  let text = filter;
  for (const [, name, literal] of definitions.matchAll(
    new RegExp(String.raw`^@(\w+) = (${STRING_LITERAL})$`, "gm"),
  )) {
    text = text.replaceAll(new RegExp(`@${name}\\b`, "g"), literal);
  }
  return text;
}

/** A filter as alternatives, each a set of conditions AND-ed together: one
 * group for the ordinary filter, and one per `{…}` when `keyConditions` writes
 * out several records' keys inside `[…]`. A row satisfies the filter when it
 * satisfies any group. */
function parseFilter(filter: string): Condition[][] {
  if (!filter.trim().startsWith("[")) return [parseConditions(filter)];
  const groups = [...filter.matchAll(/\{([^}]*)\}/g)].map((m) =>
    parseConditions(m[1]),
  );
  // `[…]` around bare conditions (rather than `{…}` groups) is one alternative
  // per condition — the shape a single-column key takes.
  return groups.length > 0
    ? groups
    : parseConditions(filter).map((condition) => [condition]);
}

/** Whether one row of `base` satisfies one condition. */
function matches(base: string, row: Row, condition: Condition): boolean {
  const cell = readPath(base, row, condition.path);
  if (condition.exact) return cell === condition.value;
  return (cell ?? "").toLowerCase().includes(condition.value.toLowerCase());
}

/** The columns of `table` that link to another table, by the naming
 * convention the compiler's inferred links read: a column named for a table. */
function linkColumns(table: string): string[] {
  const columns = new Set((TABLE_ROWS[table] ?? []).flatMap(Object.keys));
  return [...columns].filter((column) => column in TABLE_ROWS);
}

/** The rows of `table` related to `row` of `base`, along the shortest of the
 * paths the app's own computed columns take:
 *
 * - `table` links to `base` (`#play` on a track);
 * - a table joining the two links to both (`#tag` on a track, by `track_tag`;
 *   `#track` on an artist, by `credit`);
 * - `table` links to a table that's related to `base` itself (`#play` on an
 *   album, by its tracks; `#play` on an artist, by its credits' tracks). */
function relatedRows(table: string, base: string, row: Row, depth = 2): Row[] {
  const rows = TABLE_ROWS[table] ?? [];
  const links = linkColumns(table);
  if (links.includes(base)) return rows.filter((r) => r[base] === row.id);
  for (const join of Object.keys(TABLE_ROWS)) {
    const joinLinks = linkColumns(join);
    if (!joinLinks.includes(base) || !joinLinks.includes(table)) continue;
    const ids = new Set(
      TABLE_ROWS[join].filter((r) => r[base] === row.id).map((r) => r[table]),
    );
    return rows.filter((r) => ids.has(r.id));
  }
  if (depth === 0) return [];
  for (const link of links) {
    if (link === table) continue;
    const ids = new Set(
      relatedRows(link, base, row, depth - 1).map((r) => r.id),
    );
    if (ids.size > 0) return rows.filter((r) => ids.has(r[link]));
  }
  return [];
}

/** How many rows of `childTable` relate to `row` — the `$#table` count. */
function relatedCount(childTable: string, base: string, row: Row): number {
  return relatedRows(childTable, base, row).length;
}

/** The distinct values of `values`, sorted, as DuckDB lists print. */
function listOf(values: readonly string[]): string {
  return `[${[...new Set(values)].sort().join(", ")}]`;
}

/** Reads a column path out of a row: `title`, or `artist.name` — a hop
 * through the foreign key named by each part but the last, which the fixture
 * resolves the way the compiler's inferred links do (`<column>` →
 * `<column>.id`), so `track.album.id` takes two. */
function readPath(base: string, row: Row, path: string): string | null {
  const [first, ...rest] = path.split(".");
  if (rest.length === 0) return row[first] ?? null;
  const id = row[first];
  const target = (TABLE_ROWS[first] ?? []).find((r) => r.id === id);
  return target ? readPath(first, target, rest.join(".")) : null;
}

/** The computed columns `definitions` defines for `base`, by name, each with
 * its expression: the `#base.name = expression` lines the app builds into the
 * prelude (`query/computedColumns.ts`). A later definition wins, as it does
 * in the compiler. */
function computedDefinitions(
  base: string,
  definitions = "",
): Map<string, string> {
  const computed = new Map<string, string>();
  for (const [, table, name, expression] of definitions.matchAll(
    /^#(\w+)\.(\w+) = (.*)$/gm,
  )) {
    if (table === base) computed.set(name, expression.trim());
  }
  return computed;
}

/** What a display expression comes to for a row: a column's value, a link's,
 * or — for a name the row has no column of — what the computed column of that
 * name works out to. The fixture reads the few shapes of expression the app's
 * own computed columns take, and anything else comes to NULL:
 *
 * - a column path, or another computed column (`album.year`);
 * - a count of related records (`#play`);
 * - the least, greatest, list, distinct count or commonest values of a column
 *   across them (`#play.timestamp%max`, `#credit.artist.name%list_all(…)`,
 *   `#tag.name%list(…)`, `#track.album.title%distinct`,
 *   `#credit.artist.name%top(…)`), whatever the arguments say. */
function readValue(
  base: string,
  row: Row,
  path: string,
  computed: ReadonlyMap<string, string>,
): string | null {
  const expression = computed.get(path);
  if (expression === undefined || path in row) {
    return readPath(base, row, path);
  }
  const count = /^#(\w+)$/.exec(expression);
  if (count) return String(relatedCount(count[1], base, row));
  const aggregate = /^#(\w+)\.([\w.]+)%(\w+)/.exec(expression);
  if (aggregate) {
    const [, table, column, fn] = aggregate;
    const values = relatedRows(table, base, row)
      .map((related) => readPath(table, related, column))
      .filter((value) => value !== null);
    if (fn === "distinct") return String(new Set(values).size);
    if (values.length === 0) return null;
    if (fn === "list_all") return `[${values.join(", ")}]`;
    if (fn === "list") return listOf(values);
    if (fn === "top") {
      const counts = new Map<string, number>();
      for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      const most = Math.max(...counts.values());
      return listOf([...counts].filter(([, n]) => n === most).map(([v]) => v));
    }
    const sorted = [...values].sort();
    if (fn === "min") return sorted[0];
    if (fn === "max") return sorted[sorted.length - 1];
    return null;
  }
  return /^[\w.]+$/.test(expression)
    ? readValue(base, row, expression, computed)
    : null;
}

/** One sort term: a column path and its direction (`\d` makes it descending). */
function parseSort(sort: string): { path: string; descending: boolean }[] {
  const terms: { path: string; descending: boolean }[] = [];
  for (const token of sort.split(/\s+/).filter(Boolean)) {
    if (token === "\\d") {
      if (terms.length > 0) terms[terms.length - 1].descending = true;
      continue;
    }
    terms.push({ path: token.replace(/^\\+/, ""), descending: false });
  }
  return terms;
}

/** Answers one record editor query out of the fixture rows — a mock of the
 * query API a story can hand a component directly, with no runner install. */
export function fixtureQuery(q: RecordQuery): (string | null)[][] {
  const groups = parseFilter(substituteVariables(q.filter, q.definitions));
  const rows = (TABLE_ROWS[q.base] ?? []).filter((row) =>
    groups.some((conditions) =>
      conditions.every((condition) => matches(q.base, row, condition)),
    ),
  );
  // `$col \gs2 $%count \sd1`: a column's distinct values with their counts, the
  // commonest first. Ties go by byte, as DuckDB's default collation has them.
  const grouped = /^\$(\S+) \\gs2 \$%count \\sd1$/.exec(q.display);
  if (grouped) {
    const counts = new Map<string | null, number>();
    for (const row of rows) {
      const value = readPath(q.base, row, grouped[1]);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts]
      .sort(([a, x], [b, y]) => y - x || ((a ?? "") < (b ?? "") ? -1 : 1))
      .map(([value, count]) => [value, String(count)]);
  }
  const terms = parseSort(q.sort);
  rows.sort((a, b) => {
    for (const { path, descending } of terms) {
      const order = (readPath(q.base, a, path) ?? "").localeCompare(
        readPath(q.base, b, path) ?? "",
      );
      if (order !== 0) return descending ? -order : order;
    }
    return 0;
  });
  // A column's annotation says how it's shown, which the query's compile reports.
  const exprs = q.display
    .replace(/@\{(?:[^{}]|\{[^{}]*\})*\}/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const computed = computedDefinitions(q.base, q.definitions);
  return rows.map((row) =>
    exprs.map((expr) =>
      expr.startsWith("$#")
        ? String(relatedCount(expr.slice(2), q.base, row))
        : readValue(q.base, row, expr.slice(1), computed),
    ),
  );
}

/** Points the record editor at the fixture instead of the backend. `delayMs`
 * holds every answer back by that long, so the loading states (the wash over the
 * form, the placeholder rows under a multi-record field) can be seen and
 * asserted. Each query is compiled first, for real, so one that wouldn't compile
 * fails here as it would there; the fixture only stands in for the database. */
export function installRecordFixture(delayMs: number): void {
  setRecordQueryRunner(async (q, schemaJson) => {
    await querydownReady();
    const { columnAnnotations } = compile_sections(
      schemaJson,
      "duckdb",
      q.base,
      q.definitions ?? "",
      q.filter,
      q.sort,
      q.display,
    );
    const columns = columnAnnotations.map(columnMetadataFromAnnotation);
    return new Promise((resolve) =>
      setTimeout(() => resolve({ rows: fixtureQuery(q), columns }), delayMs),
    );
  });
}
