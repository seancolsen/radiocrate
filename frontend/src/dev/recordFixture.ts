// A canned database for the record editor, so the form can be driven — and
// snapshotted — without a backend. Two halves, matching the two things the form
// needs from one: an introspection document (its whole structure comes from
// there) and answers to the Querydown queries it builds (its data).
//
// The schema is RadioCrate's own (`backend/src/migrations/0001.sql`), and the
// rows continue the seeded "Lemonade" grid: `?records=track,album` gives its
// rows the keys `track-1` … `track-5`, which is what the ids below are.
//
// The fake query runner interprets only the shapes `query/recordForm.ts` and
// `query/embeddedRecord.ts` generate — `col:="value"` conditions, `[{…} {…}]`
// alternatives, `$col` / `$link.col` / `$#table` display expressions, `\\col` /
// `\\col \d` sorting — rather than being a SQL engine. If the generators learn a
// new shape, this learns it too.

import { addInferredLinks } from "../query/schema";
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
          ["ord", "FLOAT", true],
          ["role", "VARCHAR", true],
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
          ["duration", "FLOAT"],
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
        "track",
        [
          ["id", "UUID"],
          ["file", "UUID"],
          ["title", "VARCHAR"],
          ["album", "UUID", true],
          ["disc_number", "UTINYINT", true],
          ["track_number", "UTINYINT", true],
          ["genre", "VARCHAR", true],
          ["rating", "FLOAT", true],
        ],
        [["id"]],
      ),
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

/** A genre long enough to overflow the sidebar's width, so the expandable-text
 * behavior has something to expand. */
const GENRE =
  "R&B / neo soul, with detours through rock, country and reggae — the\nrecord's whole point is that it doesn't sit still.";

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
    duration: ["196", "221", "234", "233", "260"][i],
    added: "2016-04-23 19:04:00",
  })),
  track: TITLES.map((title, i) => ({
    id: `track-${i + 1}`,
    file: `file-${i + 1}`,
    title,
    // The last track is left unfiled, so a NULL scalar linked record field (and
    // its pencil button) is on screen.
    album: i === 4 ? null : `album-${i + 1}`,
    disc_number: "1",
    track_number: `${i + 1}`,
    // Two of them get a genre too long for one line, so the expandable-text
    // behavior is reachable from a row with credits and one without.
    genre: i === 0 || i === 2 ? GENRE : "R&B",
    // The last track is left unrated too, so a NULL *primitive* field (whose
    // pencil activates a text box, unlike a link's) is on screen beside it.
    rating: i === 4 ? null : ["3.5", "4", "4", "4", "4.5"][i],
  })),
  credit: [
    { track: "track-1", artist: "artist-1", ord: "1", role: null },
    { track: "track-3", artist: "artist-1", ord: "1", role: null },
    { track: "track-3", artist: "artist-2", ord: "2", role: "Featured" },
    { track: "track-5", artist: "artist-1", ord: "1", role: null },
    { track: "track-5", artist: "artist-3", ord: "2", role: "Featured" },
  ],
  play: [
    { track: "track-1", timestamp: "2016-04-24 08:12:00" },
    { track: "track-1", timestamp: "2016-05-02 21:47:00" },
    { track: "track-3", timestamp: "2016-06-11 10:05:00" },
  ],
};

/** One parsed filter line: a column, a value, and whether the match is exact
 * (`:=`) or a substring (`:`). */
interface Condition {
  column: string;
  value: string;
  exact: boolean;
}

/** One condition per line: `col:="value"` as `keyConditions` writes them, and
 * the looser `col:value` / `col:"value"` substring form a user types into the
 * record picker's search box. */
function parseConditions(filter: string): Condition[] {
  const conditions: Condition[] = [];
  for (const line of filter.split("\n")) {
    const match = /^(\w+):(=?)\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))$/.exec(
      line.trim(),
    );
    if (!match) continue;
    conditions.push({
      column: match[1],
      value: (match[3] ?? match[4]).replace(/\\(.)/g, "$1"),
      exact: match[2] === "=",
    });
  }
  return conditions;
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

/** Whether one row satisfies one condition. */
function matches(row: Row, condition: Condition): boolean {
  const cell = row[condition.column];
  if (condition.exact) return cell === condition.value;
  return (cell ?? "").toLowerCase().includes(condition.value.toLowerCase());
}

/** How many rows of `childTable` point at `row` — the `$#table` count. */
function relatedCount(childTable: string, base: string, row: Row): number {
  return (TABLE_ROWS[childTable] ?? []).filter((r) => r[base] === row.id)
    .length;
}

/** Reads a column path out of a row: `title`, or `artist.name` — one hop
 * through the foreign key named by the first part, which the fixture resolves
 * the way the compiler's inferred links do (`<column>` → `<column>.id`). */
function readPath(base: string, row: Row, path: string): string | null {
  const [first, second] = path.split(".");
  if (second === undefined) return row[first] ?? null;
  const id = row[first];
  const target = (TABLE_ROWS[first] ?? []).find((r) => r.id === id);
  return target ? (target[second] ?? null) : null;
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
  const groups = parseFilter(q.filter);
  const rows = (TABLE_ROWS[q.base] ?? []).filter((row) =>
    groups.some((conditions) =>
      conditions.every((condition) => matches(row, condition)),
    ),
  );
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
  const exprs = q.display.split(/\s+/).filter(Boolean);
  return rows.map((row) =>
    exprs.map((expr) =>
      expr.startsWith("$#")
        ? String(relatedCount(expr.slice(2), q.base, row))
        : readPath(q.base, row, expr.slice(1)),
    ),
  );
}

/** Points the record editor at the fixture instead of the backend. `delayMs`
 * holds every answer back by that long, so the loading states (the wash over the
 * form, the placeholder rows under a multi-record field) can be seen and
 * asserted. */
export function installRecordFixture(delayMs: number): void {
  setRecordQueryRunner(
    (q) =>
      new Promise((resolve) =>
        setTimeout(() => resolve(fixtureQuery(q)), delayMs),
      ),
  );
}
