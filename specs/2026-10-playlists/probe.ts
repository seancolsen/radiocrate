// Probes the playlist query end to end without a browser or a running backend:
//
//   1. copies the sample collection's database to a scratch directory,
//   2. applies the playlist migration to the copy with the `duckdb` CLI and seeds
//      one playlist with a few tracks,
//   3. introspects the schema (the same SQL the app runs) and applies the app's
//      link inference,
//   4. compiles playlist queries with the vendored Querydown WASM, runs them
//      against the copy, and runs the vendored lineage WASM over the SQL.
//
// It fails (exit 1) when any query doesn't compile or run, or when the lineage
// analysis can't tell the track's `id` apart from the `playlist_track` `id`
// (see "Lineage of duplicate column names" in specs.md). Run from the repo root:
//
//   bun specs/2026-10-playlists/probe.ts [path/to/migration.sql]
//
// The migration defaults to `backend/src/migrations/0006.sql`. The playlist
// queries come from the app's own generator (`frontend/src/query/playlist.ts`),
// so this probes what the app actually sends.

import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import init, { compile } from "../../frontend/vendor/querydown-js/querydown_js.js";
import lineageInit, {
  column_sources,
} from "../../frontend/vendor/track-lineage/track_lineage.js";
import {
  DEFAULT_PRELUDE,
  playlistOrderContent,
} from "../../frontend/src/query/definition.ts";
import {
  assemblePlaylist,
  playlistQuerydown as generate,
} from "../../frontend/src/query/playlist.ts";
import { addInferredLinks } from "../../frontend/src/query/schema.ts";

const SAMPLE_DB = "sample-data/realistic/collection/radiocrate.db";
const migration = process.argv[2] ?? "backend/src/migrations/0006.sql";
const PLAYLIST = "00000000-0000-0000-0000-0000000000a1";

function duckdb(db: string, sql: string, json = false): string {
  const args = json ? ["-json", db] : [db];
  const run = Bun.spawnSync(["duckdb", ...args], { stdin: Buffer.from(sql) });
  if (run.exitCode !== 0) {
    throw new Error(`duckdb failed:\n${run.stderr.toString()}\n--- SQL ---\n${sql.slice(0, 2000)}`);
  }
  return run.stdout.toString();
}

/** The probe playlist's query, from already-resolved section text. */
function playlistQuerydown(
  filter: string,
  sort: string,
  display: string,
  options: { withFilter?: boolean } = {},
): string {
  return generate(PLAYLIST, { filter, sort, display }, options);
}

if (!existsSync(SAMPLE_DB)) {
  console.error(`No sample database at ${SAMPLE_DB} — see sample-data/README.`);
  process.exit(1);
}
if (!existsSync(migration)) {
  console.error(`No migration at ${migration}.`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "playlist-probe-"));
const db = join(dir, "probe.db");
copyFileSync(SAMPLE_DB, db);
duckdb(db, `begin;\n${readFileSync(migration, "utf8")}\ncommit;`);
duckdb(
  db,
  `insert into playlist values ('${PLAYLIST}', '{}');
   insert into source (id, name, created_at, modified_at, last_play, position, playlist)
   values (gen_random_uuid(), 'probe', now()::timestamp_s, now()::timestamp_s, now()::timestamp_s, 0, '${PLAYLIST}');
   insert into playlist_track
   select gen_random_uuid(), '${PLAYLIST}', id, row_number() over () from (select id from track limit 5);`,
);
const introspection = readFileSync("introspection/resources/duckdb.sql", "utf8");
const rawSchema = (JSON.parse(duckdb(db, introspection, true)) as { schema: string }[])[0].schema;
const schema = addInferredLinks(rawSchema);

await init({ module_or_path: readFileSync("frontend/vendor/querydown-js/querydown_js_bg.wasm") });
await lineageInit({
  module_or_path: readFileSync("frontend/vendor/track-lineage/track_lineage_bg.wasm"),
});

const DISPLAY = `$id @{hide:yes}
$artists @{width:[120 400]}
$title @{width:[100 400]}
$year @{width:35}
$rating.symbol @{width:20 align:center}`;

/** Each case's Querydown, and the number of hidden playlist columns it leads
 * with (the entry's `$id` and `$position`, or none for a plain track query). */
const cases: Record<string, { text: string; entryColumns: boolean }> = {
  "no conditions": { text: playlistQuerydown("", "", DISPLAY), entryColumns: true },
  "playlist order": {
    text: generate(
      PLAYLIST,
      assemblePlaylist(
        {
          filter: { custom: "", presets: [] },
          sort: playlistOrderContent(),
          display: { custom: DISPLAY },
        },
        [],
      ),
    ),
    entryColumns: true,
  },
  "filter + sort": {
    text: playlistQuerydown('artist:"a"\nyear:>1990', "\\\\artists\n\\\\year \\d", DISPLAY),
    entryColumns: true,
  },
  "commit sort (filter left out)": {
    text: playlistQuerydown('artist:"a"', "\\\\artists", DISPLAY, { withFilter: false }),
    entryColumns: true,
  },
  "OR filter": {
    text: playlistQuerydown('[\n  title:"a"\n  title:"b"\n]', "", DISPLAY),
    entryColumns: true,
  },
  shuffle: {
    text: playlistQuerydown("", "\\\\id|concat('seed')|md5", DISPLAY),
    entryColumns: true,
  },
  "empty display": { text: playlistQuerydown("", "", ""), entryColumns: true },
  // Not a playlist: the same duplicate-name bug hit a track query that shows
  // both its own id and its album's.
  "track query with $album.id": {
    text: "#track\n$id\n$album.id\n$title",
    entryColumns: false,
  },
};

let failed = false;
for (const [name, { text, entryColumns }] of Object.entries(cases)) {
  try {
    const { sql } = compile(schema, "duckdb", `${DEFAULT_PRELUDE}\n${text}`);
    const rows = (JSON.parse(duckdb(db, sql, true) || "[]") as unknown[]).length;
    const sources = JSON.parse(column_sources(sql) ?? "null") as [string, string][][] | null;
    const traces = (i: number, table: string, column: string) =>
      sources?.[i]?.some(([t, c]) => t === table && c === column) ?? false;
    const trackIdCols = (sources ?? []).flatMap((_, i) => (traces(i, "track", "id") ? [i] : []));
    const lineageOk =
      (!entryColumns ||
        (traces(0, "playlist_track", "id") && traces(1, "playlist_track", "position"))) &&
      (name === "empty display" ? trackIdCols.length === 0 : trackIdCols.length === 1);
    if (!lineageOk) failed = true;
    console.log(
      `${lineageOk ? "ok  " : "FAIL"} ${name}: ${rows} rows; track.id in columns [${trackIdCols}]; ` +
        `lineage ${JSON.stringify(sources)}`,
    );
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name}: ${String(err).slice(0, 500)}`);
  }
}
process.exit(failed ? 1 : 0);
