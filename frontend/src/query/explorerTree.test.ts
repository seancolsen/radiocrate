import { describe, expect, it } from "vitest";
import type { Query, QueryFolder } from "api-client";
import {
  applyPlacements,
  buildTree,
  dissolvePlacements,
  dropBetween,
  dropInto,
  gapDepths,
  movePlacements,
  storedPositions,
  subtreeIds,
  topPosition,
  visibleRows,
  type TreeNode,
  type TreeRow,
} from "./explorerTree";

function query(id: string, parent: string | null, position: number): Query {
  return {
    id,
    name: id,
    createdAt: 0,
    modifiedAt: 0,
    lastPlay: 0,
    definition: "{}",
    parent,
    position,
  };
}

function folder(
  id: string,
  parent: string | null,
  position: number,
): QueryFolder {
  return { id, name: id, parent, position };
}

// top level:  q1, F (q2, G (q3)), q4
const QUERIES = [
  query("q1", null, 0),
  query("q2", "F", 0),
  query("q3", "G", 0),
  query("q4", null, 2),
];
const FOLDERS = [folder("F", null, 1), folder("G", "F", 1)];

/** A tree as nested ids, for compact assertions. */
function shape(nodes: readonly TreeNode[]): unknown[] {
  return nodes.map((n) =>
    n.kind === "folder" ? { [n.id]: shape(n.children) } : n.id,
  );
}

const ids = (rows: readonly TreeRow[]) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.node.id}`);

describe("buildTree", () => {
  it("nests items under their folders in position order", () => {
    expect(shape(buildTree(QUERIES, FOLDERS))).toEqual([
      "q1",
      { F: ["q2", { G: ["q3"] }] },
      "q4",
    ]);
  });

  it("puts an item whose parent is missing at the top level", () => {
    expect(shape(buildTree([query("q", "gone", 0)], []))).toEqual(["q"]);
  });

  it("lifts folders caught in a parent cycle to the top level", () => {
    const tree = buildTree(
      [query("q", "A", 0)],
      [folder("A", "B", 0), folder("B", "A", 0)],
    );
    expect(shape(tree)).toEqual([{ A: [{ B: [] }, "q"] }]);
  });
});

describe("visibleRows", () => {
  const tree = buildTree(QUERIES, FOLDERS);

  it("hides the children of collapsed folders", () => {
    expect(ids(visibleRows(tree, new Set(), ""))).toEqual(["q1", "F", "q4"]);
    expect(ids(visibleRows(tree, new Set(["F"]), ""))).toEqual([
      "q1",
      "F",
      "  q2",
      "  G",
      "q4",
    ]);
  });

  it("filters to matches and the folders above them, all expanded", () => {
    expect(ids(visibleRows(tree, new Set(), "Q3"))).toEqual([
      "F",
      "  G",
      "    q3",
    ]);
  });

  it("shows everything inside a folder whose name matches", () => {
    expect(ids(visibleRows(tree, new Set(), "g"))).toEqual([
      "F",
      "  G",
      "    q3",
    ]);
  });
});

describe("drop targets", () => {
  const tree = buildTree(QUERIES, FOLDERS);
  // q1, F, ··q2, ··G, ····q3, q4
  const rows = visibleRows(tree, new Set(["F", "G"]), "");
  const none = new Set<string>();

  it("offers every depth from the row below out to inside the row above", () => {
    // Between q3 (depth 2, in G) and q4 (depth 0).
    expect(gapDepths(rows, 5)).toEqual({ min: 0, max: 2 });
    // Between F and its first child: inside F only.
    expect(gapDepths(rows, 2)).toEqual({ min: 1, max: 1 });
    // Above everything, and below everything.
    expect(gapDepths(rows, 0)).toEqual({ min: 0, max: 0 });
    expect(gapDepths(rows, 6)).toEqual({ min: 0, max: 0 });
  });

  it("resolves a gap and depth to a parent and a preceding sibling", () => {
    expect(dropBetween(rows, 5, 2, none)).toMatchObject({
      parent: "G",
      after: "q3",
    });
    expect(dropBetween(rows, 5, 1, none)).toMatchObject({
      parent: "F",
      after: "G",
    });
    expect(dropBetween(rows, 5, 0, none)).toMatchObject({
      parent: null,
      after: "F",
    });
    expect(dropBetween(rows, 2, 5, none)).toMatchObject({
      parent: "F",
      after: null,
      depth: 1,
    });
    expect(dropBetween(rows, 0, 0, none)).toMatchObject({
      parent: null,
      after: null,
    });
  });

  it("refuses to drop a folder inside itself", () => {
    const blocked = subtreeIds(tree, { kind: "folder", id: "F" });
    expect(dropBetween(rows, 5, 2, blocked)).toBeNull();
    expect(dropBetween(rows, 5, 0, blocked)).not.toBeNull();
    expect(dropInto("G", blocked)).toBeNull();
    expect(dropInto("F", blocked)).toBeNull();
  });
});

describe("movePlacements", () => {
  const tree = buildTree(QUERIES, FOLDERS);
  const positions = storedPositions(QUERIES, FOLDERS);

  it("reorders within a parent, writing only what changed", () => {
    const placements = movePlacements(
      tree,
      positions,
      { kind: "query", id: "q4" },
      { kind: "between", parent: null, after: null, depth: 0, gap: 0 },
    );
    expect(placements).toEqual([
      { kind: "query", id: "q4", parent: null, position: 0 },
      { kind: "query", id: "q1", parent: null, position: 1 },
      { kind: "folder", id: "F", parent: null, position: 2 },
    ]);
  });

  it("moves into a folder, at the end of its children", () => {
    const placements = movePlacements(
      tree,
      positions,
      { kind: "query", id: "q1" },
      { kind: "into", folder: "G" },
    );
    const moved = applyPlacements(QUERIES, FOLDERS, placements);
    expect(shape(buildTree(moved.queries, moved.folders))).toEqual([
      { F: ["q2", { G: ["q3", "q1"] }] },
      "q4",
    ]);
  });

  it("moves out of a folder", () => {
    const placements = movePlacements(
      tree,
      positions,
      { kind: "query", id: "q3" },
      { kind: "between", parent: null, after: "F", depth: 0, gap: 5 },
    );
    const moved = applyPlacements(QUERIES, FOLDERS, placements);
    expect(shape(buildTree(moved.queries, moved.folders))).toEqual([
      "q1",
      { F: ["q2", { G: [] }] },
      "q3",
      "q4",
    ]);
  });

  it("is empty for a drop that changes nothing", () => {
    expect(
      movePlacements(
        tree,
        positions,
        { kind: "query", id: "q1" },
        { kind: "between", parent: null, after: "q1", depth: 0, gap: 1 },
      ),
    ).toEqual([]);
    expect(
      movePlacements(
        tree,
        positions,
        { kind: "query", id: "q4" },
        { kind: "between", parent: null, after: "F", depth: 0, gap: 5 },
      ),
    ).toEqual([]);
  });

  it("never moves a folder inside itself", () => {
    expect(
      movePlacements(
        tree,
        positions,
        { kind: "folder", id: "F" },
        { kind: "into", folder: "G" },
      ),
    ).toEqual([]);
  });
});

describe("dissolvePlacements", () => {
  it("puts a folder's children in its place", () => {
    const tree = buildTree(QUERIES, FOLDERS);
    const placements = dissolvePlacements(
      tree,
      storedPositions(QUERIES, FOLDERS),
      "F",
    );
    const moved = applyPlacements(QUERIES, FOLDERS, placements);
    const remaining = moved.folders.filter((f) => f.id !== "F");
    expect(shape(buildTree(moved.queries, remaining))).toEqual([
      "q1",
      "q2",
      { G: ["q3"] },
      "q4",
    ]);
  });
});

describe("topPosition", () => {
  it("sits above the first top-level item", () => {
    expect(topPosition(QUERIES, FOLDERS)).toBe(-1);
    expect(topPosition([], [])).toBe(0);
  });
});
