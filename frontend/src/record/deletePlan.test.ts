import type { DmlOperation } from "api-client";
import { describe, expect, it } from "vitest";
import type { RecordKey } from "../query/recordForm";
import {
  dmlTable,
  type SchemaRelationship,
  type SchemaTable,
} from "../query/schema";
import {
  createDeletePlanner,
  NO_CHOICES,
  planQuerySql,
  relationshipsAmong,
  type DeleteChoices,
  type DeletePlan,
  type PlanQuery,
  type RowLoader,
} from "./deletePlan";

// A database held in memory, answering the planner's questions and taking its
// operations the way the DML API does: a delete that would leave a reference
// dangling is refused. So a plan that applies cleanly is one the API accepts.

type Cell = string | null;
type Rows = Record<string, Cell>[];
type Db = Record<string, Rows>;

function table(
  name: string,
  key: string[],
  columns: Record<string, "required" | "nullable">,
): SchemaTable {
  return {
    name,
    columns: Object.entries(columns).map(([column, kind]) => ({
      name: column,
      type: "UUID",
      nullable: kind === "nullable",
    })),
    uniqueConstraints: key.length > 0 ? [key] : [],
  };
}

function link(from: string, to: string, toColumn = "id"): SchemaRelationship {
  const dot = from.lastIndexOf(".");
  return {
    fromTable: from.slice(0, dot),
    fromColumn: from.slice(dot + 1),
    toTable: to,
    toColumn,
  };
}

// The app's music tables, as far as their keys and links go, with the
// playlist's in their own schema; and tables of the user's own: a `venue`
// keyed by a `code`, a `gig` at one, a `bill` shared by two, and a `note`
// about a track that nothing identifies.
const TABLES: SchemaTable[] = [
  table("track", ["id"], {
    id: "required",
    file: "required",
    album: "nullable",
    rating: "nullable",
  }),
  table("album", ["id"], { id: "required" }),
  table("file", ["id"], { id: "required" }),
  table("rating", ["id"], { id: "required" }),
  table("artist", ["id"], { id: "required" }),
  table("credit", ["track", "artist"], {
    track: "required",
    artist: "required",
  }),
  table("play", ["track", "timestamp"], {
    track: "required",
    timestamp: "required",
  }),
  table("/app/playlist", ["id"], { id: "required" }),
  table("/app/playlist_track", ["id"], {
    id: "required",
    playlist: "required",
    track: "required",
  }),
  table("folder", ["id"], { id: "required", parent: "nullable" }),
  table("venue", ["code"], { code: "required" }),
  table("gig", ["id"], { id: "required", venue: "nullable" }),
  table("bill", ["id"], {
    id: "required",
    first: "nullable",
    second: "nullable",
  }),
  table("note", [], { track: "required" }),
];

const LINKS: SchemaRelationship[] = [
  link("track.file", "file"),
  link("track.album", "album"),
  link("track.rating", "rating"),
  link("credit.track", "track"),
  link("credit.artist", "artist"),
  link("play.track", "track"),
  link("/app/playlist_track.playlist", "/app/playlist"),
  link("/app/playlist_track.track", "track"),
  link("folder.parent", "folder"),
  link("gig.venue", "venue", "code"),
  link("bill.first", "venue", "code"),
  link("bill.second", "venue", "code"),
  link("note.track", "track"),
];

const RELATIONSHIPS = relationshipsAmong(TABLES, LINKS);

/** Two albums: `a1` holds `t1` and `t2`, `a2` holds `t3`. Each track has its
 * own file; all are rated `r1`. `t1` is credited to `x1` and `x2`, `t2` and
 * `t3` to `x1`; `t1` has two plays and is on playlist `p1`. */
function library(): Db {
  return {
    track: [
      { id: "t1", file: "f1", album: "a1", rating: "r1" },
      { id: "t2", file: "f2", album: "a1", rating: "r1" },
      { id: "t3", file: "f3", album: "a2", rating: "r1" },
    ],
    album: [{ id: "a1" }, { id: "a2" }],
    file: [{ id: "f1" }, { id: "f2" }, { id: "f3" }],
    rating: [{ id: "r1" }, { id: "r2" }],
    artist: [{ id: "x1" }, { id: "x2" }],
    credit: [
      { track: "t1", artist: "x1" },
      { track: "t1", artist: "x2" },
      { track: "t2", artist: "x1" },
      { track: "t3", artist: "x1" },
    ],
    play: [
      { track: "t1", timestamp: "2026-01-01 10:00:00" },
      { track: "t1", timestamp: "2026-01-02 10:00:00" },
    ],
    "/app/playlist": [{ id: "p1" }],
    "/app/playlist_track": [{ id: "e1", playlist: "p1", track: "t1" }],
    folder: [],
    venue: [],
    gig: [],
    bill: [],
    note: [],
  };
}

/** Answers the planner from `db`, noting each question in `asked`. */
function loaderFor(db: Db, asked: PlanQuery[] = []): RowLoader {
  return (query) => {
    asked.push(query);
    const rows = db[query.table] ?? [];
    if (query.kind === "counts") {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const value = row[query.column];
        if (value != null && query.values.includes(value)) {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }
      return Promise.resolve(
        [...counts].map(([value, count]) => [value, String(count)]),
      );
    }
    const where = query.where;
    const matches = (row: Record<string, Cell>) =>
      "keys" in where
        ? where.keys.some((key) =>
            key.every((part) => row[part.column] === part.value),
          )
        : where.values.includes(row[where.column] ?? "\0");
    return Promise.resolve(
      rows
        .filter(matches)
        .map((row) => query.columns.map((column) => row[column] ?? null)),
    );
  };
}

const tableOf = (op: DmlOperation): string =>
  op.schema === undefined ? op.table : `/${op.schema}/${op.table}`;

/** Runs `operations` on `db` as the API would: in order, refusing a delete
 * that a record still refers to, and a write that matches no record. */
function apply(db: Db, operations: readonly DmlOperation[]): void {
  for (const op of operations) {
    if (op.operation === "insert")
      throw new Error("A deletion inserts nothing");
    const name = tableOf(op);
    const rows = db[name]!;
    const index = rows.findIndex((row) =>
      Object.entries(op.where).every(
        ([column, value]) => row[column] === value,
      ),
    );
    if (index === -1) throw new Error(`${op.id} matches no row of ${name}`);
    if (op.operation === "update") {
      Object.assign(rows[index]!, op.values);
      continue;
    }
    const doomed = rows[index]!;
    for (const rel of RELATIONSHIPS) {
      if (rel.toTable !== name) continue;
      const dangling = db[rel.fromTable]!.some(
        (row) =>
          row !== doomed &&
          row[rel.fromColumn] != null &&
          row[rel.fromColumn] === doomed[rel.toColumn],
      );
      // A record that refers to itself dangles too, as the API sees it.
      const self =
        rel.fromTable === name &&
        doomed[rel.fromColumn] != null &&
        doomed[rel.fromColumn] === doomed[rel.toColumn];
      if (dangling || self) {
        throw new Error(
          `${op.id} leaves ${rel.fromTable}.${rel.fromColumn} dangling`,
        );
      }
    }
    rows.splice(index, 1);
  }
}

const ids = (table: string, ...values: string[]): RecordKey[] =>
  values.map((value) => [{ column: "id", value }]);

const choose = (choices: Partial<DeleteChoices>): DeleteChoices => ({
  ...NO_CHOICES,
  ...choices,
});

async function planOn(
  db: Db,
  table: string,
  keys: RecordKey[],
  choices: DeleteChoices = NO_CHOICES,
): Promise<DeletePlan> {
  return createDeletePlanner(TABLES, LINKS, loaderFor(db)).plan(
    table,
    keys,
    choices,
  );
}

/** A plan's lines, as "kind relationship: count" with a mark for what's
 * deleted (`x`), kept (`-`) and deleted without a choice (`!`). */
const lines = (plan: DeletePlan): string[] =>
  plan.summary.items.map(
    (item) =>
      `${item.required ? "!" : item.checked ? "x" : "-"} ${item.kind} ${
        item.relationship.fromTable
      }.${item.relationship.fromColumn}: ${item.count} ${item.table}`,
  );

const idsOf = (rows: Rows): Cell[] => rows.map((row) => row["id"] ?? null);

describe("deleting a track", () => {
  it("takes everything that can't be without it, and nothing else", async () => {
    const db = library();
    const plan = await planOn(db, "track", ids("track", "t1"));
    expect(lines(plan)).toEqual([
      "! referencing credit.track: 2 credit",
      "! referencing play.track: 2 play",
      "! referencing /app/playlist_track.track: 1 /app/playlist_track",
      "- orphans track.file: 1 file",
      "- orphans credit.artist: 1 artist",
      "- orphans /app/playlist_track.playlist: 1 /app/playlist",
    ]);
    expect(plan.summary).toMatchObject({
      found: 1,
      deleteCount: 6,
      deletedByTable: {
        track: 1,
        credit: 2,
        play: 2,
        "/app/playlist_track": 1,
      },
      updateCount: 0,
      blocked: [],
    });
    apply(db, plan.operations);
    expect(idsOf(db["track"]!)).toEqual(["t2", "t3"]);
    expect(db["credit"]).toEqual([
      { track: "t2", artist: "x1" },
      { track: "t3", artist: "x1" },
    ]);
    expect(db["play"]).toEqual([]);
    expect(db["/app/playlist_track"]).toEqual([]);
    // What it leaves with nothing referring to it stays, unless asked.
    expect(idsOf(db["file"]!)).toEqual(["f1", "f2", "f3"]);
    expect(idsOf(db["artist"]!)).toEqual(["x1", "x2"]);
    expect(idsOf(db["/app/playlist"]!)).toEqual(["p1"]);
  });

  it("names another schema's table in its operations", async () => {
    const plan = await planOn(library(), "track", ids("track", "t1"));
    expect(plan.operations).toContainEqual({
      operation: "delete",
      id: expect.any(String) as string,
      ...dmlTable("/app/playlist_track"),
      where: { id: "e1" },
    });
  });

  it("deletes the file it leaves orphaned, when that's chosen", async () => {
    const db = library();
    const plan = await planOn(
      db,
      "track",
      ids("track", "t1"),
      choose({ orphans: { "track.file>file": true } }),
    );
    expect(lines(plan)).toContain("x orphans track.file: 1 file");
    apply(db, plan.operations);
    expect(idsOf(db["file"]!)).toEqual(["f2", "f3"]);
    expect(plan.deleted.get("file")).toEqual(ids("file", "f1"));
    expect(plan.summary.deletedByTable["file"]).toBe(1);
  });

  it("offers no album while another track is on it", async () => {
    const plan = await planOn(library(), "track", ids("track", "t1"));
    expect(lines(plan).join()).not.toContain("track.album");
  });

  it("offers the album once every track on it is going", async () => {
    const db = library();
    const choices = choose({ orphans: { "track.album>album": true } });
    const plan = await planOn(db, "track", ids("track", "t1", "t2"), choices);
    expect(lines(plan)).toContain("x orphans track.album: 1 album");
    apply(db, plan.operations);
    expect(idsOf(db["album"]!)).toEqual(["a2"]);
  });

  it("asks about two orphaned albums once", async () => {
    const plan = await planOn(
      library(),
      "track",
      ids("track", "t1", "t2", "t3"),
    );
    expect(lines(plan).filter((line) => line.includes("track.album"))).toEqual([
      "- orphans track.album: 2 album",
    ]);
    // The rating they all had is left with no track too.
    expect(lines(plan)).toContain("- orphans track.rating: 1 rating");
  });

  it("follows an orphan's own relationships", async () => {
    // With `x2`'s only credit gone, deleting `x2` is all that's left to do for
    // it; but the playlist `p1`, deleted as an orphan, could have had entries.
    const db = library();
    db["/app/playlist_track"]!.push({ id: "e2", playlist: "p1", track: "t1" });
    const plan = await planOn(
      db,
      "track",
      ids("track", "t1"),
      choose({
        orphans: {
          "credit.artist>artist": true,
          "/app/playlist_track.playlist>/app/playlist": true,
        },
      }),
    );
    apply(db, plan.operations);
    expect(idsOf(db["artist"]!)).toEqual(["x1"]);
    expect(db["/app/playlist"]).toEqual([]);
  });

  it("finds nothing to do for a record that's already gone", async () => {
    const plan = await planOn(library(), "track", ids("track", "nope"));
    expect(plan.summary).toMatchObject({ found: 0, deleteCount: 0, items: [] });
    expect(plan.operations).toEqual([]);
  });
});

describe("deleting an album", () => {
  it("keeps its tracks by default, with no album", async () => {
    const db = library();
    const plan = await planOn(db, "album", ids("album", "a1"));
    expect(lines(plan)).toEqual(["- referencing track.album: 2 track"]);
    expect(plan.summary).toMatchObject({ deleteCount: 1, updateCount: 2 });
    expect(plan.operations.map((op) => op.operation)).toEqual([
      "update",
      "update",
      "delete",
    ]);
    apply(db, plan.operations);
    expect(db["track"]!.map((t) => [t["id"], t["album"]])).toEqual([
      ["t1", null],
      ["t2", null],
      ["t3", "a2"],
    ]);
    expect(idsOf(db["album"]!)).toEqual(["a2"]);
  });

  it("deletes its tracks when that's chosen, and all that hangs off them", async () => {
    const db = library();
    const plan = await planOn(
      db,
      "album",
      ids("album", "a1"),
      choose({ referencing: { "track.album>album": true } }),
    );
    expect(lines(plan)).toEqual([
      "x referencing track.album: 2 track",
      "! referencing credit.track: 3 credit",
      "! referencing play.track: 2 play",
      "! referencing /app/playlist_track.track: 1 /app/playlist_track",
      "- orphans track.file: 2 file",
      "- orphans credit.artist: 1 artist",
      "- orphans /app/playlist_track.playlist: 1 /app/playlist",
    ]);
    apply(db, plan.operations);
    expect(idsOf(db["track"]!)).toEqual(["t3"]);
    expect(idsOf(db["album"]!)).toEqual(["a2"]);
  });
});

describe("deleting a rating", () => {
  it("empties the rating of every track that has it", async () => {
    const db = library();
    const plan = await planOn(db, "rating", ids("rating", "r1"));
    expect(lines(plan)).toEqual(["- referencing track.rating: 3 track"]);
    apply(db, plan.operations);
    expect(db["track"]!.map((t) => t["rating"])).toEqual([null, null, null]);
    expect(idsOf(db["rating"]!)).toEqual(["r2"]);
  });

  it("empties two columns of one record in one update", async () => {
    // A double bill has the one venue as both its venues.
    const db = library();
    db["venue"] = [{ code: "ROXY" }];
    db["bill"] = [{ id: "b1", first: "ROXY", second: "ROXY" }];
    const plan = await planOn(db, "venue", [
      [{ column: "code", value: "ROXY" }],
    ]);
    expect(lines(plan)).toEqual([
      "- referencing bill.first: 1 bill",
      "- referencing bill.second: 1 bill",
    ]);
    expect(plan.operations).toEqual([
      {
        operation: "update",
        id: "u0",
        table: "bill",
        where: { id: "b1" },
        values: { first: null, second: null },
      },
      {
        operation: "delete",
        id: "d1",
        table: "venue",
        where: { code: "ROXY" },
      },
    ]);
    expect(plan.summary).toMatchObject({ deleteCount: 1, updateCount: 1 });
  });
});

describe("tables of the user's own", () => {
  it("follows a relationship to a key that isn't called id", async () => {
    const db = library();
    db["venue"] = [{ code: "ROXY" }, { code: "APOLLO" }];
    db["gig"] = [
      { id: "g1", venue: "ROXY" },
      { id: "g2", venue: "ROXY" },
      { id: "g3", venue: "APOLLO" },
    ];
    const venue: RecordKey[] = [[{ column: "code", value: "ROXY" }]];
    const kept = await planOn(db, "venue", venue);
    expect(lines(kept)).toEqual(["- referencing gig.venue: 2 gig"]);
    const plan = await planOn(
      db,
      "venue",
      venue,
      choose({ referencing: { "gig.venue>venue": true } }),
    );
    apply(db, plan.operations);
    expect(idsOf(db["gig"]!)).toEqual(["g3"]);
    expect(db["venue"]).toEqual([{ code: "APOLLO" }]);
  });

  it("offers a venue left with no gigs", async () => {
    const db = library();
    db["venue"] = [{ code: "ROXY" }];
    db["gig"] = [{ id: "g1", venue: "ROXY" }];
    const plan = await planOn(
      db,
      "gig",
      ids("gig", "g1"),
      choose({ orphans: { "gig.venue>venue": true } }),
    );
    expect(lines(plan)).toEqual(["x orphans gig.venue: 1 venue"]);
    apply(db, plan.operations);
    expect(db["venue"]).toEqual([]);
  });

  it("can't go ahead past records that nothing identifies", async () => {
    const db = library();
    db["note"] = [{ track: "t2" }, { track: "t2" }];
    const plan = await planOn(db, "track", ids("track", "t2"));
    expect(plan.summary.blocked).toMatchObject([
      { relationship: { fromTable: "note", fromColumn: "track" }, count: 2 },
    ]);
  });

  it("refuses a table that nothing identifies a record of", async () => {
    await expect(planOn(library(), "note", [])).rejects.toThrow(/note/);
  });
});

describe("a table that refers to itself", () => {
  const folders = (): Db => ({
    ...library(),
    folder: [
      { id: "top", parent: null },
      { id: "mid", parent: "top" },
      { id: "low", parent: "mid" },
    ],
  });

  it("moves the folders inside a deleted one out, by default", async () => {
    const db = folders();
    const plan = await planOn(db, "folder", ids("folder", "top"));
    expect(lines(plan)).toEqual(["- referencing folder.parent: 1 folder"]);
    apply(db, plan.operations);
    expect(db["folder"]).toEqual([
      { id: "mid", parent: null },
      { id: "low", parent: "mid" },
    ]);
  });

  it("deletes them all, innermost first, when that's chosen", async () => {
    const db = folders();
    const plan = await planOn(
      db,
      "folder",
      ids("folder", "top"),
      choose({ referencing: { "folder.parent>folder": true } }),
    );
    expect(lines(plan)).toEqual(["x referencing folder.parent: 2 folder"]);
    expect(
      plan.operations.map((op) => ("where" in op ? op.where["id"] : undefined)),
    ).toEqual(["low", "mid", "top"]);
    apply(db, plan.operations);
    expect(db["folder"]).toEqual([]);
  });

  it("empties what closes a ring before deleting it", async () => {
    const db = folders();
    db["folder"] = [
      { id: "a", parent: "b" },
      { id: "b", parent: "a" },
      { id: "self", parent: "self" },
    ];
    const plan = await planOn(db, "folder", ids("folder", "a", "b", "self"));
    apply(db, plan.operations);
    expect(db["folder"]).toEqual([]);
  });
});

describe("planning again", () => {
  it("asks only for what another choice newly reaches", async () => {
    const asked: PlanQuery[] = [];
    const planner = createDeletePlanner(
      TABLES,
      LINKS,
      loaderFor(library(), asked),
    );
    const keys = ids("album", "a1");
    await planner.plan("album", keys, NO_CHOICES);
    // The same plan again asks only for the album itself, to see it's there.
    const before = asked.length;
    await planner.plan("album", keys, NO_CHOICES);
    expect(asked.slice(before).map((q) => `${q.kind} ${q.table}`)).toEqual([
      "rows album",
    ]);
    const first = asked.length;
    await planner.plan(
      "album",
      keys,
      choose({ referencing: { "track.album>album": true } }),
    );
    // The album's tracks were loaded the first time. What's new is what hangs
    // off them, and what they'd leave orphaned.
    const again = asked.slice(first);
    expect(again.map((q) => `${q.kind} ${q.table}`)).toEqual([
      "rows album",
      "rows credit",
      "rows play",
      "rows /app/playlist_track",
      "rows note",
      "counts track",
      "counts track",
      "counts credit",
      "counts /app/playlist_track",
    ]);
  });

  it("asks for many records in several queries", async () => {
    const db = library();
    db["track"] = Array.from({ length: 2500 }, (_, i) => ({
      id: `t${i}`,
      file: `f${i}`,
      album: null,
      rating: "r1",
    }));
    db["credit"] = [];
    db["play"] = [];
    db["/app/playlist_track"] = [];
    const asked: PlanQuery[] = [];
    const planner = createDeletePlanner(TABLES, LINKS, loaderFor(db, asked));
    const plan = await planner.plan("rating", ids("rating", "r1"), {
      ...NO_CHOICES,
      referencing: { "track.rating>rating": true },
    });
    expect(plan.summary.deleteCount).toBe(2501);
    const credits = asked.filter(
      (q) => q.kind === "rows" && q.table === "credit",
    );
    expect(credits).toHaveLength(3);
    apply(db, plan.operations);
    expect(db["track"]).toEqual([]);
  });
});

describe("planQuerySql", () => {
  it("reads every column as text, by a list of values", () => {
    expect(
      planQuerySql({
        kind: "rows",
        table: "track",
        columns: ["id", "album"],
        where: { column: "album", values: ["a1", "it's"] },
      }),
    ).toBe(
      `SELECT "id"::text AS c0, "album"::text AS c1 FROM "main"."track" ` +
        `WHERE "album" IN ('a1', 'it''s')`,
    );
  });

  it("matches composite keys one by one, in another schema", () => {
    expect(
      planQuerySql({
        kind: "rows",
        table: "/app/playlist_track",
        columns: ["id"],
        where: {
          keys: [
            [
              { column: "playlist", value: "p1" },
              { column: "track", value: "t1" },
            ],
            [
              { column: "playlist", value: "p1" },
              { column: "track", value: "t2" },
            ],
          ],
        },
      }),
    ).toBe(
      `SELECT "id"::text AS c0 FROM "app"."playlist_track" ` +
        `WHERE ("playlist" = 'p1' AND "track" = 't1') OR ("playlist" = 'p1' AND "track" = 't2')`,
    );
  });

  it("counts the records holding each value", () => {
    expect(
      planQuerySql({
        kind: "counts",
        table: "track",
        column: "file",
        values: ["f1"],
      }),
    ).toBe(
      `SELECT "file"::text AS c0, count(*)::text AS c1 FROM "main"."track" ` +
        `WHERE "file" IN ('f1') GROUP BY "file"`,
    );
  });
});
