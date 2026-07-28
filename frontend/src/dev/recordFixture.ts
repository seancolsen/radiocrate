// A canned database for the record editor, so the form can be driven — and
// snapshotted — without a backend. Two halves, matching the two things the form
// needs from one: an introspection document (its whole structure comes from
// there) and answers to the Querydown queries it builds (its data).
//
// The schema is RadioCrate's own (`backend/src/migrations/0001.sql`), and the
// rows continue the seeded "Lemonade" grid: `?records=track,album` gives its
// rows the keys `track-1` … `track-5`, which is what the ids below are.
//
// The fake query runner interprets only the shapes `query/recordForm.ts`
// generates — `col:="value"` conditions, `$col` / `$#table` display expressions,
// `\\col` sorting — rather than being a SQL engine. If the generator learns a
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
    rating: ["3.5", "4", "4", "4", "4.5"][i],
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

/** `col:="value"` per line, as `keyConditions` writes them. */
function parseConditions(filter: string): [string, string][] {
  const conditions: [string, string][] = [];
  for (const line of filter.split("\n")) {
    const match = /^(\w+):="((?:[^"\\]|\\.)*)"$/.exec(line.trim());
    if (match) conditions.push([match[1], match[2].replace(/\\(.)/g, "$1")]);
  }
  return conditions;
}

/** How many rows of `childTable` point at `row` — the `$#table` count. */
function relatedCount(childTable: string, base: string, row: Row): number {
  return (TABLE_ROWS[childTable] ?? []).filter((r) => r[base] === row.id)
    .length;
}

/** Answers one record editor query out of the fixture rows. */
function query(q: RecordQuery): (string | null)[][] {
  const conditions = parseConditions(q.filter);
  const rows = (TABLE_ROWS[q.base] ?? []).filter((row) =>
    conditions.every(([column, value]) => row[column] === value),
  );
  const sortColumns = q.sort
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.replace(/^\\+/, ""));
  rows.sort((a, b) => {
    for (const column of sortColumns) {
      const order = (a[column] ?? "").localeCompare(b[column] ?? "");
      if (order !== 0) return order;
    }
    return 0;
  });
  const exprs = q.display.split(/\s+/).filter(Boolean);
  return rows.map((row) =>
    exprs.map((expr) =>
      expr.startsWith("$#")
        ? String(relatedCount(expr.slice(2), q.base, row))
        : (row[expr.slice(1)] ?? null),
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
      new Promise((resolve) => setTimeout(() => resolve(query(q)), delayMs)),
  );
}
