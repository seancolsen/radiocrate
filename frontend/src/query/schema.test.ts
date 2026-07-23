import { describe, expect, it } from "vitest";
import { addInferredLinks } from "./schema";

// Mirrors the Rust tests for `add_inferred_links` (`introspection/src/lib.rs`),
// guarding this TS port against drift from the shared crate. `SAMPLE` is the
// same fixture.
const SAMPLE = `{
  "tables": [
    { "name": "track", "unique_constraints": [["id"]], "columns": [
      { "name": "id", "type": "UUID", "nullable": false },
      { "name": "title", "type": "VARCHAR", "nullable": true },
      { "name": "album", "type": "UUID", "nullable": true }
    ] },
    { "name": "album", "unique_constraints": [["id"]], "columns": [
      { "name": "id", "type": "UUID", "nullable": false }
    ] },
    { "name": "credit", "unique_constraints": [["track", "artist"]], "columns": [
      { "name": "track", "type": "UUID", "nullable": false },
      { "name": "artist", "type": "UUID", "nullable": false },
      { "name": "ord", "type": "FLOAT", "nullable": true }
    ] }
  ],
  "links": []
}`;

interface Link {
  from: { table: string; column: string };
  to: { table: string; column: string };
  unique: boolean;
}
const linksOf = (json: string): Link[] =>
  (JSON.parse(json) as { links: Link[] }).links;

describe("addInferredLinks", () => {
  it("infers a link from a UUID column matching a table name", () => {
    const links = linksOf(addInferredLinks(SAMPLE));
    // track.album -> album.id, credit.track -> track.id
    // (credit.artist has no `artist` table here).
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({
      from: { table: "track", column: "album" },
      to: { table: "album", column: "id" },
      unique: false,
    });
    expect(
      links.some(
        (l) =>
          l.from.table === "credit" &&
          l.from.column === "track" &&
          l.to.table === "track",
      ),
    ).toBe(true);
  });

  it("ignores non-UUID and non-matching columns", () => {
    const input = `{ "tables": [
      { "name": "track", "columns": [
        { "name": "id", "type": "UUID" },
        { "name": "title", "type": "VARCHAR" },
        { "name": "track", "type": "VARCHAR" }
      ] }
    ], "links": [] }`;
    expect(linksOf(addInferredLinks(input))).toHaveLength(0);
  });

  it("matches UUID case-insensitively", () => {
    const input = `{ "tables": [
      { "name": "album", "columns": [{ "name": "id", "type": "uuid" }] },
      { "name": "track", "columns": [{ "name": "album", "type": "uuid" }] }
    ], "links": [] }`;
    const links = linksOf(addInferredLinks(input));
    expect(links).toHaveLength(1);
    expect(links[0].from).toEqual({ table: "track", column: "album" });
  });

  it("preserves other fields and overwrites links", () => {
    const input = `{ "tables": [], "links": [{ "stale": true }], "extra": 1 }`;
    const out = JSON.parse(addInferredLinks(input)) as {
      links: unknown[];
      extra: number;
    };
    expect(out.links).toHaveLength(0);
    expect(out.extra).toBe(1);
  });

  it("throws on JSON without tables", () => {
    expect(() => addInferredLinks(`{ "nope": 1 }`)).toThrow();
  });
});
